const { QueryTypes } = require('sequelize');
const { EVENTS_BY_KEY } = require('../../../../shared/src/notificationEvents');
const { columnsOf, isPostgres, q } = require('../../../../shared/src/dialect');

/**
 * Moves notification_configs from role-based to permission-based recipients.
 *
 * The first shape of this table had notify_client / notify_realtor /
 * notify_admin, where notify_admin meant "every admin in the company". That is
 * too blunt: the people who should hear that a payment needs reviewing are the
 * ones who can approve it, which is a permission, not a job title — and a
 * company may well want a branch manager or a custom collections role told
 * instead.
 *
 * So notify_client becomes notify_subject, and notify_admin becomes a list of
 * permission names taken from the event catalogue's defaults. Runs before sync,
 * because sync would otherwise add notify_subject alongside a notify_client it
 * knows nothing about and the old value would be lost.
 *
 * Idempotent: each step checks the column it is about to touch.
 */
/**
 * The table's current columns, or null when there is no such table.
 *
 * Reads information_schema through columnsOf rather than SHOW COLUMNS. SHOW is
 * MySQL-only, so on Postgres it threw — and the catch here read that as "the
 * table does not exist", which returned null and skipped the whole migration
 * in silence. A fresh Postgres database was fine by luck (sync builds the new
 * shape anyway); one already carrying the OLD shape would never have been
 * migrated, and nothing would have said so.
 *
 * That is precisely the failure columnsOf documents itself as existing to
 * prevent, so this now uses it instead of keeping a second, worse copy.
 */
const columns = async (sequelize) => {
  const found = await columnsOf(sequelize, 'notification_configs');
  return found ? new Set(found.keys()) : null;
};

module.exports = async (sequelize) => {
  const present = await columns(sequelize);
  if (!present) return;

  if (present.has('notify_client') && !present.has('notify_subject')) {
    /*
     * Rename rather than add-and-copy, so the values survive in one statement.
     *
     * CHANGE COLUMN is MySQL's spelling and carries the type with it; Postgres
     * renames without one, and has no TINYINT(1) to restate anyway — the column
     * is already boolean there.
     */
    await sequelize.query(isPostgres(sequelize)
      ? `ALTER TABLE notification_configs RENAME COLUMN ${q(sequelize, 'notify_client')} TO ${q(sequelize, 'notify_subject')}`
      : 'ALTER TABLE notification_configs CHANGE COLUMN notify_client notify_subject TINYINT(1) DEFAULT 0');
    console.log('[notify-config] notify_client -> notify_subject');
  }

  if (!present.has('notify_permissions')) {
    // JSON is spelled the same on both, but Postgres wants JSONB for anything
    // it might later index or query into.
    await sequelize.query(`ALTER TABLE notification_configs ADD COLUMN notify_permissions ${
      isPostgres(sequelize) ? 'JSONB' : 'JSON'} NULL`);
  }

  // Translate the old admin broadcast into the catalogue's permission defaults.
  if (present.has('notify_admin')) {
    const rows = await sequelize.query(
      'SELECT id, event_key, notify_admin FROM notification_configs',
      { type: QueryTypes.SELECT },
    );
    for (const row of rows) {
      const catalogue = EVENTS_BY_KEY.get(row.event_key);
      // Only rows that actually had the admin broadcast on inherit a list; one
      // that had it off asked for no group and still gets none.
      const permissions = Number(row.notify_admin) === 1 && catalogue
        ? catalogue.defaults.permissions
        : [];
      // eslint-disable-next-line no-await-in-loop
      await sequelize.query(
        'UPDATE notification_configs SET notify_permissions = :permissions WHERE id = :id',
        { replacements: { id: row.id, permissions: JSON.stringify(permissions) }, type: QueryTypes.UPDATE },
      );
    }
    await sequelize.query('ALTER TABLE notification_configs DROP COLUMN notify_admin');
    console.log(`[notify-config] notify_admin -> notify_permissions for ${rows.length} row(s)`);
  }

  // Any row still null (added the column but never populated) becomes an
  // explicit empty list, so reads never have to handle null.
  await sequelize.query(
    "UPDATE notification_configs SET notify_permissions = '[]' WHERE notify_permissions IS NULL",
  );
};

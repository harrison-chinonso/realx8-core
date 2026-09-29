const { QueryTypes } = require('sequelize');
const { isPostgres } = require('./dialect');

/**
 * Whether a table's append-only triggers are already in place, as written.
 *
 * ── Why this has to be asked before installing them ─────────────────────────
 *
 * createAuditLog and protectJournal used to DROP and re-CREATE their triggers
 * on every boot — idempotent, and harmless with one instance. On Postgres,
 * DROP TRIGGER takes an ACCESS EXCLUSIVE lock on the table. During a
 * zero-downtime deploy the OLD instance is still serving, writing an audit row
 * on almost every request; the new instance's DROP waits for any open
 * transaction on the table, and every later query on it queues behind the
 * waiting DROP. The new boot hangs at "[boot] user: migrating" until the
 * platform times the deploy out, and the old instance's requests stall with it.
 *
 * So a boot now touches the triggers only when they are missing or their
 * refusal message has changed — i.e. only when there is something to install.
 *
 * @param {string} table
 * @param {string} message   the refusal text; a different one means reinstall
 * @returns {Promise<boolean>} true when nothing needs doing
 */
const guardsInstalled = async (sequelize, table, message) => {
  const names = [`${table}_no_update`, `${table}_no_delete`];
  try {
    if (isPostgres(sequelize)) {
      const rows = await sequelize.query(
        `SELECT t.tgname, p.prosrc
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE n.nspname = CURRENT_SCHEMA() AND c.relname = :table
            AND NOT t.tgisinternal AND t.tgname IN (:names)`,
        { replacements: { table, names }, type: QueryTypes.SELECT },
      );
      return names.every((name) => rows.some((row) => row.tgname === name
        && String(row.prosrc || '').includes(message)));
    }
    const rows = await sequelize.query(
      `SELECT TRIGGER_NAME AS name, ACTION_STATEMENT AS body FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = :table AND TRIGGER_NAME IN (:names)`,
      { replacements: { table, names }, type: QueryTypes.SELECT },
    );
    return names.every((name) => rows.some((row) => row.name === name
      && String(row.body || '').includes(message)));
  } catch {
    // Unable to tell: install, which is what every boot did before.
    return false;
  }
};

module.exports = { guardsInstalled };

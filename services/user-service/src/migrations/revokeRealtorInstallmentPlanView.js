const { QueryTypes } = require('sequelize');
const { columnsOf } = require('../../../../shared/src/dialect');

/**
 * Takes the Installment Plans screen away from realtors.
 *
 * The realtor role held `finance.installment-plans.view` as a read-only grant —
 * the idea being that a realtor advises on plans without configuring any. In
 * practice it put a Finance screen in their sidebar that they have no reason to
 * open, so it is being withdrawn.
 *
 * Nothing they DO depends on it. Configuring a purchase reads the unit's
 * options through `/installment-plans/units/:id/options`, which carries no
 * permission requirement at all, so the purchase journey is untouched. Clients
 * never held the permission in the first place.
 *
 * ── Why this exists as well as the catalogue change ─────────────────────────
 *
 * seedRolesAndPermissions deliberately leaves a role alone once it has any
 * permissions at all — that is what stops it trampling customisations made
 * through the Roles screen on every boot. Editing the catalogue therefore only
 * reaches NEW installations, and every existing one would keep the grant
 * forever. This is the part that reaches the databases that already exist.
 *
 * ── Why it only runs once ───────────────────────────────────────────────────
 *
 * An administrator may decide they DO want their realtors to see it, and grant
 * it back through the Roles screen. A migration that revoked on every boot
 * would quietly undo that decision each restart, which is exactly the trampling
 * the seeder is careful to avoid. So it records that it has run and then leaves
 * the role alone for good.
 */
const MARKER_GROUP = 'migrations';
const MARKER_KEY = 'realtor_installment_plan_view_revoked';

const alreadyRun = async (sequelize) => {
  const rows = await sequelize.query(
    `SELECT 1 FROM settings WHERE ${sequelize.getDialect() === 'postgres' ? '"group"' : '`group`'} = :group
       AND ${sequelize.getDialect() === 'postgres' ? '"key"' : '`key`'} = :key LIMIT 1`,
    { replacements: { group: MARKER_GROUP, key: MARKER_KEY }, type: QueryTypes.SELECT },
  );
  return rows.length > 0;
};

module.exports = async (sequelize) => {
  const pg = sequelize.getDialect() === 'postgres';
  const groupCol = pg ? '"group"' : '`group`';
  const keyCol = pg ? '"key"' : '`key`';
  const valueCol = pg ? '"value"' : '`value`';

  try {
    if (await alreadyRun(sequelize)) return;

    /**
     * Written as subqueries rather than a joined DELETE on purpose: MySQL
     * spells that `DELETE rp FROM ... JOIN ...` and Postgres spells it
     * `DELETE FROM ... USING ...`, and this application runs on both.
     */
    // Counted first: a DELETE does not report an affected-row count the same
    // way on both engines, and the number is only for the log line.
    const [{ n: revoked }] = await sequelize.query(
      `SELECT COUNT(*) AS n FROM role_permissions
        WHERE role_id IN (SELECT id FROM roles WHERE name = 'realtor')
          AND permission_id IN (SELECT id FROM permissions WHERE name = 'finance.installment-plans.view')`,
      { type: QueryTypes.SELECT },
    );

    await sequelize.query(
      `DELETE FROM role_permissions
        WHERE role_id IN (SELECT id FROM roles WHERE name = 'realtor')
          AND permission_id IN (SELECT id FROM permissions WHERE name = 'finance.installment-plans.view')`,
    );

    /**
     * The timestamp columns are added only if the table actually has them.
     *
     * `settings` differs between installations — some carry updated_at and some
     * only created_at — and naming a column that is not there fails the insert,
     * which would leave the marker unwritten and this running on every boot.
     */
    const columns = (await columnsOf(sequelize, 'settings')) || new Map();
    const extra = ['created_at', 'updated_at'].filter((column) => columns.has(column));
    await sequelize.query(
      `INSERT INTO settings (${groupCol}, ${keyCol}, ${valueCol}, company_id${extra.length ? `, ${extra.join(', ')}` : ''})
       VALUES (:group, :key, 'done', NULL${extra.map(() => ', NOW()').join('')})`,
      { replacements: { group: MARKER_GROUP, key: MARKER_KEY }, type: QueryTypes.INSERT },
    );

    console.log(
      `[roles] realtor no longer sees Installment Plans (${revoked ?? 0} grant(s) revoked). `
      + 'Grant it back through the Roles screen if that was wanted; this will not run again.',
    );
  } catch (error) {
    // Never block a boot over a cosmetic permission change.
    console.warn(`[roles] could not revoke the realtor installment-plan view: ${error.message}`);
  }
};

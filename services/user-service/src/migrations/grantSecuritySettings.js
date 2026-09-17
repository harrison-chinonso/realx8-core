const { QueryTypes } = require('sequelize');
const { columnsOf } = require('../../../../shared/src/dialect');

/**
 * Gives super_admin the security settings permission it was never granted.
 *
 * ── The trap this closes ───────────────────────────────────────────────────
 *
 * `settings.security.manage` has been in the catalogue's permission list all
 * along and in no role's grant list at all — not admin, not super_admin. A
 * permission nobody holds is worse than a missing one, because it reads as
 * available: anyone gating a route on it would lock out every account in the
 * system, including the platform's own administrators, and the failure would
 * look like a bug in the guard rather than an empty grant. The 2FA policy
 * endpoints are why it was noticed — they still enforce a role check in their
 * handlers, because gating them properly would have taken the feature away
 * from everybody.
 *
 * ── Why this exists as well as the catalogue change ────────────────────────
 *
 * seedRolesAndPermissions leaves a configured role's set alone, and adds only
 * permissions that were CREATED on that boot — which is what stops it
 * trampling choices made on the Roles screen. This permission has existed for
 * a long time, so it counts as neither new nor missing, and editing the
 * catalogue reaches only installations that have never been seeded. This is
 * the part that reaches the ones that already exist.
 *
 * superior_admin is unaffected: it is granted '*', which the seeder re-applies
 * additively on every boot, so it already holds this.
 *
 * ── Why it only runs once ──────────────────────────────────────────────────
 *
 * An administrator may decide to take it away again on the Roles screen. A
 * migration that granted on every boot would quietly undo that each restart,
 * which is exactly the trampling the seeder is careful to avoid. So it records
 * that it has run and then leaves the role alone for good.
 */
const MARKER_GROUP = 'migrations';
const MARKER_KEY = 'super_admin_security_settings_granted';
const ROLE = 'super_admin';
const PERMISSION = 'settings.security.manage';

const quoted = (sequelize) => {
  const pg = sequelize.getDialect() === 'postgres';
  return {
    group: pg ? '"group"' : '`group`',
    key: pg ? '"key"' : '`key`',
    value: pg ? '"value"' : '`value`',
  };
};

const alreadyRun = async (sequelize) => {
  const q = quoted(sequelize);
  const rows = await sequelize.query(
    `SELECT 1 FROM settings WHERE ${q.group} = :group AND ${q.key} = :key LIMIT 1`,
    { replacements: { group: MARKER_GROUP, key: MARKER_KEY }, type: QueryTypes.SELECT },
  );
  return rows.length > 0;
};

module.exports = async function grantSecuritySettings(sequelize) {
  const q = quoted(sequelize);

  try {
    if (await alreadyRun(sequelize)) return;

    /*
     * A plain INSERT ... SELECT with a NOT EXISTS guard, rather than reading
     * the two ids and inserting a pair. One statement, so two boots racing
     * each other cannot both decide the row is missing; and it inserts nothing
     * at all when either the role or the permission is absent, which is the
     * case on a database that has not been seeded yet.
     *
     * role_permissions does carry a composite unique key, so the duplicate
     * would be refused anyway — but refused is not the same as skipped. The
     * error would reach the catch below and abandon the run BEFORE the marker
     * is written, so the next boot would try again and fail again, forever.
     * Measured, by deleting this guard: the grant survived on the constraint
     * and the marker never appeared.
     */
    await sequelize.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT r.id, p.id
         FROM roles r
         JOIN permissions p ON p.name = :permission
        WHERE r.name = :role
          AND NOT EXISTS (
            SELECT 1 FROM role_permissions rp
             WHERE rp.role_id = r.id AND rp.permission_id = p.id
          )`,
      { replacements: { role: ROLE, permission: PERMISSION }, type: QueryTypes.INSERT },
    );

    const [{ n: granted }] = await sequelize.query(
      `SELECT COUNT(*) AS n FROM role_permissions
        WHERE role_id IN (SELECT id FROM roles WHERE name = :role)
          AND permission_id IN (SELECT id FROM permissions WHERE name = :permission)`,
      { replacements: { role: ROLE, permission: PERMISSION }, type: QueryTypes.SELECT },
    );

    /*
     * The timestamp columns are added only if the table actually has them:
     * `settings` differs between installations, and naming a column that is
     * not there fails the insert — which would leave the marker unwritten and
     * run this again on every boot.
     */
    const columns = (await columnsOf(sequelize, 'settings')) || new Map();
    const extra = ['created_at', 'updated_at'].filter((column) => columns.has(column));
    await sequelize.query(
      `INSERT INTO settings (${q.group}, ${q.key}, ${q.value}, company_id${extra.length ? `, ${extra.join(', ')}` : ''})
       VALUES (:group, :key, 'done', NULL${extra.map(() => ', NOW()').join('')})`,
      { replacements: { group: MARKER_GROUP, key: MARKER_KEY }, type: QueryTypes.INSERT },
    );

    console.log(`[roles] super_admin now holds ${PERMISSION} (${granted ?? 0} grant(s) in place). `
      + 'It was defined in the catalogue and granted to nobody.');
  } catch (error) {
    // Best effort, like the migrations beside it: a permission grant must not
    // stop the service booting. The marker is only written on success, so a
    // failure here is retried on the next start rather than lost.
    console.error(`[roles] could not grant ${PERMISSION}: ${error.message}`);
  }
};

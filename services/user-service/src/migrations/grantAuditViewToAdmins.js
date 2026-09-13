const { QueryTypes } = require('sequelize');
const { columnsOf, q } = require('../../../../shared/src/dialect');

/**
 * Gives the company's own administrators the Audit Trail.
 *
 * ── Why the catalogue change is not enough ──────────────────────────────────
 *
 * seedRolesAndPermissions fills in a role's permissions only when that role has
 * NONE — which is what stops it trampling customisations made through the Roles
 * screen on every boot. So adding `audit.view` to the catalogue reaches new
 * installations and no existing one. This is the part that reaches the
 * databases that already exist.
 *
 * Without it the Audit Trail is a screen that exists and nobody can open: the
 * platform administrator could already see every company's activity, and the
 * people whose own company's activity it records could see none of it.
 *
 * ── Why super_admin and admin, and nothing below ────────────────────────────
 *
 * Those two roles ARE the company's administration. Reading who changed a
 * commission rule or suspended a realtor is part of running the company; a
 * branch manager or a customer-care agent has no such need, and the permission
 * is on the Roles screen for an owner who decides otherwise.
 *
 * The grant is company-SCOPED by the controller, not by this migration: holding
 * `audit.view` shows an administrator their own company's entries and nothing
 * else, whoever they are. There is no grant that widens that.
 *
 * ── Why it only runs once ───────────────────────────────────────────────────
 *
 * An administrator may decide their admins should NOT read the trail and revoke
 * it through the Roles screen. A migration that granted on every boot would
 * quietly undo that each restart — the precise trampling the seeder is careful
 * to avoid. So it records that it has run and then leaves the roles alone for
 * good. See revokeRealtorInstallmentPlanView.js, which is the same shape in the
 * opposite direction.
 */
const MARKER_GROUP = 'migrations';
const MARKER_KEY = 'audit_view_granted_to_admins';

const GRANT_TO = ['super_admin', 'admin'];
const PERMISSION = 'audit.view';

const alreadyRun = async (sequelize) => {
  const rows = await sequelize.query(
    `SELECT 1 FROM settings WHERE ${q(sequelize, 'group')} = :group
       AND ${q(sequelize, 'key')} = :key LIMIT 1`,
    { replacements: { group: MARKER_GROUP, key: MARKER_KEY }, type: QueryTypes.SELECT },
  );
  return rows.length > 0;
};

module.exports = async (sequelize) => {
  try {
    if (await alreadyRun(sequelize)) return;

    const [permission] = await sequelize.query(
      'SELECT id FROM permissions WHERE name = :name LIMIT 1',
      { replacements: { name: PERMISSION }, type: QueryTypes.SELECT },
    );
    /**
     * The permission row is created by seedRolesAndPermissions, which runs
     * before this. If it is somehow absent, leave without writing the marker so
     * the next boot tries again — a missing grant that retries is better than
     * one silently recorded as done.
     */
    if (!permission?.id) return;

    /**
     * Every role of these names, across every company.
     *
     * A tenant may carry its own `super_admin` row with its own company_id
     * alongside the platform-level one, so this deliberately does not filter on
     * `company_id IS NULL` — granting only the global role would leave every
     * company that has its own copy without the permission, which is the case
     * this migration exists to cover.
     */
    const roles = await sequelize.query(
      'SELECT id, name, company_id FROM roles WHERE name IN (:names)',
      { replacements: { names: GRANT_TO }, type: QueryTypes.SELECT },
    );

    let granted = 0;
    for (const role of roles) {
      // Additive, and checked first: role_permissions has no unique index in
      // every installation, so an unconditional insert could duplicate the row.
      // eslint-disable-next-line no-await-in-loop
      const held = await sequelize.query(
        'SELECT 1 FROM role_permissions WHERE role_id = :roleId AND permission_id = :permissionId LIMIT 1',
        { replacements: { roleId: role.id, permissionId: permission.id }, type: QueryTypes.SELECT },
      );
      if (held.length) continue;

      // eslint-disable-next-line no-await-in-loop
      await sequelize.query(
        'INSERT INTO role_permissions (role_id, permission_id) VALUES (:roleId, :permissionId)',
        { replacements: { roleId: role.id, permissionId: permission.id }, type: QueryTypes.INSERT },
      );
      granted += 1;
    }

    /**
     * The timestamp columns are added only if the table actually has them —
     * `settings` differs between installations, and naming a column that is not
     * there fails the insert, leaving the marker unwritten and this running
     * again on every boot.
     */
    const columns = (await columnsOf(sequelize, 'settings')) || new Map();
    const extra = ['created_at', 'updated_at'].filter((column) => columns.has(column));
    await sequelize.query(
      `INSERT INTO settings (${q(sequelize, 'group')}, ${q(sequelize, 'key')}, ${q(sequelize, 'value')}, company_id${
        extra.length ? `, ${extra.join(', ')}` : ''})
       VALUES (:group, :key, 'done', NULL${extra.map(() => ', NOW()').join('')})`,
      { replacements: { group: MARKER_GROUP, key: MARKER_KEY }, type: QueryTypes.INSERT },
    );

    console.log(
      `[roles] company administrators can now open the Audit Trail (${granted} grant(s) added). `
      + 'Revoke it through the Roles screen if that was not wanted; this will not run again.',
    );
  } catch (error) {
    // Never block a boot over a permission grant.
    console.warn(`[roles] could not grant ${PERMISSION}: ${error.message}`);
  }
};

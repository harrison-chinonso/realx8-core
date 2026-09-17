const { QueryTypes } = require('sequelize');
const { columnsOf } = require('../../../../shared/src/dialect');
const { PLATFORM_ONLY_PERMISSIONS } = require('./permissionCatalog');

/**
 * Takes the platform's own permissions off every role but the platform's.
 *
 * ── What it is cleaning up ─────────────────────────────────────────────────
 *
 * companies.view / create / manage / delete were offered by the Roles screen
 * to every company administrator, because listPermissions returned the whole
 * catalogue. Nothing behind them would have worked — the /companies routes
 * have always required a superior admin — but the checkbox saved, so a company
 * could be carrying grants that look like capabilities and are not.
 *
 * The code refuses them now. This is the part that reaches the rows already
 * written.
 *
 * ── Which roles are spared ─────────────────────────────────────────────────
 *
 * Any role holding '*'-equivalent platform standing keeps them: the grant is
 * removed only from roles that are NOT the platform's. superior_admin is
 * matched by name, and seedRolesAndPermissions re-grants it the full catalogue
 * on every boot anyway, so it could not lose them here even by accident.
 *
 * ── Why it only runs once ──────────────────────────────────────────────────
 *
 * A platform administrator may deliberately grant one of these to some other
 * role for a reason nobody anticipated. A migration that revoked on every boot
 * would undo that decision at each restart, which is exactly the trampling
 * seedRolesAndPermissions is careful to avoid.
 */
const MARKER_GROUP = 'migrations';
const MARKER_KEY = 'platform_only_permissions_revoked';

const quoted = (sequelize) => {
  const pg = sequelize.getDialect() === 'postgres';
  return {
    group: pg ? '"group"' : '`group`',
    key: pg ? '"key"' : '`key`',
    value: pg ? '"value"' : '`value`',
  };
};

module.exports = async function revokePlatformOnlyPermissions(sequelize) {
  const q = quoted(sequelize);

  try {
    const marker = await sequelize.query(
      `SELECT 1 FROM settings WHERE ${q.group} = :group AND ${q.key} = :key LIMIT 1`,
      { replacements: { group: MARKER_GROUP, key: MARKER_KEY }, type: QueryTypes.SELECT },
    );
    if (marker.length) return;

    /*
     * Counted before the delete: the two engines do not agree on what an
     * affected-row count means for a DELETE, and the number is only for the
     * log line.
     */
    const [{ n: held }] = await sequelize.query(
      `SELECT COUNT(*) AS n FROM role_permissions
        WHERE permission_id IN (SELECT id FROM permissions WHERE name IN (:names))
          AND role_id NOT IN (SELECT id FROM roles WHERE name = 'superior_admin')`,
      { replacements: { names: PLATFORM_ONLY_PERMISSIONS }, type: QueryTypes.SELECT },
    );

    /*
     * Subqueries rather than a joined DELETE: MySQL spells that
     * `DELETE rp FROM ... JOIN ...` and Postgres `DELETE FROM ... USING ...`,
     * and this application runs on both.
     */
    await sequelize.query(
      `DELETE FROM role_permissions
        WHERE permission_id IN (SELECT id FROM permissions WHERE name IN (:names))
          AND role_id NOT IN (SELECT id FROM roles WHERE name = 'superior_admin')`,
      { replacements: { names: PLATFORM_ONLY_PERMISSIONS } },
    );

    /*
     * The timestamp columns are added only if the table has them: `settings`
     * differs between installations, and naming a column that is not there
     * fails the insert — leaving the marker unwritten and this running on
     * every boot.
     */
    const columns = (await columnsOf(sequelize, 'settings')) || new Map();
    const extra = ['created_at', 'updated_at'].filter((column) => columns.has(column));
    await sequelize.query(
      `INSERT INTO settings (${q.group}, ${q.key}, ${q.value}, company_id${extra.length ? `, ${extra.join(', ')}` : ''})
       VALUES (:group, :key, 'done', NULL${extra.map(() => ', NOW()').join('')})`,
      { replacements: { group: MARKER_GROUP, key: MARKER_KEY }, type: QueryTypes.INSERT },
    );

    if (Number(held) > 0) {
      console.log(`[roles] revoked ${held} platform-only grant(s) from company roles `
        + `(${PLATFORM_ONLY_PERMISSIONS.join(', ')}).`);
    }
  } catch (error) {
    // Best effort, like the migrations beside it: a permission tidy-up must not
    // stop the service booting. The marker is written only on success, so a
    // failure is retried on the next start rather than lost.
    console.error(`[roles] could not revoke the platform-only permissions: ${error.message}`);
  }
};

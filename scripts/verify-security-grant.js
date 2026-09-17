/**
 * settings.security.manage reaches super_admin — on a database that already
 * exists, which is the only case that was broken.
 *
 * ── What was wrong ─────────────────────────────────────────────────────────
 *
 * The permission was defined in the catalogue and granted to no role at all.
 * A permission nobody holds is worse than a missing one: it reads as
 * available, so gating a route on it locks out every account including the
 * platform's own administrators, and the failure looks like a broken guard
 * rather than an empty grant.
 *
 * ── Why the catalogue edit alone was not enough ────────────────────────────
 *
 * seedRolesAndPermissions leaves a configured role's set alone and adds only
 * permissions CREATED on that boot. This one has existed all along, so it is
 * neither new nor missing, and editing the catalogue reaches only databases
 * that have never been seeded. That is the case this proves.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_grant`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifygrant';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

(async () => {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  const models = require('../services/user-service/src/models');
  const { sequelize } = models;
  await sequelize.sync({ force: true });

  const { QueryTypes } = require('sequelize');
  const grant = require('../services/user-service/src/migrations/grantSecuritySettings');
  const held = async (role) => {
    const rows = await sequelize.query(
      `SELECT p.name FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE r.name = :role AND p.name = 'settings.security.manage'`,
      { replacements: { role }, type: QueryTypes.SELECT },
    );
    return rows.length > 0;
  };
  const markers = async () => {
    const rows = await sequelize.query(
      "SELECT 1 FROM settings WHERE `group` = 'migrations' AND `key` = 'super_admin_security_settings_granted'",
      { type: QueryTypes.SELECT },
    );
    return rows.length;
  };

  console.log('\n── A database that already exists, before the fix ───────────────');
  {
    // Seed the way an older release did: the permission row present, and the
    // role holding everything the catalogue granted it — which never included
    // this one.
    await require('../services/user-service/src/migrations/seedRolesAndPermissions')(models);
    await sequelize.query(
      `DELETE FROM role_permissions
        WHERE role_id IN (SELECT id FROM roles WHERE name = 'super_admin')
          AND permission_id IN (SELECT id FROM permissions WHERE name = 'settings.security.manage')`,
    );

    const [row] = await sequelize.query(
      "SELECT id FROM permissions WHERE name = 'settings.security.manage'",
      { type: QueryTypes.SELECT },
    );
    check('The permission exists', Boolean(row), `id ${row?.id}`);
    check('...and super_admin does not hold it', !(await held('super_admin')),
      'the state every existing installation is in');
  }

  console.log('\n── The migration grants it ──────────────────────────────────────');
  {
    await grant(sequelize);
    check('super_admin holds it now', await held('super_admin'), '');
    check('...and the run is recorded once', (await markers()) === 1, '');
  }

  console.log('\n── Running it again changes nothing ─────────────────────────────');
  {
    await grant(sequelize);
    await grant(sequelize);
    const rows = await sequelize.query(
      `SELECT COUNT(*) AS n FROM role_permissions
        WHERE role_id IN (SELECT id FROM roles WHERE name = 'super_admin')
          AND permission_id IN (SELECT id FROM permissions WHERE name = 'settings.security.manage')`,
      { type: QueryTypes.SELECT },
    );
    check('Exactly one grant, not three', Number(rows[0].n) === 1, `${rows[0].n} row(s)`);
    check('...and one marker', (await markers()) === 1, '');
  }

  console.log('\n── The INSERT guard holds on its own ────────────────────────────');
  {
    /*
     * The marker makes a second run a no-op, which means every check above
     * passes even with the statement's NOT EXISTS guard deleted — measured, by
     * deleting it. So the guard is exercised directly: marker removed, run
     * again, and the grant must still be a single row.
     *
     * Two boots starting together is exactly this case. Both read no marker,
     * both run the INSERT, and without the guard the role ends up holding the
     * permission twice.
     */
    await sequelize.query(
      "DELETE FROM settings WHERE `group` = 'migrations' AND `key` = 'super_admin_security_settings_granted'",
    );
    await grant(sequelize);
    const rows = await sequelize.query(
      `SELECT COUNT(*) AS n FROM role_permissions
        WHERE role_id IN (SELECT id FROM roles WHERE name = 'super_admin')
          AND permission_id IN (SELECT id FROM permissions WHERE name = 'settings.security.manage')`,
      { type: QueryTypes.SELECT },
    );
    check('Still one grant with the marker gone', Number(rows[0].n) === 1, `${rows[0].n} row(s)`);
  }

  console.log('\n── An administrator who takes it away is not overruled ──────────');
  {
    /*
     * The reason this records a marker at all. Somebody may decide on the
     * Roles screen that their platform admins should not hold it; a migration
     * that granted on every boot would put it back each restart, which is the
     * trampling seedRolesAndPermissions is careful to avoid.
     */
    await sequelize.query(
      `DELETE FROM role_permissions
        WHERE role_id IN (SELECT id FROM roles WHERE name = 'super_admin')
          AND permission_id IN (SELECT id FROM permissions WHERE name = 'settings.security.manage')`,
    );
    await grant(sequelize);
    check('It stays revoked', !(await held('super_admin')), 'their decision survives a restart');
  }

  console.log('\n── The catalogue says the same thing ────────────────────────────');
  {
    const { SUPER_ADMIN_PERMISSIONS, ROLE_PERMISSIONS } = require('../services/user-service/src/migrations/permissionCatalog');
    check('super_admin is granted it in the catalogue too',
      SUPER_ADMIN_PERMISSIONS.includes('settings.security.manage'),
      'so a fresh installation needs no migration at all');
    check('...and superior_admin still holds everything',
      ROLE_PERMISSIONS.superior_admin === '*', 'granted * and re-applied additively every boot');
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await sequelize.close();
  await admin.query(`DROP DATABASE \`${DB}\``);
  await admin.end();
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

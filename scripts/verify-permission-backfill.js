/**
 * A new permission reaches the roles that should have it, and takes nothing
 * away from the roles that have been customised.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * The seeder deliberately leaves a configured role's permission set alone,
 * because `setPermissions` REPLACES it and reasserting defaults on every boot
 * would silently undo an administrator's work. Correct — but it also meant a
 * brand-new permission could never reach any role that had ever been touched.
 * The feature behind it would ship, its screens would appear, and its button
 * would stay hidden for everybody except the platform admin.
 *
 * That is not a decision being respected. Nobody could have decided to withhold
 * a permission that did not exist when they last looked.
 *
 * So new permissions are now added, and only new ones, and only by ADDING.
 * What has to hold:
 *
 *   1. a role that has been customised keeps every customisation
 *   2. ...and still receives a permission that has just come into existence
 *   3. a permission the administrator has since REMOVED does not come back
 *   4. a role with no permissions at all is still seeded from scratch
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_permissions`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifyperms';

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
  const { sequelize, Role, Permission } = models;

  await models.Company.sync({ force: true });
  await Permission.sync({ force: true });
  await Role.sync({ force: true });
  // The join table, however this build names it.
  await sequelize.sync();

  const seed = require('../services/user-service/src/migrations/seedRolesAndPermissions');
  const catalogue = require('../services/user-service/src/migrations/permissionCatalog');

  const namesFor = async (roleName) => {
    const role = await Role.findOne({ where: { name: roleName, company_id: null } });
    const permissions = await role.getPermissions();
    return permissions.map((p) => p.name).sort();
  };

  // ── first boot ────────────────────────────────────────────────────────────
  await seed(models);
  const adminFirst = await namesFor('admin');
  check('A fresh role is seeded from the catalogue', adminFirst.length > 0, `${adminFirst.length} permissions`);
  check('...including the note approval', adminFirst.includes('finance.notes.approve'), '');

  // ── an administrator customises the role ──────────────────────────────────
  {
    const role = await Role.findOne({ where: { name: 'admin', company_id: null } });
    const extra = await Permission.findOne({ where: { name: 'media.approve' } });
    const removed = await Permission.findOne({ where: { name: 'finance.taxes.manage' } });
    if (extra) await role.addPermission(extra);
    if (removed) await role.removePermission(removed);
  }
  const customised = await namesFor('admin');

  // ── a new permission appears in the catalogue ─────────────────────────────
  const INVENTED = 'finance.verification.invented';
  catalogue.PERMISSIONS.push({
    name: INVENTED, display_name: 'Invented For Verification', module: 'finance',
  });
  catalogue.ROLE_PERMISSIONS.admin.push(INVENTED);

  await seed(models);
  const afterNew = await namesFor('admin');

  check('A permission that has just come into existence reaches the role',
    afterNew.includes(INVENTED), afterNew.includes(INVENTED) ? '' : 'the role never sees it');

  /**
   * The half that protects the administrator. Everything they added must still
   * be there, and — the sharper case — everything they deliberately REMOVED
   * must stay removed.
   */
  check('...and everything they added by hand survives',
    afterNew.includes('media.approve'), '');
  check('...and a permission they deliberately removed does NOT come back',
    !afterNew.includes('finance.taxes.manage'),
    afterNew.includes('finance.taxes.manage') ? 'the seeder undid their decision' : '');
  check('...nothing else changed',
    afterNew.length === customised.length + 1,
    `${customised.length} before, ${afterNew.length} after`);

  // ── and again, with nothing new ───────────────────────────────────────────
  await seed(models);
  const afterRepeat = await namesFor('admin');
  check('Booting again with nothing new changes nothing',
    JSON.stringify(afterRepeat) === JSON.stringify(afterNew), '');

  /**
   * And it must not resurrect the invented permission after the administrator
   * takes it away: it is no longer new, so there is nothing to backfill.
   */
  {
    const role = await Role.findOne({ where: { name: 'admin', company_id: null } });
    const invented = await Permission.findOne({ where: { name: INVENTED } });
    await role.removePermission(invented);
  }
  await seed(models);
  const afterRemoval = await namesFor('admin');
  check('A backfilled permission the administrator then removes stays removed',
    !afterRemoval.includes(INVENTED),
    afterRemoval.includes(INVENTED) ? 'it came back, so the grant is not a one-off' : '');

  await sequelize.close();
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error('\n  Harness error:', error);
  process.exit(1);
});

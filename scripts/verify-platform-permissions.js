/**
 * Only the platform manages companies — offered, granted and assigned.
 *
 * ── What was wrong ─────────────────────────────────────────────────────────
 *
 * companies.view / create / manage / delete existed in the catalogue and were
 * returned by listPermissions to everybody, so the Roles screen drew "Manage
 * Companies" as a checkbox in front of every company administrator. They could
 * tick it, save it, and hand the role to somebody. Nothing behind it would
 * work — /companies has always required a superior admin — which is the worst
 * version: a capability that appears to exist and then fails reads as a broken
 * platform rather than a boundary.
 *
 * And the shorter route was open anyway. assignRole and syncUserRoles resolved
 * a role by id or name with no scope, so a company administrator could assign
 * `superior_admin` — to a colleague or to themselves — and that role holds
 * everything. Refusing companies.* on a custom role while leaving that open
 * would have achieved nothing.
 *
 * Driven through the real controllers against a throwaway database.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_platform_perms`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifyplat';

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
  const { sequelize, Company, User, Role, Permission, Setting } = models;
  await sequelize.sync({ force: true });
  await require('../services/user-service/src/migrations/seedRolesAndPermissions')(models);

  const controller = require('../services/user-service/src/controllers/userController');
  const { PLATFORM_ONLY_PERMISSIONS } = require('../services/user-service/src/migrations/permissionCatalog');

  const run = (handler, req) => new Promise((resolve) => {
    let code = 200;
    const res = {
      status(c) { code = c; return res; },
      json(body) { resolve({ code, body }); return res; },
    };
    Promise.resolve(handler(req, res, (err) => resolve({ code: 500, body: { error: err } })))
      .catch((err) => resolve({ code: 500, body: { error: err } }));
  });

  await Company.create({ id: 1, name: 'Acme Homes', slug: 'acme', email: 'a@example.test' });
  const platform = { id: 1, type: 'superior_admin', isSuperiorAdmin: true, company_id: null };
  const acme = { id: 2, type: 'admin', isSuperiorAdmin: false, company_id: 1 };

  const staff = await User.create({
    name: 'Bola', email: 'bola@example.test', password: 'x', type: 'admin', company_id: 1,
  });

  console.log('\n── The Roles screen is not offered what it cannot grant ─────────');
  {
    const mine = await run(controller.listPermissions, { user: acme, query: {} });
    const names = (mine.body?.data || []).map((p) => p.name);
    check('A company administrator sees no companies permission',
      !names.some((n) => n.startsWith('companies.')),
      names.filter((n) => n.startsWith('companies.')).join(', ') || `${names.length} permissions, none of them companies`);
    /*
     * Everything else still reaches them — this is a boundary, not a purge.
     */
    check('...and still sees the rest of the catalogue',
      names.includes('users.view') && names.includes('finance.invoices.view'), `${names.length} permissions`);

    const theirs = await run(controller.listPermissions, { user: platform, query: {} });
    const all = (theirs.body?.data || []).map((p) => p.name);
    check('A platform administrator sees all four',
      PLATFORM_ONLY_PERMISSIONS.every((n) => all.includes(n)), `${all.length} permissions`);
  }

  console.log('\n── And the API refuses them even when asked directly ────────────');
  {
    const role = await Role.create({ name: 'branch_lead', display_name: 'Branch Lead', company_id: 1 });

    /*
     * Hiding a checkbox is not a boundary. This is the request a screen would
     * never send and a script sends first.
     */
    const refused = await run(controller.syncRolePermissions, {
      user: acme,
      params: { id: role.id },
      body: { permissions: ['users.view', 'companies.manage'] },
    });
    check('Granting companies.manage to a company role is refused',
      refused.code === 403, refused.body?.message);
    check('...naming which permission, not just saying no',
      /companies\.manage/.test(refused.body?.message || ''), refused.body?.message);

    const held = await role.getPermissions();
    check('...and nothing was written, not even the permitted half',
      held.length === 0, held.map((p) => p.name).join(', ') || 'none');

    const allowed = await run(controller.syncRolePermissions, {
      user: acme, params: { id: role.id }, body: { permissions: ['users.view'] },
    });
    check('An ordinary permission still saves', allowed.code === 200, '');

    const byPlatform = await run(controller.syncRolePermissions, {
      user: platform, params: { id: role.id }, body: { permissions: ['users.view', 'companies.view'] },
    });
    const after = (await role.getPermissions()).map((p) => p.name).sort();
    check('The platform may still grant one deliberately',
      byPlatform.code === 200 && after.includes('companies.view'), after.join(', '));

    /*
     * The company admin edits an unrelated checkbox afterwards. The grant they
     * could not see in their own list must survive — only the platform gave
     * it, so only the platform takes it away.
     */
    await run(controller.syncRolePermissions, {
      user: acme, params: { id: role.id }, body: { permissions: ['users.view', 'users.manage'] },
    });
    const kept = (await role.getPermissions()).map((p) => p.name).sort();
    check('...and a company edit afterwards does not silently strip it',
      kept.includes('companies.view') && kept.includes('users.manage'), kept.join(', '));
  }

  console.log('\n── The shorter route is closed too ──────────────────────────────');
  {
    const superior = await Role.findOne({ where: { name: 'superior_admin' } });

    /*
     * The escalation that made everything above pointless: assign the role
     * that already holds '*' rather than build one that holds companies.*.
     */
    const byId = await run(controller.assignRole, {
      user: acme, params: { id: staff.id }, body: { role_id: superior.id },
    });
    check('A company admin cannot assign the platform role by id',
      byId.code === 403, byId.body?.message);

    const byName = await run(controller.assignRole, {
      user: acme, params: { id: staff.id }, body: { roles: ['superior_admin'] },
    });
    check('...nor by name', byName.code === 403, byName.body?.message);

    const replaced = await run(controller.syncUserRoles, {
      user: acme, params: { id: staff.id }, body: { roles: ['superior_admin'] },
    });
    check('...nor by replacing the user\'s whole role list', replaced.code === 403, replaced.body?.message);

    await staff.reload();
    const roles = await staff.getRoles();
    check('...and the user holds none of it',
      !roles.some((r) => r.name === 'superior_admin'), roles.map((r) => r.name).join(', ') || 'no roles');

    const ordinary = await run(controller.assignRole, {
      user: acme, params: { id: staff.id }, body: { roles: ['branch_manager'] },
    });
    check('An ordinary role still assigns', ordinary.code === 200, ordinary.body?.message);
  }

  console.log('\n── A platform role a user already holds is not stripped ─────────');
  {
    const victim = await User.create({
      name: 'Chidi', email: 'chidi@example.test', password: 'x', type: 'admin', company_id: 1,
    });
    const superior = await Role.findOne({ where: { name: 'superior_admin' } });
    await victim.addRole(superior);

    /*
     * setRoles REPLACES. Without the carry-over, a company administrator
     * saving an unrelated change to this user would quietly demote a platform
     * administrator — which is a denial of service on the one account that
     * could undo it.
     */
    await run(controller.syncUserRoles, {
      user: acme, params: { id: victim.id }, body: { roles: ['branch_manager'] },
    });
    const after = (await victim.getRoles()).map((r) => r.name).sort();
    check('It survives a company admin editing their other roles',
      after.includes('superior_admin') && after.includes('branch_manager'), after.join(', '));
  }

  console.log('\n── The platform\'s roles are not even listed to a company ────────');
  {
    const mine = await run(controller.listRoles, { user: acme, query: {} });
    const names = (mine.body?.data || []).map((r) => r.name);
    check('superior_admin is absent from the list a company sees',
      !names.includes('superior_admin'), `${names.length} roles: ${names.slice(0, 6).join(', ')}…`);
    check('...and the ordinary roles are all still there',
      names.includes('admin') && names.includes('realtor'), '');

    const theirs = await run(controller.listRoles, { user: platform, query: {} });
    check('A platform administrator sees it',
      (theirs.body?.data || []).some((r) => r.name === 'superior_admin'), '');

    /*
     * /roles is served unauthenticated for the sign-up form, which has no
     * business knowing the platform's role structure.
     */
    const anonymous = await run(controller.listRoles, { query: {} });
    check('...and an unauthenticated caller does not',
      !(anonymous.body?.data || []).map((r) => r.name).includes('superior_admin'), '');
  }

  console.log('\n── Grants already written are cleaned up ────────────────────────');
  {
    const role = await Role.create({ name: 'legacy_ops', display_name: 'Legacy Ops', company_id: 1 });
    const perms = await Permission.findAll({ where: { name: PLATFORM_ONLY_PERMISSIONS } });
    await role.setPermissions(perms);
    check('A company role carrying them, as one could before',
      (await role.getPermissions()).length === PLATFORM_ONLY_PERMISSIONS.length, '');

    await require('../services/user-service/src/migrations/revokePlatformOnlyPermissions')(sequelize);

    const left = (await role.getPermissions()).map((p) => p.name);
    check('The migration strips them', left.length === 0, left.join(', ') || 'none left');

    const superior = await Role.findOne({ where: { name: 'superior_admin' } });
    const platformHolds = (await superior.getPermissions()).map((p) => p.name);
    check('...and leaves the platform role alone',
      PLATFORM_ONLY_PERMISSIONS.every((n) => platformHolds.includes(n)), '');
  }

  console.log('\n── A name added to the list later is cleaned on the next boot ───');
  {
    const revoke = require('../services/user-service/src/migrations/revokePlatformOnlyPermissions');
    const marker = { group: 'migrations', key: 'platform_only_permissions_revoked' };

    /*
     * The marker the FIRST version of this migration wrote: a bare 'done',
     * which said that it had run and not what it had cleaned. platform.* was
     * added to the list afterwards, so a `done` marker must not shield it.
     */
    await Setting.destroy({ where: marker });
    await Setting.create({ ...marker, value: 'done', company_id: null });

    const role = await Role.create({ name: 'legacy_ops_2', display_name: 'Legacy Ops 2', company_id: 1 });
    await role.setPermissions(
      await Permission.findAll({ where: { name: ['platform.dashboard.view', 'users.view'] } }),
    );

    await revoke(sequelize);
    const left = (await role.getPermissions()).map((p) => p.name);
    check('A bare `done` marker does not shield a newly added name',
      !left.includes('platform.dashboard.view'), left.join(', ') || 'none left');
    check('...and an ordinary permission beside it is untouched',
      left.includes('users.view'), left.join(', ') || 'none left');

    /*
     * The other half of the bargain: once a name is in the marker, a grant the
     * platform makes deliberately afterwards survives every restart.
     */
    await role.setPermissions(await Permission.findAll({ where: { name: PLATFORM_ONLY_PERMISSIONS } }));
    await revoke(sequelize);
    check('A grant made after the clean-up is not revoked again on the next boot',
      (await role.getPermissions()).length === PLATFORM_ONLY_PERMISSIONS.length,
      `${(await role.getPermissions()).length} of ${PLATFORM_ONLY_PERMISSIONS.length} kept`);
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await sequelize.close();
  await admin.query(`DROP DATABASE \`${DB}\``);
  await admin.end();
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

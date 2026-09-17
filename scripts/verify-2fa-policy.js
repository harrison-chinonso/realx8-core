/**
 * Who may set a 2FA policy, and WHOSE policy they set.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * The endpoints used to answer both questions with one line —
 * `['super_admin','superior_admin'].includes(req.user.type)` — and then decide
 * the target company by asking the same question again: "if you are a
 * super_admin, your own company; otherwise global, or whichever company you
 * named". That second branch was safe only while `otherwise` could mean
 * nothing except a platform administrator.
 *
 * Moving the gate to settings.security.manage breaks that assumption. A
 * company may now grant the permission to a custom role, and under the old
 * branch such a role would have fallen through to `otherwise` — able to set
 * the GLOBAL policy, or another tenant's. Loosening a gate turned a harmless
 * else into a privilege escalation.
 *
 * So the branch keys on isSuperiorAdmin, which is what it always meant, and
 * this proves it: the platform admin keeps the wide powers, and everybody else
 * — whatever their type — is confined to their own company.
 *
 * The read had the same shape of bug: it returned every row in the table, so
 * one company's administrator could see whether every other tenant had
 * enforced two-factor.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_2fa`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verify2fa';

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

  const { sequelize } = require('../services/auth-service/src/config/database');
  await sequelize.query(`CREATE TABLE settings (
    id INT AUTO_INCREMENT PRIMARY KEY, \`key\` VARCHAR(80), \`value\` TEXT,
    \`group\` VARCHAR(60), company_id INT NULL)`);

  const controller = require('../services/auth-service/src/controllers/authController');
  const { requirePermission } = require('../shared/src/middleware/auth');

  const run = (handler, req) => new Promise((resolve) => {
    let code = 200;
    const res = {
      status(c) { code = c; return res; },
      json(body) { resolve({ code, body }); return res; },
    };
    Promise.resolve(handler(req, res, (err) => resolve({ code: 500, body: { error: err } })))
      .catch((err) => resolve({ code: 500, body: { error: err } }));
  });

  /** Does the ROUTE let this actor through? */
  const passesGate = (user) => {
    let refused = false;
    const res = { status() { refused = true; return res; }, json() { return res; } };
    requirePermission('settings.security.manage')({ user }, res, () => {});
    return !refused;
  };

  const platform = { id: 1, type: 'superior_admin', isSuperiorAdmin: true, company_id: null, permissions: [] };
  const acme = { id: 2, type: 'super_admin', company_id: 1, permissions: ['settings.security.manage'] };
  const beta = { id: 3, type: 'super_admin', company_id: 2, permissions: ['settings.security.manage'] };
  // The case the rewrite exists for: a company role that is neither of the two
  // types the old check named, holding the permission.
  const delegate = { id: 4, type: 'admin', company_id: 1, permissions: ['settings.security.manage'] };
  const nobody = { id: 5, type: 'admin', company_id: 1, permissions: ['users.view'] };

  console.log('\n── The gate is the permission now ───────────────────────────────');
  {
    check('A platform admin is through', passesGate(platform), 'isSuperiorAdmin bypasses every permission check');
    check('A company super_admin holding it is through', passesGate(acme), '');
    check('A delegated role holding it is through', passesGate(delegate),
      'which is the point — a company can delegate this like anything else');
    check('Somebody without it is refused', !passesGate(nobody), '');
  }

  console.log('\n── A company administrator sets only their own ──────────────────');
  {
    /*
     * company_id: null in the body is the request that used to reach the
     * global policy. It must be ignored for anyone but the platform.
     */
    const out = await run(controller.set2FAPolicy, { user: acme, body: { required: true, company_id: null } });
    check('The write is accepted', out.code === 200, `HTTP ${out.code}`);
    check('...against THEIR company, not globally',
      out.body?.company_id === 1, `company_id ${out.body?.company_id}`);

    const named = await run(controller.set2FAPolicy, { user: acme, body: { required: true, company_id: 2 } });
    check('...and naming another company does not reach it',
      named.body?.company_id === 1, `company_id ${named.body?.company_id}`);
  }

  console.log('\n── And so does a delegated role ─────────────────────────────────');
  {
    /*
     * The escalation the rewrite prevents. Under the old branch this actor is
     * "not a super_admin", so it fell through to the platform case and could
     * have set the global policy for every tenant on the installation.
     */
    const out = await run(controller.set2FAPolicy, { user: delegate, body: { required: false, company_id: null } });
    check('Confined to their own company', out.body?.company_id === 1, `company_id ${out.body?.company_id}`);

    const rows = await sequelize.query(
      "SELECT company_id FROM settings WHERE `key` = '2fa_required' AND company_id IS NULL",
      { type: sequelize.constructor.QueryTypes.SELECT },
    );
    check('...and the global policy was never written', rows.length === 0, `${rows.length} global row(s)`);
  }

  console.log('\n── The platform administrator keeps the wide powers ─────────────');
  {
    const global = await run(controller.set2FAPolicy, { user: platform, body: { required: true } });
    check('Sets the global policy', global.body?.company_id === null, `company_id ${global.body?.company_id}`);

    const other = await run(controller.set2FAPolicy, { user: platform, body: { required: true, company_id: 2 } });
    check('...and any company by name', other.body?.company_id === 2, `company_id ${other.body?.company_id}`);
  }

  console.log('\n── Reading is scoped the same way ───────────────────────────────');
  {
    await run(controller.set2FAPolicy, { user: beta, body: { required: true } });

    const all = await run(controller.get2FAPolicyEndpoint, { user: platform });
    check('A platform admin sees every company',
      all.body?.company_overrides?.length === 2, JSON.stringify(all.body?.company_overrides));

    const mine = await run(controller.get2FAPolicyEndpoint, { user: acme });
    /*
     * The leak this closes: whether every other tenant had enforced
     * two-factor, readable from a screen about your own settings — a map of
     * which competitors are least protected.
     */
    check('A company admin sees only their own override',
      mine.body?.company_overrides?.length === 1
        && Number(mine.body.company_overrides[0].company_id) === 1,
      JSON.stringify(mine.body?.company_overrides));
    check('...and still sees the global policy, which applies to them',
      mine.body?.global_required === true, String(mine.body?.global_required));
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await sequelize.close();
  await admin.query(`DROP DATABASE \`${DB}\``);
  await admin.end();
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

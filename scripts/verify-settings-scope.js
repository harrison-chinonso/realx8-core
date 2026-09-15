/**
 * A platform admin can configure ONE company's settings, and a company admin
 * still cannot escape their own.
 *
 * ── What this protects ──────────────────────────────────────────────────────
 *
 * The settings endpoints take a `company_id`, and what they do with it is the
 * whole of the tenancy boundary on this page. Two things have to hold, and the
 * second matters more than the first:
 *
 *   1. a platform admin who names a company writes to that company, and to the
 *      platform-wide defaults when they name none;
 *   2. a company admin who names a company — by accident, by a stale form, or
 *      deliberately — writes to their OWN company regardless.
 *
 * (2) has no visible symptom when it breaks. A tenant quietly editing another
 * tenant's SMTP credentials or payment keys looks exactly like a tenant editing
 * their own, right up until somebody notices their mail is being sent through
 * a competitor's server.
 *
 * System Configuration was the one group that could not be targeted at all: it
 * was pinned to the platform for a superior admin, so a platform admin could
 * not set a tenant's Google OAuth or Cloudinary credentials on their behalf.
 * That is (1)'s side of the same boundary, and it is checked here too.
 *
 * Driven through the REAL controllers, with req/res doubles — the rules live in
 * the controller, not in the HTTP layer, and a test that reimplemented them
 * would pass whatever the controller did.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_settings_scope`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifysettings';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

/** Enough of an Express response to read what the controller decided. */
const capture = () => {
  const out = { statusCode: 200, body: null };
  out.status = (code) => { out.statusCode = code; return out; };
  out.json = (body) => { out.body = body; return out; };
  return out;
};

const call = async (handler, req) => {
  const res = capture();
  await handler(req, res, (err) => { if (err) throw err; });
  return res;
};

const PLATFORM_ADMIN = { id: 1, type: 'superior_admin', company_id: null, isSuperiorAdmin: true };
const COMPANY_A_ADMIN = { id: 2, type: 'admin', company_id: 1 };

(async () => {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  const models = require('../services/user-service/src/models');
  const { sequelize, Setting } = models;
  await sequelize.sync({ force: true });

  const controller = require('../services/user-service/src/controllers/userController');

  const rowsFor = async (group) => {
    const rows = await Setting.findAll({ where: { group }, order: [['id', 'ASC']] });
    return rows.map((row) => ({ key: row.key, value: row.value, company_id: row.company_id }));
  };

  console.log('\n── A platform admin writes where they aim ───────────────────────');
  {
    await call(controller.bulkUpdateSettings, {
      user: PLATFORM_ADMIN,
      body: { group: 'appearance', settings: [{ key: 'primary_color', value: '#111111' }] },
    });
    const platform = await rowsFor('appearance');
    check('Naming no company writes the platform defaults',
      platform.length === 1 && platform[0].company_id === null,
      JSON.stringify(platform));

    await call(controller.bulkUpdateSettings, {
      user: PLATFORM_ADMIN,
      body: { group: 'appearance', settings: [{ key: 'primary_color', value: '#222222', company_id: 2 }] },
    });
    const all = await rowsFor('appearance');
    const forTwo = all.filter((row) => Number(row.company_id) === 2);
    check('...and naming company 2 writes company 2',
      forTwo.length === 1 && forTwo[0].value === '#222222',
      JSON.stringify(all));

    check('...leaving the platform default untouched',
      all.find((row) => row.company_id === null)?.value === '#111111',
      JSON.stringify(all.find((row) => row.company_id === null)));
  }

  console.log('\n── A company admin cannot aim anywhere else ─────────────────────');
  {
    /*
     * The important one. `company_id: 2` is passed by a tenant admin who
     * belongs to company 1 — the exact shape a stale form or a tampered request
     * would take.
     */
    await call(controller.bulkUpdateSettings, {
      user: COMPANY_A_ADMIN,
      body: { group: 'appearance', settings: [{ key: 'primary_color', value: '#999999', company_id: 2 }] },
    });
    const all = await rowsFor('appearance');
    const two = all.find((row) => Number(row.company_id) === 2);
    const one = all.find((row) => Number(row.company_id) === 1);

    check('A tenant naming another company is written to their own',
      one?.value === '#999999', JSON.stringify(one));
    check('...and the company they named is untouched',
      two?.value === '#222222', JSON.stringify(two));
    check('...and so are the platform defaults',
      all.find((row) => row.company_id === null)?.value === '#111111');
  }

  console.log('\n── System configuration follows the same target ─────────────────');
  {
    await call(controller.saveSystemConfig, {
      user: PLATFORM_ADMIN,
      body: { company_id: 2, cloudinary_cloud_name: 'company-two-cloud' },
    });
    const rows = await rowsFor('system');
    check('A platform admin can set a named company’s credentials',
      rows.length === 1 && Number(rows[0].company_id) === 2 && rows[0].value === 'company-two-cloud',
      JSON.stringify(rows));

    /*
     * The routing instruction must not become a stored credential. `company_id`
     * arrives in the same body as the fields, and a save that wrote it through
     * would leave a setting called company_id sitting in the system group.
     */
    check('...and company_id is not itself stored as a setting',
      !rows.some((row) => row.key === 'company_id'), JSON.stringify(rows.map((r) => r.key)));

    await call(controller.saveSystemConfig, {
      user: COMPANY_A_ADMIN,
      body: { company_id: 2, cloudinary_cloud_name: 'tenant-attempt' },
    });
    const after = await rowsFor('system');
    check('A tenant naming another company still writes their own',
      after.find((row) => Number(row.company_id) === 1)?.value === 'tenant-attempt',
      JSON.stringify(after));
    check('...and company 2’s credentials are unchanged',
      after.find((row) => Number(row.company_id) === 2)?.value === 'company-two-cloud',
      JSON.stringify(after));
  }

  console.log('\n── Reading is scoped the same way as writing ────────────────────');
  {
    const asPlatform = await call(controller.getSettings, {
      user: PLATFORM_ADMIN, query: { group: 'appearance', company_id: 2 },
    });
    check('A platform admin reads the company they name',
      asPlatform.body?.data?.primary_color === '#222222',
      JSON.stringify(asPlatform.body?.data));

    const platformDefaults = await call(controller.getSettings, {
      user: PLATFORM_ADMIN, query: { group: 'appearance' },
    });
    check('...and the platform defaults when they name none',
      platformDefaults.body?.data?.primary_color === '#111111',
      JSON.stringify(platformDefaults.body?.data));

    const asTenant = await call(controller.getSettings, {
      user: COMPANY_A_ADMIN, query: { group: 'appearance', company_id: 2 },
    });
    check('A tenant asking for another company reads their own',
      asTenant.body?.data?.primary_color === '#999999',
      JSON.stringify(asTenant.body?.data));

    /*
     * Sensitive groups take an earlier branch that never consults the target at
     * all, so they are checked separately — a tenant must not read another
     * company's mail credentials by naming it.
     */
    await Setting.create({ key: 'smtp_pass', value: 'company-two-secret', group: 'email', company_id: 2 });
    const secrets = await call(controller.getSettings, {
      user: COMPANY_A_ADMIN, query: { group: 'email', company_id: 2 },
    });
    check('A tenant cannot read another company’s secrets by naming it',
      secrets.body?.data?.smtp_pass === undefined,
      JSON.stringify(secrets.body?.data));
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await sequelize.close();
  await admin.query(`DROP DATABASE \`${DB}\``);
  await admin.end();
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

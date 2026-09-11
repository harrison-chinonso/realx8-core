/**
 * Which Cloudinary credentials a company actually uploads with.
 *
 * The reported symptom was a company seeing "Cloudinary credentials not
 * configured" on a deployment that had perfectly good platform-wide ones. The
 * cause was that the lookup selected every `system` cloudinary row in the table
 * with NO company filter and folded them into one map where the last row won.
 *
 * That produced two failures, and only the milder one was noticed:
 *
 *   a company with blank values shadowed the platform-wide credentials with
 *   empty strings, which is the reported error
 *
 *   a company that had never configured Cloudinary could upload with ANOTHER
 *   company's credentials, which is a cross-tenant leak of a paid account and
 *   would never have announced itself
 *
 * Both are checked below, against a throwaway database.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_cloudinary`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

(async () => {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  const { sequelize } = require('../services/user-service/src/models');
  await sequelize.query(`CREATE TABLE settings (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, \`group\` VARCHAR(64),
    \`key\` VARCHAR(64), \`value\` TEXT, company_id INT UNSIGNED NULL,
    created_at DATETIME NULL, updated_at DATETIME NULL)`);

  const set = (key, value, companyId) => sequelize.query(
    "INSERT INTO settings (`group`, `key`, `value`, company_id) VALUES ('system', :key, :value, :companyId)",
    { replacements: { key, value, companyId } },
  );

  const { resolveCredentials, invalidateCredsCache } = require('../services/user-service/src/utils/cloudinaryService');
  // The environment must not answer for the database in these checks.
  delete process.env.CLOUDINARY_CLOUD_NAME;
  delete process.env.CLOUDINARY_API_KEY;
  delete process.env.CLOUDINARY_API_SECRET;

  // Platform-wide credentials every company inherits.
  await set('cloudinary_cloud_name', 'platform-cloud', null);
  await set('cloudinary_api_key', 'platform-key', null);
  await set('cloudinary_api_secret', 'platform-secret', null);

  // Company 1 has its own. Company 2 has none. Company 3 saved blanks.
  await set('cloudinary_cloud_name', 'acme-cloud', 1);
  await set('cloudinary_api_key', 'acme-key', 1);
  await set('cloudinary_api_secret', 'acme-secret', 1);
  await set('cloudinary_cloud_name', '', 3);
  await set('cloudinary_api_key', '   ', 3);

  console.log('\n── The reported failure ─────────────────────────────────────────');

  invalidateCredsCache();
  {
    const c = await resolveCredentials(sequelize, 2);
    check('A company with NO credentials inherits the platform-wide ones',
      c.cloud_name === 'platform-cloud' && c.api_key === 'platform-key' && c.api_secret === 'platform-secret',
      `${c.cloud_name} — this is the case that reported "not configured"`);
  }
  {
    const c = await resolveCredentials(sequelize, 3);
    check('A company that saved BLANKS also inherits them',
      c.cloud_name === 'platform-cloud' && c.api_key === 'platform-key',
      `${c.cloud_name}/${c.api_key} — an empty setting is not a credential`);
  }

  console.log('\n── A company\'s own credentials still win ────────────────────────');

  {
    const c = await resolveCredentials(sequelize, 1);
    check('A company with its own credentials uses them',
      c.cloud_name === 'acme-cloud' && c.api_secret === 'acme-secret', c.cloud_name);
  }

  console.log('\n── The leak nobody reported ─────────────────────────────────────');

  {
    // Deliberately resolved in this order: company 1 first, so its credentials
    // are the ones sitting in any shared cache when company 2 asks.
    invalidateCredsCache();
    await resolveCredentials(sequelize, 1);
    const c = await resolveCredentials(sequelize, 2);
    check('Company 2 never uploads with company 1\'s credentials',
      c.cloud_name !== 'acme-cloud' && c.api_secret !== 'acme-secret',
      `${c.cloud_name} — a single module-global cache meant whoever asked first won`);
  }
  {
    const a = await resolveCredentials(sequelize, 1);
    const b = await resolveCredentials(sequelize, 2);
    check('...and the two companies still get different answers in one process',
      a.cloud_name === 'acme-cloud' && b.cloud_name === 'platform-cloud',
      `${a.cloud_name} vs ${b.cloud_name} — the cache is keyed per company`);
  }

  console.log('\n── Falling through to the environment ───────────────────────────');

  {
    await sequelize.query('DELETE FROM settings');
    invalidateCredsCache();
    process.env.CLOUDINARY_CLOUD_NAME = 'env-cloud';
    process.env.CLOUDINARY_API_KEY = 'env-key';
    process.env.CLOUDINARY_API_SECRET = 'env-secret';
    const c = await resolveCredentials(sequelize, 2);
    check('With nothing in the database, the environment answers',
      c.cloud_name === 'env-cloud', c.cloud_name);
  }
  {
    // A platform row must beat the environment, or setting it in the UI would
    // appear to do nothing on a deployment that also has the env vars.
    await sequelize.query(
      "INSERT INTO settings (`group`, `key`, `value`, company_id) VALUES ('system','cloudinary_cloud_name','db-cloud',NULL)",
    );
    invalidateCredsCache();
    const c = await resolveCredentials(sequelize, 2);
    check('A value saved in Settings beats the environment variable',
      c.cloud_name === 'db-cloud', c.cloud_name);
  }

  console.log('\n── Results ─────────────────────────────────────────────────────\n');
  console.log(`  ${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass}/${pass + fail} checks passed.\x1b[0m`);

  await sequelize.close();
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();
  console.log(`\n  Scratch database ${DB} dropped.\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\n\x1b[31mThe verification itself failed:\x1b[0m', error);
  process.exit(1);
});

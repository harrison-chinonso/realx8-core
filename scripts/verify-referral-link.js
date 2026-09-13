/**
 * The short referral link: minting it, resolving it, and not breaking the ones
 * already shared.
 *
 * A referral link used to carry a sealed ~200-character token holding the
 * company, the realtor code and a snapshot of the branding. It now carries a
 * seven-character code, and the payload is looked up — read through a cache, so
 * a link opened twenty times in a group chat costs one lookup rather than
 * twenty.
 *
 * Two properties matter more than the shortening itself, and both are easy to
 * get wrong:
 *
 *   a realtor must get the SAME code every time they ask, because they print
 *   it and read it down the phone
 *
 *   every sealed token already sitting in somebody's chat history must still
 *   resolve, because nobody can be asked to re-share them
 *
 * Drives the REAL controller against a throwaway database.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_reflink`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }

// Point the service's models at the scratch database BEFORE anything requires
// them — config/database.js reads this at require time.
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifyreflink';
delete process.env.CACHE_ENABLED;

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

/** Calls an express handler and captures what it answered. */
const call = async (handler, req) => {
  let status = 200; let body = null;
  const res = {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
    set() { return this; },
  };
  await handler({ query: {}, params: {}, body: {}, ...req }, res, (error) => { throw error; });
  return { status, body: body?.data ?? body, raw: body };
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

  const { sequelize, ReferralLink } = require('../services/user-service/src/models');
  const { sealShareToken } = require('../shared/src/shareLink');
  const { cache } = require('../shared/src/cache');

  // Only the tables this feature touches, in the shape the models expect.
  await sequelize.query(`CREATE TABLE companies (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120),
    referral_code VARCHAR(5), status VARCHAR(20) DEFAULT 'active',
    created_at DATETIME NULL DEFAULT NULL, updated_at DATETIME NULL DEFAULT NULL)`);
  await sequelize.query(`CREATE TABLE users (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120), type VARCHAR(32),
    realtor_code VARCHAR(5), company_id INT UNSIGNED, deleted_at DATETIME NULL,
    created_at DATETIME NULL DEFAULT NULL, updated_at DATETIME NULL DEFAULT NULL)`);
  await sequelize.query(`CREATE TABLE settings (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, \`group\` VARCHAR(64),
    \`key\` VARCHAR(64), \`value\` TEXT, company_id INT UNSIGNED NULL,
    created_at DATETIME NULL DEFAULT NULL, updated_at DATETIME NULL DEFAULT NULL)`);
  await ReferralLink.sync({ force: true });

  await sequelize.query(
    "INSERT INTO companies (id, name, referral_code) VALUES (1, 'Acme Homes', 'VG3G4'), (2, 'Rival Ltd', 'ZZ9Z9')",
  );
  await sequelize.query(
    "INSERT INTO users (id, name, type, realtor_code, company_id) VALUES (10, 'Chinonso', 'realtor', 'T25MU', 1), (11, 'Rival Realtor', 'realtor', 'R9999', 2)",
  );
  await sequelize.query(
    "INSERT INTO settings (`group`, `key`, `value`, company_id) VALUES ('appearance', 'app_name', 'Acme Homes', 1), ('appearance', 'primary_color', '#0F172A', 1)",
  );

  const controller = require('../services/user-service/src/controllers/shareLinkController');
  const asRealtor = { user: { id: 10, type: 'realtor', effectiveType: 'realtor', company_id: 1 } };
  const asAdmin = { user: { id: 12, type: 'admin', effectiveType: 'admin', company_id: 1 } };

  console.log('\n── The link is short ────────────────────────────────────────────');

  const minted = await call(controller.createShareToken, asRealtor);
  const code = minted.body?.code;
  check('A realtor gets a short code', Boolean(code) && code.length === 7, `code=${code}`);
  check('...drawn from an unambiguous alphabet',
    /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]+$/.test(code || ''),
    'no 0/O and no 1/I/L — these get read aloud and retyped');

  const shortUrl = `https://app.example.com/register?ref=${code}`;
  const longUrl = `https://app.example.com/register?ref=${minted.body?.token}`;
  check('The URL is dramatically shorter than the sealed one',
    shortUrl.length < 60 && longUrl.length > 150,
    `${shortUrl.length} characters vs ${longUrl.length}`);

  console.log('\n── The same realtor always gets the same code ───────────────────');

  const again = await call(controller.createShareToken, asRealtor);
  check('Asking twice returns the identical code', again.body?.code === code,
    `${again.body?.code} — they print it and read it down the phone`);

  const burst = await Promise.all(Array.from({ length: 8 }, () => call(controller.createShareToken, asRealtor)));
  const codes = new Set(burst.map((r) => r.body?.code));
  check('Eight simultaneous requests still produce ONE code', codes.size === 1,
    `${codes.size} distinct — the unique index decides, not the lookup`);

  const adminMint = await call(controller.createShareToken, asAdmin);
  check('A company admin gets a DIFFERENT code, carrying no realtor',
    adminMint.body?.code && adminMint.body.code !== code && adminMint.body.realtor_code === null,
    `company link=${adminMint.body?.code}`);

  console.log('\n── Resolving it carries everything the long token did ───────────');

  const resolved = await call(controller.resolveShareToken, { params: { token: code } });
  check('The company comes back', resolved.body?.company?.name === 'Acme Homes', resolved.body?.company?.name);
  check('The company sign-up code comes back',
    resolved.body?.company?.code === 'VG3G4', resolved.body?.company?.code);
  check('The realtor attribution comes back',
    resolved.body?.realtor?.code === 'T25MU' && resolved.body?.realtor?.name === 'Chinonso',
    JSON.stringify(resolved.body?.realtor));
  check('The company customisation comes back',
    resolved.body?.branding?.app_name === 'Acme Homes'
    && resolved.body?.branding?.primary_color === '#0F172A',
    JSON.stringify(resolved.body?.branding));

  check('Lower case resolves too, since people retype these',
    (await call(controller.resolveShareToken, { params: { token: code.toLowerCase() } }))
      .body?.realtor?.code === 'T25MU');

  console.log('\n── Resolution is cached, so a group chat costs one lookup ───────');

  {
    let queries = 0;
    const countingHook = () => { queries += 1; };
    sequelize.addHook('beforeQuery', countingHook);

    await call(controller.resolveShareToken, { params: { token: code } });
    const cached = queries;
    await call(controller.resolveShareToken, { params: { token: code } });
    await call(controller.resolveShareToken, { params: { token: code } });
    const after = queries;
    sequelize.removeHook('beforeQuery', countingHook);

    check('Repeat opens of the same link cost no further queries',
      after === cached, `${after - cached} queries added across two more opens`);
  }

  console.log('\n── Links already shared must keep working ───────────────────────');

  {
    const legacy = sealShareToken({ ci: 1, cc: 'VG3G4', rc: 'T25MU', b: { app_name: 'Old Snapshot' } });
    const out = await call(controller.resolveShareToken, { params: { token: legacy } });
    check('A sealed token from before this change still resolves',
      out.body?.realtor?.code === 'T25MU' && out.body?.company?.name === 'Acme Homes',
      'they sit in chat histories with no expiry and cannot be re-shared');
    check('...and live branding still wins over its stale snapshot',
      out.body?.branding?.app_name === 'Acme Homes',
      `${out.body?.branding?.app_name} — a rebrand must reach links already out there`);
  }

  console.log('\n── A shared PROPERTY is a code from the same namespace ──────────');

  {
    /**
     * A property link used to be `/p/<48 hex characters>?ref=<code>`: two
     * identifiers, one of them long. It is now one code out of this same table,
     * so the checks that matter are that it does not collide with the sign-up
     * links, and that resolving it still names who shared it.
     */
    const { mintShareCode } = require('../shared/src/shareLinkGateway');

    const companyProperty = await mintShareCode(sequelize, { companyId: 1, propertyId: 7 });
    const realtorProperty = await mintShareCode(sequelize, {
      companyId: 1, realtorCode: 'T25MU', propertyId: 7,
    });

    check("A realtor's link to a property is its own code",
      Boolean(realtorProperty) && realtorProperty.length === 7
        && realtorProperty !== companyProperty,
      `realtor=${realtorProperty} company=${companyProperty}`);

    check("...and is not the realtor's SIGN-UP code",
      realtorProperty !== code,
      'the old uniqueness key could not tell these two rows apart');

    check('Asking twice returns the identical property code',
      (await mintShareCode(sequelize, { companyId: 1, realtorCode: 'T25MU', propertyId: 7 }))
        === realtorProperty,
      'realtors share the same link repeatedly, and it must not change under them');

    const concurrent = new Set(await Promise.all(Array.from({ length: 8 }, () => mintShareCode(
      sequelize, { companyId: 1, realtorCode: 'T25MU', propertyId: 9 },
    ))));
    check('Eight simultaneous property shares still produce ONE code',
      concurrent.size === 1, `${concurrent.size} distinct`);

    const differentProperty = await mintShareCode(sequelize, {
      companyId: 1, realtorCode: 'T25MU', propertyId: 8,
    });
    check('A second property gets a second code',
      differentProperty !== realtorProperty,
      `property 7=${realtorProperty} property 8=${differentProperty}`);

    /**
     * The same resolver answers for both kinds of code. That is what lets the
     * sign-up page a buyer is sent to brand itself from the property link they
     * arrived on, with no second identifier in the URL.
     */
    const resolvedProperty = await call(controller.resolveShareToken,
      { params: { token: realtorProperty } });
    check('The property code resolves to the company that shared it',
      resolvedProperty.body?.company?.code === 'VG3G4', resolvedProperty.body?.company?.name);
    check('...to the realtor who shared it',
      resolvedProperty.body?.realtor?.code === 'T25MU',
      JSON.stringify(resolvedProperty.body?.realtor));
    check('...and says which property, so the buyer can be sent back to it',
      resolvedProperty.body?.property_id === 7, String(resolvedProperty.body?.property_id));

    const resolvedSignup = await call(controller.resolveShareToken, { params: { token: code } });
    check('A sign-up code still names no property',
      resolvedSignup.body?.property_id === null,
      'a code for the whole company must not be read as a link to one listing');
  }

  console.log('\n── What must NOT resolve ────────────────────────────────────────');

  check('An unknown code is refused',
    (await call(controller.resolveShareToken, { params: { token: 'ZZZZZZZ' } })).status === 404);
  check('A tampered sealed token is refused',
    (await call(controller.resolveShareToken, { params: { token: 'not-a-real-token-at-all' } })).status === 404);

  {
    await ReferralLink.update({ revoked_at: new Date() }, { where: { code } });
    await cache.delByPrefix('');
    const out = await call(controller.resolveShareToken, { params: { token: code } });
    check('A revoked link stops resolving', out.status === 404,
      'the row is kept, so the code can never be handed to a different realtor');
    await ReferralLink.update({ revoked_at: null }, { where: { code } });
    await cache.delByPrefix('');
  }

  {
    await sequelize.query("UPDATE companies SET status = 'suspended' WHERE id = 1");
    await cache.delByPrefix('');
    const out = await call(controller.resolveShareToken, { params: { token: code } });
    check("A suspended company's links stop resolving", out.status === 404);
    await sequelize.query("UPDATE companies SET status = 'active' WHERE id = 1");
    await cache.delByPrefix('');
  }

  {
    // Attribution is re-checked on every open, exactly as the sealed token was.
    await sequelize.query('UPDATE users SET deleted_at = NOW() WHERE id = 10');
    await cache.delByPrefix('');
    const out = await call(controller.resolveShareToken, { params: { token: code } });
    check('A realtor who has left stops collecting attribution',
      out.status === 200 && out.body?.realtor === null,
      'the link still works for the company; only the attribution drops');
    await sequelize.query('UPDATE users SET deleted_at = NULL WHERE id = 10');
    await cache.delByPrefix('');
  }

  console.log('\n── Results ─────────────────────────────────────────────────────\n');
  console.log(`  ${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass}/${pass + fail} checks passed.\x1b[0m`);

  await cache.delByPrefix('');
  await sequelize.close();
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();
  console.log(`\n  Scratch database ${DB} dropped.\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\n\x1b[31mThe verification itself failed:\x1b[0m', error);
  process.exit(1);
});

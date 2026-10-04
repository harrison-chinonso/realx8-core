/**
 * Sign in with Apple from the iOS app — against a real database.
 *
 * The identity token is signed here with a test key standing in for Apple's
 * (the verification itself is unit-tested in test/mobile/appleIdentity.test.js);
 * what this asserts is everything after it: finding or creating the account,
 * the company choice, the company pin, and the handoff the app redeems.
 *
 * Kept from the company-pin script it was copied from:
 *
 * Realx8-Mobile's white-label builds send `company_code` when signing in
 * (shared/src/companyPin.js). This asserts the whole chain the pin has to
 * survive, because each link is a place it could silently fall off:
 *
 *   sign-in → access token → refresh token → refresh → switch / join / list
 *
 * A pin that held at sign-in but was forgotten at the first hourly refresh
 * would look correct in every manual test and be gone by lunchtime.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_apple_signin`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifyapplesignin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'verify-apple-signin-secret';

/*
 * A Sign in with Apple key, generated, and Apple's two REST endpoints stubbed
 * (the real calls are unit-tested in test/mobile/appleTokens.test.js). What is
 * recorded here is WHAT this backend tells Apple, and WHEN.
 */
const appleKey = require('crypto').generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
process.env.APPLE_TEAM_ID = 'TEAM123456';
process.env.APPLE_SIGNIN_KEY_ID = 'KEY1234567';
process.env.APPLE_SIGNIN_KEY = appleKey.export({ type: 'pkcs8', format: 'pem' });
const appleCalls = [];
global.fetch = async (url, init) => {
  const body = Object.fromEntries(new URLSearchParams(String(init?.body || '')));
  appleCalls.push({ url: String(url), body });
  if (String(url).endsWith('/auth/token')) {
    return { ok: true, status: 200, json: async () => ({ refresh_token: `refresh-for-${body.code}` }) };
  }
  if (String(url).endsWith('/auth/revoke')) return { ok: true, status: 200, json: async () => ({}) };
  throw new Error(`unexpected fetch: ${url}`);
};
const revokes = () => appleCalls.filter((call) => call.url.endsWith('/auth/revoke')).map((call) => call.body.token);

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

/** An express handler, called without express. */
const call = async (handler, { body = {}, user = null, query = {}, params = {} } = {}) => {
  let status = 200; let payload = null;
  const res = {
    status: (code) => { status = code; return res; },
    json: (value) => { payload = value; return res; },
    redirect: () => res,
    set: () => res,
  };
  await handler({ body, user, query, params, headers: {}, audit: () => {} }, res, (error) => { throw error; });
  return { status, body: payload };
};

/** What verifyToken would put on req.user for this access token. */
const asUser = (accessToken) => {
  const payload = jwt.verify(accessToken, process.env.JWT_SECRET);
  return { ...payload, company_id: payload.company_id ?? null };
};

const PASSWORD = 'CorrectHorse9!';

(async () => {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  const models = require('../services/user-service/src/models');
  const { sequelize } = models;

  await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const name of ['Company', 'RealtorLevel', 'User', 'UserProfile', 'Role', 'Permission', 'UserRole', 'RolePermission', 'Setting']) {
    if (models[name]) await models[name].sync({ force: true });
  }
  const authModels = require('../services/auth-service/src/models');
  await authModels.RefreshToken.sync({ force: true });
  await authModels.PasswordReset.sync({ force: true });
  await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
  await require('../services/user-service/src/migrations/emailUniquePerCompany')(sequelize);
  await require('../services/auth-service/src/migrations/createAppleCredentials')(sequelize);
  // What deletion checks first; empty, so nothing blocks it.
  await sequelize.query('CREATE TABLE invoices (id INT PRIMARY KEY, client_id INT, company_id INT, status VARCHAR(30))');
  await sequelize.query('CREATE TABLE commissions (id INT PRIMARY KEY, employee_id INT, company_id INT, status VARCHAR(30))');

  await models.Company.bulkCreate([
    { id: 1, name: 'Alpha Estates', slug: 'alpha', email: 'a@test', referral_code: 'ALPH1', status: 'active' },
    { id: 2, name: 'Beta Homes', slug: 'beta', email: 'b@test', referral_code: 'BETA2', status: 'active' },
    { id: 4, name: 'Delta Realty', slug: 'delta', email: 'd@test', referral_code: 'DELT4', status: 'active' },
  ]);
  await models.Role.bulkCreate([
    { id: 1, name: 'realtor', display_name: 'Realtor', guard_name: 'api' },
    { id: 2, name: 'client', display_name: 'Client', guard_name: 'api' },
  ]);

  const hash = await bcrypt.hash(PASSWORD, 10);
  const mk = async (fields) => (await models.User.create({ password: hash, is_active: true, ...fields })).id;
  const alphaId = await mk({ name: 'Ada Realtor', email: 'ada@example.test', type: 'realtor', company_id: 1 });
  const betaId = await mk({ name: 'Ada Realtor', email: 'ada@example.test', type: 'realtor', company_id: 2 });
  await sequelize.query('INSERT INTO user_roles (user_id, role_id) VALUES (:a, 1), (:b, 1)', {
    replacements: { a: alphaId, b: betaId },
  });

  const auth = require('../services/auth-service/src/controllers/authController');
  const sessionRegistry = require('../shared/src/sessionRegistry');
  const clearSessions = async () => {
    await Promise.all([alphaId, betaId].map((id) => sessionRegistry.endSession(id).catch(() => {})));
    await authModels.RefreshToken.destroy({ where: {} });
  };

  const { setAppleKeysForTesting, APPLE_ISSUER } = require('../shared/src/appleIdentity');
  const { redeemHandoff } = require('../shared/src/oauthHandoff');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  setAppleKeysForTesting([{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }]);

  /** What the iOS app does: an Apple token, a nonce, and a PKCE pair. */
  const appleSignIn = async ({ sub, email, body = {}, code = `code-${sub}-${appleCalls.length}` }) => {
    const rawNonce = crypto.randomBytes(16).toString('hex');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const token = jwt.sign({
      sub, email, email_verified: 'true', nonce: crypto.createHash('sha256').update(rawNonce).digest('hex'),
    }, privateKey, { algorithm: 'RS256', keyid: 'k1', issuer: APPLE_ISSUER, audience: 'com.realx8.app', expiresIn: '5m' });
    const response = await call(auth.appleNativeSignIn, {
      body: {
        identity_token: token,
        authorization_code: code,
        nonce: rawNonce,
        native_challenge: crypto.createHash('sha256').update(verifier).digest('hex'),
        ...body,
      },
    });
    const params = response.body?.handoff
      ? Object.fromEntries(new URLSearchParams(await redeemHandoff(response.body.handoff, verifier)))
      : null;
    return { response, params };
  };

  // Field names only: the values are live tokens, even in a scratch database.
  const brief = (params) => (params ? Object.keys(params).join(', ') : 'nothing');

  console.log('\n── A new person ─────────────────────────────────────────────────');
  {
    await clearSessions();
    const first = await appleSignIn({
      sub: 'apple.new.1', email: 'newbie@privaterelay.appleid.com',
      body: { company_code: 'BETA2', full_name: { givenName: 'Nia', familyName: 'Okafor' } },
    });
    check('The app gets a handoff code, not a session', first.response.status === 200 && !!first.response.body?.handoff
      && !first.response.body.accessToken, brief(first.response.body));
    check('...which redeems to a signed-in session', !!first.params?.token, brief(first.params));
    const created = await models.User.findOne({ where: { apple_id: 'apple.new.1' } });
    check('A client account is created at the company named', created?.company_id === 2 && created?.type === 'client', '');
    check('...with the name Apple gave the app', created?.name === 'Nia Okafor', created?.name);

    await clearSessions();
    const again = await appleSignIn({ sub: 'apple.new.1', email: 'newbie@privaterelay.appleid.com' });
    check('Signing in again finds the same account — no code needed',
      !!again.params?.token && asUser(again.params.token).id === created.id, brief(again.params));
    check('...and creates nothing', await models.User.count({ where: { apple_id: 'apple.new.1' } }) === 1, '');

    const orphan = await appleSignIn({ sub: 'apple.new.2', email: 'nobody@example.test' });
    check('A new person with no company code is told what is missing',
      !!orphan.params?.error && !orphan.params.token, JSON.stringify(orphan.params));
  }

  console.log('\n── Somebody who already has accounts ────────────────────────────');
  {
    await clearSessions();
    const both = await appleSignIn({ sub: 'apple.ada', email: 'ada@example.test' });
    check('Two companies on her address: she is asked which', !!both.params?.company_token, brief(both.params));

    await clearSessions();
    const pinned = await appleSignIn({ sub: 'apple.ada', email: 'ada@example.test', body: { pin_company_code: 'ALPH1' } });
    check('From a branded app she lands in its company', !!pinned.params?.token
      && asUser(pinned.params.token).company_id === 1, brief(pinned.params));
    check('...with the session pinned', asUser(pinned.params.token).pinnedCompanyId === 1, '');
  }

  console.log('\n── Refusals ─────────────────────────────────────────────────────');
  {
    const noChallenge = await call(auth.appleNativeSignIn, { body: { identity_token: 'x', nonce: 'y' } });
    check('No PKCE challenge: refused before anything else', noChallenge.status === 400, '');

    const forged = await call(auth.appleNativeSignIn, {
      body: { identity_token: 'not.a.token', nonce: 'y', native_challenge: 'a'.repeat(64) },
    });
    check('A token that does not verify signs nobody in', forged.status === 401 && !forged.body?.handoff, '');

    const { response } = await appleSignIn({ sub: 'apple.ada', email: 'ada@example.test', body: { company_code: 'BETA2' } });
    const stolen = await redeemHandoff(response.body.handoff, 'a-guess');
    check('A stolen handoff code is worthless without the verifier', stolen === null, '');
  }

  console.log('\n── Deleting the account revokes Apple (App Review 5.1.1(v)) ─────');
  {
    const stored = await sequelize.query('SELECT apple_sub, client_id, email, refresh_token FROM apple_credentials ORDER BY id',
      { type: require('sequelize').QueryTypes.SELECT });
    check('Signing in kept a refresh token for each Apple ID that has an account', stored.length === 2,
      stored.map((row) => row.apple_sub).join(', '));
    check('...for the app Apple issued it to', stored.every((row) => row.client_id === 'com.realx8.app'), '');
    check('...encrypted, never as Apple sent it', stored.every((row) => !row.refresh_token.startsWith('refresh-for-')), '');
    check('No Apple ID without an account here kept one',
      !stored.some((row) => row.apple_sub === 'apple.new.2'), '');

    const deleteAs = async (userId, body) => {
      const row = await models.User.findByPk(userId);
      await clearSessions();
      return call(auth.deleteOwnAccount, { user: { id: row.id, company_id: row.company_id, type: row.type }, body });
    };

    /*
     * Ada: an account at each company, both with passwords she chose. Her
     * Apple sign-ins went through the company choice, so neither row carries
     * the Apple id — her kept token is found by the address instead.
     */
    const alpha = await deleteAs(alphaId, { password: PASSWORD });
    check('Her first account deletes', alpha.status === 200, alpha.body?.message);
    check('Deleting one of two accounts does NOT revoke — Apple still signs her in to the other',
      revokes().length === 0, revokes().join(', '));

    // Her Beta account took the Apple id when she signed in with Beta's code
    // above, so — like a Google-linked one — it confirms by typing DELETE.
    check('Signing in with a company code linked Apple to that account',
      (await models.User.findByPk(betaId)).apple_id === 'apple.ada', '');
    const beta = await deleteAs(betaId, { confirmation: 'DELETE' });
    check('Deleting the last one does', beta.status === 200 && revokes().length === 1,
      `${beta.status} ${beta.body?.message || ''} · revoked: ${revokes().join(', ') || 'nothing'}`);
    check('...with the token kept for her Apple ID', /^refresh-for-code-apple\.ada/.test(revokes()[0] || ''), revokes()[0]);
    check('...and the kept token is gone afterwards',
      !(await sequelize.query("SELECT 1 FROM apple_credentials WHERE apple_sub = 'apple.ada'",
        { type: require('sequelize').QueryTypes.SELECT })).length, '');

    // Nia: created by Apple, so her password is one nobody knows.
    const nia = await models.User.findOne({ where: { apple_id: 'apple.new.1' } });
    const withPassword = await deleteAs(nia.id, { password: 'anything' });
    check('An account Apple created is not asked for a password',
      withPassword.status === 400 && /DELETE/.test(withPassword.body?.message || ''), withPassword.body?.message);
    const gone = await deleteAs(nia.id, { confirmation: 'DELETE' });
    check('A person with one account is revoked on deleting it',
      gone.status === 200 && revokes().length === 2 && /apple\.new\.1/.test(revokes()[1]), revokes().join(', '));
  }

  console.log(`\n  ${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);

  await clearSessions().catch(() => {});
  await sequelize.close();
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(1); });

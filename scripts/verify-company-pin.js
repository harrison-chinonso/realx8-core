/**
 * A branded mobile app's session stays in its company — against a real database.
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
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_company_pin`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifycompanypin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'verify-company-pin-secret';

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
  const ada = { identifier: 'ada@example.test', password: PASSWORD };

  console.log('\n── Signing in from a branded app ────────────────────────────────');
  let pinned;
  {
    await clearSessions();
    const open = await call(auth.login, { body: ada });
    check('Without a company code she is asked which company', open.body?.requires_company === true, '');

    await clearSessions();
    pinned = await call(auth.login, { body: { ...ada, company_code: 'ALPH1' } });
    check('With one she lands straight in it',
      pinned.status === 200 && pinned.body?.user?.company_id === 1, JSON.stringify(pinned.body?.message || ''));
    check('...and the access token carries the pin', asUser(pinned.body.accessToken).pinnedCompanyId === 1, '');
    check('...and the refresh token stores it',
      (await authModels.RefreshToken.findOne({ where: { token: pinned.body.refreshToken } }))?.pinned_company_id === 1, '');
    check('The company list offers only that company',
      pinned.body?.companies?.length === 1 && pinned.body.companies[0].company_id === 1,
      JSON.stringify(pinned.body?.companies?.map((c) => c.company_id)));
    check('...and joining another is not offered', pinned.body?.multi_company_signups === false, '');
    check('Only that company is proved, so nothing else is reachable without a password',
      JSON.stringify(asUser(pinned.body.accessToken).openedAccounts) === JSON.stringify([alphaId]), '');

    await clearSessions();
    const elsewhere = await call(auth.login, { body: { ...ada, company_code: 'DELT4' } });
    check('A company she has no account with is refused by name',
      elsewhere.status === 403 && elsewhere.body?.reason === 'company_pinned', elsewhere.body?.message);

    const unknown = await call(auth.login, { body: { ...ada, company_code: 'NOPE9' } });
    check('An unknown company code is refused, not ignored',
      unknown.status === 403 && unknown.body?.reason === 'company_unavailable', unknown.body?.message);

    const wrongPassword = await call(auth.login, { body: { ...ada, password: 'nope', company_code: 'ALPH1' } });
    check('A wrong password is still just a wrong password', wrongPassword.status === 401, '');
  }

  console.log('\n── The company picker ───────────────────────────────────────────');
  {
    await clearSessions();
    const open = await call(auth.login, { body: ada });
    const toBeta = await call(auth.loginToCompany, {
      body: { company_token: open.body.company_token, company_id: 2, company_code: 'ALPH1' },
    });
    check('A pinned app cannot pick a different company', toBeta.status === 403, toBeta.body?.message);

    await clearSessions();
    const toAlpha = await call(auth.loginToCompany, {
      body: { company_token: open.body.company_token, company_id: 1, company_code: 'ALPH1' },
    });
    check('...but can pick its own, and the session is pinned',
      toAlpha.status === 200 && asUser(toAlpha.body.accessToken).pinnedCompanyId === 1, '');
  }

  console.log('\n── After sign-in ────────────────────────────────────────────────');
  {
    await clearSessions();
    pinned = await call(auth.login, { body: { ...ada, company_code: 'ALPH1' } });
    const user = asUser(pinned.body.accessToken);

    const switched = await call(auth.switchCompany, { user, body: { company_id: 2, password: PASSWORD } });
    check('Switching to another company is refused — even with the password',
      switched.status === 403 && switched.body?.reason === 'company_pinned', switched.body?.message);
    check('...and nothing changed hands',
      await authModels.RefreshToken.count({ where: { user_id: alphaId } }) === 1
      && await authModels.RefreshToken.count({ where: { user_id: betaId } }) === 0, '');

    const joined = await call(auth.joinCompany, { user, body: { company_code: 'DELT4' } });
    check('Joining another company is refused', joined.status === 403 && joined.body?.reason === 'company_pinned', '');

    const listed = await call(auth.myCompanies, { user });
    check('Listing companies shows only the pinned one',
      listed.body?.data?.companies?.length === 1 && listed.body.data.multi_company_signups === false, '');

    const refreshed = await call(auth.refresh, { body: { refreshToken: pinned.body.refreshToken } });
    check('A refresh succeeds', refreshed.status === 200 && !!refreshed.body?.accessToken, refreshed.body?.message);
    check('...and the new access token is still pinned',
      asUser(refreshed.body.accessToken).pinnedCompanyId === 1, '');

    const later = await call(auth.switchCompany, { user: asUser(refreshed.body.accessToken), body: { company_id: 2 } });
    check('...so switching is still refused after the refresh', later.status === 403, '');
  }

  console.log('\n── Signing up from a branded app ────────────────────────────────');
  {
    const signup = (email, body) => call(auth.register, {
      body: { name: 'New Buyer', email, password: 'WhateverIWant1!', role: 'client', ...body },
    });

    const joined = await signup('new1@example.test', { company_code: 'ALPH1', pin_company_code: 'ALPH1' });
    check('Signing up to the app’s own company works',
      joined.status === 201 && joined.body?.user?.company_id === 1, joined.body?.message);
    check('...and the first session is already pinned',
      joined.status === 201 && asUser(joined.body.accessToken).pinnedCompanyId === 1, '');
    check('...with the pin on its refresh token too',
      joined.status === 201
      && (await authModels.RefreshToken.findOne({ where: { token: joined.body.refreshToken } }))?.pinned_company_id === 1, '');

    const other = await signup('new2@example.test', { company_code: 'BETA2', pin_company_code: 'ALPH1' });
    check('Signing up to a different company from it is refused',
      other.status === 403 && other.body?.reason === 'company_pinned', other.body?.message);
    check('...before any account is created',
      await models.User.count({ where: { email: 'new2@example.test' } }) === 0, '');

    const unknown = await signup('new3@example.test', { company_code: 'ALPH1', pin_company_code: 'NOPE9' });
    check('An unknown app company is refused', unknown.status === 403 && unknown.body?.reason === 'company_unavailable', '');

    const web = await signup('new4@example.test', { company_code: 'BETA2' });
    check('A sign-up from the web is not pinned',
      web.status === 201 && asUser(web.body.accessToken).pinnedCompanyId === undefined, web.body?.message);
  }

  console.log('\n── Everyone else is unaffected ──────────────────────────────────');
  {
    await clearSessions();
    const open = await call(auth.login, { body: ada });
    const alpha = await call(auth.loginToCompany, { body: { company_token: open.body.company_token, company_id: 1 } });
    const user = asUser(alpha.body.accessToken);
    check('An ordinary session has no pin', user.pinnedCompanyId === undefined, '');
    check('...lists both companies', alpha.body?.companies?.length === 2, '');

    const moved = await call(auth.switchCompany, { user, body: { company_id: 2 } });
    check('...and switches freely', moved.status === 200 && moved.body?.user?.company_id === 2, moved.body?.message);
  }

  console.log(`\n  ${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);

  await clearSessions().catch(() => {});
  await sequelize.close();
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(1); });

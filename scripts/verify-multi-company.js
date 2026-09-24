/**
 * One person, several companies — against a real database.
 *
 * ── What this is actually guarding ──────────────────────────────────────────
 *
 * Letting an email address exist more than once undoes an assumption that was
 * true everywhere for the life of this codebase. The interesting failures are
 * not "can two rows exist" — that is one index — but the three that follow
 * from it, each of which is silent:
 *
 *   1. Signing in lands on the WRONG account. Every scope in the platform is
 *      derived from users.company_id, so an ambiguous lookup that picks by row
 *      order does not error; it shows one company's data to somebody who meant
 *      the other, and looks like a working sign-in.
 *
 *   2. The credential spreads further than the person does. The accounts share
 *      a password, so anything that lets one company set or choose it — an
 *      admin's password field, a registration that accepts any password on an
 *      address already in use — is a cross-tenant account takeover carried out
 *      with an ordinary feature.
 *
 *   3. Switching company leaves the old session alive, which quietly breaks
 *      the one-live-session rule and leaves a working refresh token for a
 *      company the person believes they have left.
 *
 * All three are asserted here against the real controllers, because each of
 * them is a rule that only exists if the code that runs actually applies it.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const bcrypt = require('bcryptjs');
const { QueryTypes } = require('sequelize');
const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_multi_company`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifymulticompany';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'verify-multi-company-secret';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

/** An express handler, called without express. */
const call = async (handler, { body = {}, user = null, query = {}, params = {} } = {}) => {
  let status = 200; let payload = null; let redirect = null;
  const res = {
    status: (code) => { status = code; return res; },
    json: (value) => { payload = value; return res; },
    redirect: (url) => { redirect = url; return res; },
    set: () => res,
  };
  await handler(
    { body, user, query, params, headers: {}, audit: () => {} },
    res,
    (error) => { throw error; },
  );
  return { status, body: payload, redirect };
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

  // The uniqueness rule under test comes from a migration, not from sync.
  await require('../services/user-service/src/migrations/emailUniquePerCompany')(sequelize);

  await models.Company.bulkCreate([
    { id: 1, name: 'Alpha Estates', slug: 'alpha', email: 'a@test', referral_code: 'ALPH1', status: 'active' },
    { id: 2, name: 'Beta Homes', slug: 'beta', email: 'b@test', referral_code: 'BETA2', status: 'active' },
    { id: 3, name: 'Gone Ltd', slug: 'gone', email: 'g@test', referral_code: 'GONE3', status: 'suspended' },
    { id: 4, name: 'Delta Realty', slug: 'delta', email: 'd@test', referral_code: 'DELT4', status: 'active' },
  ]);
  await models.Role.bulkCreate([
    { id: 1, name: 'realtor', display_name: 'Realtor', guard_name: 'api' },
    { id: 2, name: 'client', display_name: 'Client', guard_name: 'api' },
    { id: 3, name: 'super_admin', display_name: 'Super Admin', guard_name: 'api' },
  ]);

  const hash = await bcrypt.hash(PASSWORD, 10);
  const mk = async (fields) => (await models.User.create({ password: hash, is_active: true, ...fields })).id;

  const alphaId = await mk({ name: 'Ada Realtor', email: 'ada@example.test', type: 'realtor', company_id: 1 });
  const betaId = await mk({ name: 'Ada Realtor', email: 'Ada@Example.test', type: 'realtor', company_id: 2 });
  const soloId = await mk({ name: 'Bem Buyer', email: 'bem@example.test', type: 'client', company_id: 1 });
  const staffId = await mk({ name: 'Cyn Admin', email: 'cyn@example.test', type: 'super_admin', company_id: 1 });
  const goneId = await mk({ name: 'Ada Realtor', email: 'ada@example.test', type: 'realtor', company_id: 3 });

  await sequelize.query(
    'INSERT INTO user_roles (user_id, role_id) VALUES (:a, 1), (:b, 1), (:s, 2), (:c, 3), (:g, 1)',
    { replacements: { a: alphaId, b: betaId, s: soloId, c: staffId, g: goneId } },
  );

  const identity = require('../shared/src/emailIdentity');
  const users = require('../services/user-service/src/controllers/userController');
  const auth = require('../services/auth-service/src/controllers/authController');
  const sessionRegistry = require('../shared/src/sessionRegistry');
  const clearSessionsLater = async () => Promise.all(
    [alphaId, betaId, soloId, staffId, goneId].map((id) => sessionRegistry.endSession(id).catch(() => {})),
  );

  console.log('\n── The same address, in two companies ───────────────────────────');
  {
    const rows = await identity.accountsForEmail(sequelize, 'ADA@example.TEST');
    check('Both accounts are found, whatever case is typed', rows.length === 3, `${rows.length} accounts`);
    check('...and they are different companies',
      new Set(rows.map((r) => r.company_id)).size === 3, '');

    let refused = null;
    try {
      await models.User.create({ name: 'Impostor', email: 'ada@example.test', password: hash, type: 'realtor', company_id: 1 });
    } catch (error) { refused = error; }
    check('A second account in the SAME company is refused by the database',
      refused !== null, refused ? refused.name : 'it was allowed');
  }

  console.log('\n── Who may hold more than one account ───────────────────────────');
  {
    const second = await identity.emailAvailability(sequelize, {
      email: 'ada@example.test', companyId: 2, type: 'realtor',
    });
    check('An existing account in that company blocks a new one',
      second.ok === false, second.message);

    const third = await identity.emailAvailability(sequelize, {
      email: 'ada@example.test', companyId: 9, type: 'client',
    });
    check('A company she is not in yet accepts her', third.ok === true && third.joins === true, '');

    const asStaff = await identity.emailAvailability(sequelize, {
      email: 'ada@example.test', companyId: 9, type: 'super_admin',
    });
    check('...but not as staff — staff belong to one company', asStaff.ok === false, asStaff.message);

    const ontoStaff = await identity.emailAvailability(sequelize, {
      email: 'cyn@example.test', companyId: 2, type: 'realtor',
    });
    check("An administrator's address cannot be claimed by another company",
      ontoStaff.ok === false, ontoStaff.message);

    const fresh = await identity.emailAvailability(sequelize, {
      email: 'new@example.test', companyId: 1, type: 'client',
    });
    check('An unused address is simply free', fresh.ok === true && fresh.joins === false, '');

    /**
     * A REMOVED account still occupies the slot.
     *
     * The unique index is (email, company_id) over every row in the table,
     * soft-deleted included — so a check that skipped removed accounts would
     * answer "free", the INSERT would hit the index, and somebody re-registering
     * where an account had been deleted would get a 500 instead of a sentence.
     */
    const ghostId = await mk({
      name: 'Gone Away', email: 'ghost@example.test', type: 'client', company_id: 1,
    });
    await models.User.update({ deleted_at: new Date() }, { where: { id: ghostId } });

    const afterDelete = await identity.emailAvailability(sequelize, {
      email: 'ghost@example.test', companyId: 1, type: 'client',
    });
    check('A removed account still holds its company slot',
      afterDelete.ok === false, afterDelete.message);
    check('...and says so in a way somebody can act on',
      String(afterDelete.message).includes('removed'), afterDelete.message);

    const elsewhere = await identity.emailAvailability(sequelize, {
      email: 'ghost@example.test', companyId: 2, type: 'client',
    });
    check('...while another company is still open to them', elsewhere.ok === true, elsewhere.message);
  }

  console.log('\n── A password belongs to ONE company account ────────────────────');
  {
    /*
     * The rule the whole feature turns on. Changing a password for one company
     * must not reach the person's accounts elsewhere — doing so would collapse
     * per-company passwords back into one without anybody asking for it.
     */
    const next = await bcrypt.hash('SecondChoice7!', 10);
    const touched = await identity.setAccountPassword(sequelize, betaId, next);
    check('Changing one touches exactly one row', touched === 1, `${touched} rows`);

    const rows = await identity.accountsForEmail(sequelize, 'ada@example.test');
    const beta = rows.find((r) => Number(r.id) === Number(betaId));
    const alpha = rows.find((r) => Number(r.id) === Number(alphaId));
    check('...the one named', await bcrypt.compare('SecondChoice7!', beta.password), '');
    check('...and her other companies keep what they had',
      await bcrypt.compare(PASSWORD, alpha.password), '');

    /*
     * And the sign-in that follows shows the consequence: the password she
     * typed names the companies she is offered. This is the trade — it is
     * intended, and it is why anyone reusing one password sees no change.
     */
    await clearSessionsLater();
    const partial = await call(auth.login, { body: { identifier: 'ada@example.test', password: PASSWORD } });
    check('Signing in with one password offers only what it opens',
      (partial.body?.companies || []).length === 2,
      (partial.body?.companies || []).map((c) => c.company_name).join(', '));

    // Put it back, so the checks below read as one password everywhere.
    await identity.setAccountPassword(sequelize, betaId, hash);
  }

  console.log('\n── The edge lets the right half of a sign-in through ────────────');
  {
    /*
     * Not a detail. The company step runs BEFORE a session exists, so the
     * gateway's session check refuses it unless it is listed — and the refusal
     * is "Missing bearer token" on the one screen where nobody can have one.
     * The route guard verifier does not see this list, so it is asserted here.
     */
    const { PUBLIC_PATHS } = require('../platform/edge');
    check('/auth/login/company is reachable without a session',
      PUBLIC_PATHS.includes('/auth/login/company'), '');
    check('...while joining a company still requires one',
      !PUBLIC_PATHS.includes('/auth/companies/join'), '');
    check('...and so does switching',
      !PUBLIC_PATHS.includes('/auth/switch-company'), '');
  }

  console.log('\n── Signing in ───────────────────────────────────────────────────');
  const clearSessions = clearSessionsLater;

  let companyToken = null;
  {
    await clearSessions();
    const one = await call(auth.login, { body: { identifier: 'bem@example.test', password: PASSWORD } });
    check('One company is still one step', one.status === 200 && !!one.body?.accessToken, '');
    check('...and it lands in that company', one.body?.user?.company_id === 1, String(one.body?.user?.company_id));
    check('...and the switcher names that one company, so a second can be joined',
      (one.body?.companies || []).length === 1, '');

    await clearSessions();
    const many = await call(auth.login, { body: { identifier: 'ada@example.test', password: PASSWORD } });
    check('Several companies asks which one', many.body?.requires_company === true, '');
    check('...naming them', (many.body?.companies || []).length === 3,
      (many.body?.companies || []).map((c) => c.company_name).join(', '));
    check('...and issuing no session yet', !many.body?.accessToken, '');
    companyToken = many.body?.company_token;

    const wrong = await call(auth.login, { body: { identifier: 'ada@example.test', password: 'not-it' } });
    check('A wrong password names no companies at all',
      wrong.status === 401 && !wrong.body?.companies, JSON.stringify(wrong.body));
  }

  console.log('\n── Choosing which one ───────────────────────────────────────────');
  {
    await clearSessions();
    const beta = await call(auth.loginToCompany, { body: { company_token: companyToken, company_id: 2 } });
    check('The chosen company is the one signed into',
      beta.status === 200 && beta.body?.user?.company_id === 2, String(beta.body?.user?.company_id));
    check('...as the account that belongs to it',
      beta.body?.user?.id === betaId, `${beta.body?.user?.id} vs ${betaId}`);
    check('...and the session carries the switcher',
      (beta.body?.companies || []).length === 3, '');

    await clearSessions();
    const unrelated = await call(auth.loginToCompany, { body: { company_token: companyToken, company_id: 99 } });
    check('A company she has no account with is refused', unrelated.status === 403, unrelated.body?.message);

    const suspended = await call(auth.loginToCompany, { body: { company_token: companyToken, company_id: 3 } });
    check('A suspended company is refused by name',
      suspended.status === 403 && suspended.body?.reason === 'company_suspended', suspended.body?.message);

    const forged = await call(auth.loginToCompany, { body: { company_token: 'not.a.token', company_id: 1 } });
    check('A forged choice token is refused', forged.status === 401, forged.body?.message);

    /**
     * The one that would matter most. A token proves WHICH accounts a password
     * opened; if the company id alone decided, anybody could sign in as
     * whoever happens to hold an account at the company they name.
     */
    const solo = await call(auth.login, { body: { identifier: 'bem@example.test', password: PASSWORD } });
    await clearSessions();
    const stolen = await call(auth.loginToCompany, {
      body: { company_token: companyToken, company_id: 1 },
    });
    check('A choice token cannot reach an account it did not open',
      stolen.body?.user?.id !== soloId, `landed on ${stolen.body?.user?.id}`);
    check('...it reaches only her own account in that company',
      stolen.body?.user?.id === alphaId, `${stolen.body?.user?.id} vs ${alphaId}`);
    void solo;
  }

  console.log('\n── Switching without signing out ────────────────────────────────');
  {
    await clearSessions();
    // The checks above signed in several times over; the counts below are about
    // what THIS switch does, so the slate is wiped first.
    await authModels.RefreshToken.destroy({ where: {}, truncate: true });
    const session = await call(auth.loginToCompany, { body: { company_token: companyToken, company_id: 1 } });
    const token = session.body;
    check('Signing in left a refresh token behind',
      await authModels.RefreshToken.count({ where: { user_id: alphaId } }) === 1,
      String(token?.refreshToken ? 'issued' : 'none'));
    /*
     * The session as the token actually describes it, decoded rather than
     * hand-written — the proven set is the thing under test, and a fixture
     * that simply asserted it would prove nothing about what is issued.
     */
    const claims = require('jsonwebtoken').decode(token.accessToken);
    check('The token names the accounts the password opened',
      Array.isArray(claims?.openedAccounts) && claims.openedAccounts.length === 3,
      JSON.stringify(claims?.openedAccounts));
    const asAlpha = { id: alphaId, company_id: 1, type: 'realtor', openedAccounts: claims.openedAccounts };

    const listed = await call(auth.myCompanies, { user: asAlpha });
    check('She can see her companies', (listed.body?.data?.companies || []).length === 3, '');
    check('...with the current one marked',
      listed.body?.data?.companies?.find((c) => c.current)?.company_id === 1, '');

    const moved = await call(auth.switchCompany, { user: asAlpha, body: { company_id: 2 } });
    check('Switching lands in the other company',
      moved.status === 200 && moved.body?.user?.company_id === 2, String(moved.body?.user?.company_id));
    check('...as the other account', moved.body?.user?.id === betaId, '');
    check('...with a fresh session', !!moved.body?.accessToken && !!moved.body?.refreshToken, '');

    const left = await authModels.RefreshToken.count({ where: { user_id: alphaId } });
    check('The session left behind is gone', left === 0, `${left} refresh token(s) remain`);
    check('...and the new company has one instead',
      await authModels.RefreshToken.count({ where: { user_id: betaId } }) === 1, '');

    await clearSessions();
    const nowhere = await call(auth.switchCompany, { user: asAlpha, body: { company_id: 99 } });
    check('A company she has no account with is refused', nowhere.status === 403, nowhere.body?.message);

    const suspended = await call(auth.switchCompany, { user: asAlpha, body: { company_id: 3 } });
    check('So is a suspended one', suspended.status === 403, suspended.body?.message);

    const staff = await call(auth.switchCompany, {
      user: { id: staffId, company_id: 1, type: 'super_admin' }, body: { company_id: 2 },
    });
    check('Staff cannot switch at all', staff.status === 403, staff.body?.message);

    /*
     * The case per-company passwords create. A session that proved only its own
     * account must not walk into a company whose password it has never seen —
     * otherwise the weakest password opens all of them through a switch and the
     * separation is decoration.
     */
    await clearSessions();
    const unproved = { id: alphaId, company_id: 1, type: 'realtor', openedAccounts: [alphaId] };
    const asked = await call(auth.switchCompany, { user: unproved, body: { company_id: 2 } });
    /*
     * 403, not 401 — the session is fine, it just does not extend here. A 401
     * makes the web client spend a token refresh on a refusal that refreshing
     * cannot fix, and burn the budget that stops a loop signing somebody out.
     */
    check('A company this session never proved asks for its password',
      asked.status === 403 && asked.body?.reason === 'password_required', asked.body?.message);
    check('...naming which company it means',
      String(asked.body?.message).includes('Beta Homes'), asked.body?.message);

    const wrong = await call(auth.switchCompany, {
      user: unproved, body: { company_id: 2, password: 'not-the-one' },
    });
    check('...and refuses the wrong one',
      wrong.status === 403 && wrong.body?.reason === 'password_incorrect', wrong.body?.message);

    await clearSessions();
    const right = await call(auth.switchCompany, {
      user: unproved, body: { company_id: 2, password: PASSWORD },
    });
    check('The right one gets through', right.status === 200 && right.body?.user?.id === betaId,
      right.body?.message || String(right.body?.user?.id));
    check('...and the new session remembers it, so it is not asked twice',
      require('jsonwebtoken').decode(right.body.accessToken)?.openedAccounts?.includes(betaId), '');

    const staffSession = await call(auth.myCompanies, {
      user: { id: staffId, company_id: 1, type: 'super_admin' },
    });
    check('...and are offered no switcher at all',
      (staffSession.body?.data?.companies || []).length === 0, '');
  }

  console.log('\n── Joining a company from inside the app ────────────────────────');
  {
    await clearSessions();
    const asBem = { id: soloId, company_id: 1, type: 'client' };

    const nowhere = await call(auth.joinCompany, { user: asBem, body: { company_code: 'NOPE9' } });
    check('An unknown company code is refused', nowhere.status === 400, nowhere.body?.message);

    const suspended = await call(auth.joinCompany, { user: asBem, body: { company_code: 'GONE3' } });
    check('A suspended company is refused', suspended.status === 400, suspended.body?.message);

    const staff = await call(auth.joinCompany, {
      user: { id: staffId, company_id: 1, type: 'super_admin' }, body: { company_code: 'BETA2' },
    });
    check('Staff cannot join a second company', staff.status === 403, staff.body?.message);

    const asRealtor = await call(auth.joinCompany, {
      user: asBem, body: { company_code: 'DELT4', role: 'realtor' },
    });
    check('A client can open a realtor account with another company',
      asRealtor.status === 201 && asRealtor.body?.data?.company?.id === 4,
      asRealtor.body?.message || asRealtor.body?.data?.company?.name);
    check('...as the role they asked for',
      asRealtor.body?.data?.type === 'realtor', asRealtor.body?.data?.type);
    check('...and the switcher already lists it',
      (asRealtor.body?.data?.companies || []).some((c) => Number(c.company_id) === 4), '');

    /*
     * No password was given, and none may be: the session proved the
     * credential and the accounts on an address share it. A new row with a
     * hash of its own would be the one company their password did not open.
     */
    const joinedRows = await identity.accountsForEmail(sequelize, 'bem@example.test');
    check('The new account carries the password they are signed in with',
      await bcrypt.compare(PASSWORD, joinedRows.find((r) => Number(r.company_id) === 4).password), '');

    const again = await call(auth.joinCompany, { user: asBem, body: { company_code: 'DELT4' } });
    check('Joining the same company twice is refused', again.status === 409, again.body?.message);

    const admin = await call(auth.joinCompany, { user: asBem, body: { company_code: 'DELT4', role: 'admin' } });
    check('...and no role but realtor or client may be asked for',
      admin.status === 400, admin.body?.message);
  }

  console.log('\n── A company that insists on two-factor ─────────────────────────');
  {
    /*
     * Two-factor is a sign-in gate, and a switch is not a sign-in — so without
     * this check somebody who satisfied one company's policy, or no policy at
     * all, would walk into a company that requires it.
     */
    await models.Setting.create({
      key: '2fa_required', value: 'on', group: 'security', company_id: 2,
    });
    await clearSessions();
    const blocked = await call(auth.switchCompany, {
      user: { id: alphaId, company_id: 1, type: 'realtor' }, body: { company_id: 2 },
    });
    check('Switching into it is refused rather than allowed through',
      blocked.status === 409 && blocked.body?.reason === 'two_factor_required',
      blocked.body?.message);
    await models.Setting.destroy({ where: { key: '2fa_required', company_id: 2 } });
  }

  console.log('\n── Registering onto somebody else’s address ─────────────────────');
  {
    await clearSessions();
    const impostor = await call(auth.register, {
      body: {
        company_code: 'BETA2', email: 'cyn@example.test', name: 'Not Cyn',
        password: 'WhateverIWant1!', role: 'client',
      },
    });
    check("An administrator's address cannot be registered against",
      impostor.status === 409, impostor.body?.message);

    const guessing = await call(auth.register, {
      body: {
        company_code: 'ALPH1', email: 'bem@example.test', name: 'Not Bem',
        password: 'WhateverIWant1!', role: 'client',
      },
    });
    check('Nor can an address already used in that company', guessing.status === 409, guessing.body?.message);

    /*
     * The same refusal through the endpoint, where a soft-deleted row is
     * involved — this is the path that used to 500.
     */
    const overGhost = await call(auth.register, {
      body: {
        company_code: 'ALPH1', email: 'ghost@example.test', name: 'Ghost Again',
        password: 'WhateverIWant1!', role: 'client',
      },
    });
    check('Registering over a removed account refuses rather than crashing',
      overGhost.status === 409, `${overGhost.status}: ${overGhost.body?.message}`);

    /*
     * A password of their own, not the one they use elsewhere. Allowed — being
     * unable to recall the password for a company signed up with years ago is
     * a poor reason to refuse somebody a new account.
     */
    await clearSessions();
    const withOwnPassword = await call(auth.register, {
      body: {
        company_code: 'BETA2', email: 'bem@example.test', name: 'Bem Buyer',
        password: 'SomethingElse9!', role: 'client',
      },
    });
    check('A new company may be joined with a password of its own',
      withOwnPassword.status === 201 && withOwnPassword.body?.user?.company_id === 2,
      withOwnPassword.body?.message || String(withOwnPassword.body?.user?.company_id));

    const bem = await identity.accountsForEmail(sequelize, 'bem@example.test');
    const atBeta = bem.find((r) => Number(r.company_id) === 2);
    const atAlpha = bem.find((r) => Number(r.company_id) === 1);
    check('...which opens that company', await bcrypt.compare('SomethingElse9!', atBeta.password), '');
    check('...and not the one they already had',
      !(await bcrypt.compare('SomethingElse9!', atAlpha.password)), '');

    /*
     * And the account it creates reaches no further than itself. This is what
     * makes dropping the password challenge safe: the session it produces
     * proved one account, so the person's other companies still ask.
     */
    const newClaims = require('jsonwebtoken').decode(withOwnPassword.body.accessToken);
    check('The session it produces proves that account alone',
      Array.isArray(newClaims?.openedAccounts) && newClaims.openedAccounts.length === 1
        && !newClaims.openedAccounts.includes(soloId),
      JSON.stringify(newClaims?.openedAccounts));

    await clearSessions();
    const reaching = await call(auth.switchCompany, {
      user: {
        id: withOwnPassword.body.user.id, company_id: 2, type: 'client',
        openedAccounts: newClaims.openedAccounts,
      },
      body: { company_id: 1 },
    });
    check('...so it cannot walk into the company that address already used',
      reaching.status === 403 && reaching.body?.reason === 'password_required',
      reaching.body?.message);
  }

  console.log('\n── A new company is named after itself ──────────────────────────');
  {
    /*
     * Appearance settings fall back to the platform's for anything a company
     * has not set — right for a colour, wrong for a name. A company that never
     * opened that screen issued receipts under the PLATFORM's name, to its own
     * customers, with nothing on the document tying it to whoever they paid.
     */
    const companies = require('../services/user-service/src/controllers/companyController');
    const made = await call(companies.createCompany, {
      user: { id: staffId, type: 'superior_admin', isSuperiorAdmin: true },
      body: {
        name: 'Third Estates', email: 'hello@third.test',
        admin_first_name: 'Tom', admin_last_name: 'Third',
        admin_email: 'tom@third.test',
      },
    });
    const created = made.body?.data?.company || made.body?.data || null;
    check('The company was created', made.status === 201 || !!created,
      made.body?.message || String(made.status));

    const row = created && await models.Setting.findOne({
      where: { key: 'app_name', group: 'appearance', company_id: created.id },
    });
    check('...with its own name as the app name',
      row?.value === 'Third Estates', row?.value ?? 'no row written');

    const { brandForCompany } = require('../shared/src/companySettings');
    const { brand } = created ? await brandForCompany(sequelize, created.id) : { brand: {} };
    check('...so anything it sends is branded as itself',
      brand.name === 'Third Estates', brand.name);
  }

  console.log('\n── The soak switch, held off ───────────────────────────────────');
  {
    /*
     * MULTI_COMPANY_SIGNUPS=off exists to hold the rollback window open across
     * the cutover: the schema and the code ship together, the data stays
     * single-company, and going back stays clean. What has to be true is that
     * every path which could create a second account is closed by it — there
     * are four, and they are closed in ONE place precisely so a fifth cannot
     * be added without inheriting the rule.
     */
    process.env.MULTI_COMPANY_SIGNUPS = 'off';

    const joining = await identity.emailAvailability(sequelize, {
      email: 'ada@example.test', companyId: 9, type: 'realtor',
    });
    check('A second company is refused while it is off',
      joining.ok === false && joining.disabled === true, joining.message);

    await clearSessions();
    const registering = await call(auth.register, {
      body: {
        company_code: 'DELT4', email: 'ada@example.test', name: 'Ada',
        password: 'AnythingAtAll9!', role: 'realtor',
      },
    });
    check('...so is registering on an address that already exists',
      registering.status === 409, registering.body?.message);

    /*
     * Ada, who is not in Delta. Somebody who ALREADY has an account there is
     * refused a step earlier, by the more specific rule — which is the right
     * order, and the wrong fixture for testing this one.
     */
    const joinedInApp = await call(auth.joinCompany, {
      user: { id: alphaId, company_id: 1, type: 'realtor' }, body: { company_code: 'DELT4' },
    });
    check('...and joining from inside the app',
      joinedInApp.status === 409 && joinedInApp.body?.reason === 'multi_company_disabled',
      joinedInApp.body?.message);

    /*
     * A company Ada is not already in, or the same-company rule answers first
     * and this passes for a reason that has nothing to do with the switch.
     */
    const byAdmin = await call(users.create, {
      user: { id: staffId, company_id: 4, type: 'superior_admin', isSuperiorAdmin: true },
      body: {
        name: 'Ada Again', email: 'ada@example.test', password: 'AnythingAtAll9!',
        type: 'client', role: 'client', company_id: 4,
      },
    });
    check('...and an administrator creating one',
      byAdmin.status === 409 && /not switched on/.test(byAdmin.body?.message || ''),
      byAdmin.body?.message);

    /*
     * And the half that must keep working. A soak that also blocked ordinary
     * single-company signup would be an outage, not a safety measure.
     */
    const brandNew = await call(auth.register, {
      body: {
        company_code: 'DELT4', email: 'nobody@example.test', name: 'Nobody Yet',
        password: 'AnythingAtAll9!', role: 'client',
      },
    });
    check('An address nobody uses still registers normally',
      brandNew.status === 201, brandNew.body?.message || 'created');

    await clearSessions();
    const stillIn = await call(auth.login, { body: { identifier: 'ada@example.test', password: PASSWORD } });
    check('...and people who ALREADY have two companies keep both',
      (stillIn.body?.companies || []).length === 3,
      (stillIn.body?.companies || []).map((c) => c.company_name).join(', '));

    /*
     * And the session says so, which is what takes the Join entry out of the
     * switcher rather than leaving a control that refuses when pressed.
     */
    const listed = await call(auth.myCompanies, {
      user: { id: soloId, company_id: 1, type: 'client' },
    });
    check('The session tells the switcher to leave the Join entry out',
      listed.body?.data?.multi_company_signups === false,
      String(listed.body?.data?.multi_company_signups));

    delete process.env.MULTI_COMPANY_SIGNUPS;
    const backOn = await identity.emailAvailability(sequelize, {
      email: 'ada@example.test', companyId: 9, type: 'realtor',
    });
    check('Unsetting it lets a second company through again', backOn.ok === true, '');
  }

  console.log('\n── A person may edit themselves, and only themselves ────────────');
  {
    /*
     * GET and PUT /users/:id were guarded by users.view and users.manage,
     * which no client or realtor holds — so the profile page answered 403 to
     * the very person it describes. It reads and writes its own record now,
     * and the interesting question is what "its own" is allowed to mean.
     */
    const asSelf = { id: soloId, company_id: 1, type: 'client', permissions: [] };

    /*
     * The guard is MIDDLEWARE, so it has to be run as middleware. Calling the
     * controller directly skips it entirely — which is how an earlier version
     * of this check "passed" while proving nothing: the 200 came from the
     * handler, and the guard had never been consulted.
     */
    const { permissionOrSelf } = require('../shared/src/middleware/auth');
    const guard = permissionOrSelf('users.view');
    const guardAllows = async (user, id) => {
      let status = 200; let passed = false;
      const res = { status: (c) => { status = c; return res; }, json: () => res };
      await guard({ user, params: { id: String(id) } }, res, () => { passed = true; });
      return { passed, status };
    };

    const ownGuard = await guardAllows(asSelf, soloId);
    check('The guard lets a client at their own record', ownGuard.passed === true, '');

    const othersGuard = await guardAllows(asSelf, alphaId);
    check('...and refuses them somebody else\'s, in the same company',
      othersGuard.passed === false && othersGuard.status === 403, String(othersGuard.status));

    const staffGuard = await guardAllows(
      { id: staffId, company_id: 1, type: 'super_admin', permissions: ['users.view'] }, alphaId,
    );
    check('...while the permission still opens any of them', staffGuard.passed === true, '');

    const own = await call(users.getOne, { user: asSelf, params: { id: String(soloId) } });
    check('A client can read their own record', own.status === 200, String(own.status));

    const renamed = await call(users.update, {
      user: asSelf, params: { id: String(soloId) }, body: { name: 'Bem Renamed' },
    });
    check('...and change their own name', renamed.status === 200, renamed.body?.message);

    /*
     * The one that matters. `type` is what createAccessToken, requirePermission,
     * requireRoles and buildCompanyScope all branch on — a self-edit honouring
     * it is a platform takeover performed by the account being escalated.
     */
    const escalate = await call(users.update, {
      user: asSelf, params: { id: String(soloId) }, body: { type: 'admin' },
    });
    check('...but cannot promote themselves', escalate.status === 403, escalate.body?.message);
    check('...and the row is untouched',
      (await models.User.findByPk(soloId)).type === 'client', '');

    const grabRoles = await call(users.update, {
      user: asSelf, params: { id: String(soloId) }, body: { roles: ['super_admin'] },
    });
    check('...nor give themselves a role', grabRoles.status === 403, grabRoles.body?.message);

    const moveCompany = await call(users.update, {
      user: asSelf, params: { id: String(soloId) }, body: { company_id: 2 },
    });
    check('...nor move themselves to another company', moveCompany.status === 403, moveCompany.body?.message);


  }

  console.log('\n── An administrator cannot set somebody’s password ──────────────');
  {
    const asAdmin = { id: staffId, company_id: 1, type: 'super_admin', isSuperiorAdmin: false, permissions: ['*'] };

    const attempt = await call(users.update, {
      user: asAdmin, params: { id: String(soloId) }, body: { password: 'IChooseThis1!' },
    });
    check('Setting another user’s password is refused', attempt.status === 403, attempt.body?.message);

    const unchanged = await models.User.findByPk(soloId);
    check('...and it really did not change',
      await bcrypt.compare(PASSWORD, unchanged.password), '');
  }

  console.log(`\n  ${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);

  await sequelize.close();
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(1); });

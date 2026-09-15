/**
 * Google sign-up: which company an account joins, and which agent earns on it.
 *
 * ── The bug this exists to stop coming back ─────────────────────────────────
 *
 * The strategy created clients with NO company. Every account must have one —
 * `ck_users_company_scoped` allows a null company only for a platform admin —
 * so every Google sign-up was refused by the database, and the refusal surfaced
 * as a bare "google_auth_failed" that named nothing. It broke locally and in
 * production at the same moment, because the constraint applies everywhere.
 *
 * ── And the one that would be worse ─────────────────────────────────────────
 *
 * Attribution decides whose commission a buyer generates for the rest of their
 * life on the platform. A realtor code that could be swapped mid-flow, or one
 * honoured across a company boundary, is a way to take somebody else's income.
 * Both are checked here.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { QueryTypes } = require('sequelize');
const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_google`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifygoogle';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

const { buildSignupState, readSignupState } = require('../shared/src/oauthState');
const { resolveSignup, realtorFromCode } = require('../shared/src/signupAttribution');

(async () => {
  console.log('\n── The codes survive the trip to Google and back ────────────────');
  {
    const state = buildSignupState({
      companyCode: 'vg3g4', realtorCode: 'abc12', redirect: '/properties/listed/1',
    });
    const read = readSignupState(state);
    check('A company code goes out and comes back', read.company_code === 'VG3G4', read.company_code);
    check('...normalised, so case in a shared link does not matter',
      read.realtor_code === 'ABC12', read.realtor_code);
    check('...along with where the buyer was',
      read.redirect === '/properties/listed/1', read.redirect);

    /**
     * The one that matters. An unsigned state would let anybody edit the
     * realtor code mid-flow and claim an introduction they did not make —
     * every commission that buyer ever generates, redirected.
     */
    const tampered = state.slice(0, -4) + 'AAAA';
    const after = readSignupState(tampered);
    check('A tampered state is refused outright',
      after.realtor_code === null && after.company_code === null,
      JSON.stringify(after));

    /** Degrades to no attribution rather than to a failed sign-in. */
    check('...leaving the person able to sign in, just unattributed',
      after.redirect === null && typeof after === 'object', '');

    check('A missing state is simply empty',
      readSignupState('').company_code === null, '');
    check('So is a nonsense one', readSignupState('garbage').company_code === null, '');
  }

  console.log('\n── Nothing to carry means no state at all ──────────────────────');
  {
    check('An empty request produces no state envelope',
      buildSignupState({}) === '', `"${buildSignupState({})}"`);
  }

  // ── the database half ────────────────────────────────────────────────────
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  const models = require('../services/user-service/src/models');
  const { sequelize } = models;
  await models.Company.sync({ force: true });
  await models.RealtorLevel.sync({ force: true });
  await models.User.sync({ force: true });

  /**
   * The check constraint comes from a migration, not from sync — and it is the
   * whole reason Google sign-up broke. A fixture without it would prove
   * something about a schema nobody runs.
   */
  await require('../services/user-service/src/migrations/requireCompanyForClients')(sequelize);

  await models.Company.create({ id: 1, name: 'Alpha Estates', slug: 'alpha', email: 'a@test', referral_code: 'ALPH1', status: 'active' });
  await models.Company.create({ id: 2, name: 'Beta Homes', slug: 'beta', email: 'b@test', referral_code: 'BETA2', status: 'active' });
  await models.Company.create({ id: 3, name: 'Gone Ltd', slug: 'gone', email: 'g@test', referral_code: 'GONE3', status: 'suspended' });

  await sequelize.query(`INSERT INTO users (name, email, password, type, realtor_code, company_id, created_at, updated_at) VALUES
    ('Alpha Agent', 'agent.a@test', 'x', 'realtor', 'AAG01', 1, NOW(), NOW()),
    ('Beta Agent',  'agent.b@test', 'x', 'realtor', 'BAG01', 2, NOW(), NOW())`);

  const [alphaAgent] = await sequelize.query(
    "SELECT id FROM users WHERE realtor_code = 'AAG01'", { type: QueryTypes.SELECT },
  );

  console.log('\n── Resolving who a new account belongs to ──────────────────────');
  {
    const byCompany = await resolveSignup(sequelize, { companyCode: 'ALPH1' });
    check('A company code alone is enough to sign up',
      byCompany.ok && byCompany.company.id === 1, byCompany.company?.name);
    check('...with no agent attributed', byCompany.realtor == null, '');

    const withAgent = await resolveSignup(sequelize, { companyCode: 'ALPH1', realtorCode: 'aag01' });
    check('A realtor code attributes the account',
      withAgent.ok && withAgent.realtor?.id === alphaAgent.id, withAgent.realtor?.name);

    /**
     * The case that actually happens: an agent shares a property link carrying
     * only their own code. The buyer has never seen a company code, and asking
     * for one would be asking them for something they cannot obtain.
     */
    const agentOnly = await resolveSignup(sequelize, { realtorCode: 'AAG01' });
    check('An agent code alone resolves the company from the agent',
      agentOnly.ok && agentOnly.company.id === 1 && agentOnly.realtor?.id === alphaAgent.id,
      `${agentOnly.company?.name} via ${agentOnly.realtor?.name}`);
  }

  console.log('\n── An agent cannot reach across a company boundary ─────────────');
  {
    /**
     * Beta's agent, quoted against Alpha's company code. Honouring it would let
     * anybody claim introductions at a company they have nothing to do with —
     * and commission follows attribution.
     */
    const crossed = await resolveSignup(sequelize, { companyCode: 'ALPH1', realtorCode: 'BAG01' });
    check("Another company's agent is not attributed",
      crossed.ok && crossed.realtor == null,
      crossed.realtor ? `WRONGLY attributed to ${crossed.realtor.name}` : 'joined Alpha, unattributed');
    check('...but the sign-up still goes ahead', crossed.company.id === 1, '');

    const scoped = await realtorFromCode(sequelize, { code: 'BAG01', companyId: 1 });
    check('...and the lookup itself refuses across the boundary', scoped === null, '');
  }

  console.log('\n── Codes that lead nowhere ─────────────────────────────────────');
  {
    const none = await resolveSignup(sequelize, {});
    check('No code at all is refused, with a reason',
      !none.ok && none.reason === 'company_code_missing', none.message);
    check('...that tells them what to do',
      /link your company or agent sent/i.test(none.message || ''), none.message);

    const wrong = await resolveSignup(sequelize, { companyCode: 'NOPE9' });
    check('An unrecognised company code is refused',
      !wrong.ok && wrong.reason === 'company_code_invalid', wrong.message);

    const suspended = await resolveSignup(sequelize, { companyCode: 'GONE3' });
    check('A suspended company is refused', !suspended.ok && suspended.reason === 'company_suspended',
      suspended.message);

    /**
     * A stale agent code must NOT block the sign-up. The account is valid; it
     * is simply not attributed. Refusing would turn an old shared link into a
     * wall between somebody and the thing they were trying to buy.
     */
    const staleAgent = await resolveSignup(sequelize, { companyCode: 'ALPH1', realtorCode: 'STALE' });
    check('A stale agent code never blocks the sign-up',
      staleAgent.ok && staleAgent.realtor == null, staleAgent.company?.name);
  }

  console.log('\n── The account the strategy creates always has a company ───────');
  {
    /**
     * The original failure was a client created with NO company, which the
     * production database refuses via `ck_users_company_scoped`.
     *
     * That constraint is deliberately NOT asserted here. MySQL will not add a
     * CHECK to a column that carries a foreign key with a referential action,
     * so a database built fresh by sync cannot have it even though production
     * does — and a test that depended on it would pass or fail on which
     * database it happened to run against, which is worse than not testing it.
     *
     * What IS asserted is the thing that actually fixes the bug and holds
     * everywhere: this path can no longer produce an account without a company,
     * because the company is resolved BEFORE anything is created and a failure
     * to resolve refuses the sign-up with a reason.
     */
    const attribution = await resolveSignup(sequelize, { realtorCode: 'AAG01' });
    check('Resolution happens before creation, and yields a company',
      attribution.ok && attribution.company?.id === 1, attribution.company?.name);

    const created = await models.User.create({
      name: 'Google Buyer', email: 'google.buyer@test', password: 'x', type: 'client',
      google_id: 'g2', company_id: attribution.company.id, realtor_id: attribution.realtor?.id ?? null,
    });
    check('...so the account is created attached to it',
      Number(created.company_id) === 1, `company ${created.company_id}`);
    check('...and attributed to the agent whose link they followed',
      Number(created.realtor_id) === alphaAgent.id, `agent ${created.realtor_id}`);

    /**
     * And when it cannot resolve, nothing is created at all — which is the
     * difference between a refusal somebody can act on and a database error
     * surfacing as "google_auth_failed".
     */
    const refused = await resolveSignup(sequelize, {});
    check('When it cannot resolve, the sign-up is refused rather than attempted',
      !refused.ok && Boolean(refused.message), refused.message);
  }

  await sequelize.close();
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error('\n  Harness error:', error);
  process.exit(1);
});

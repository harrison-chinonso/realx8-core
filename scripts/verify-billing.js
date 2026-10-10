#!/usr/bin/env node
/**
 * `npm run verify:billing` — subscription billing end to end, on MySQL and on
 * Postgres, each in a scratch database created and dropped here (the
 * databases in cred.env are never touched).
 *
 *   trial on creation → user limit → lapse → sign-ups held → renewal releases
 *   the queue up to the limit → upgrade releases the rest → a repeated payment
 *   reference changes nothing → the sweep sends each reminder once.
 *
 * Mail and push are stubbed: nothing leaves the machine.
 *
 * Postgres comes from PG_HOST/PG_PORT/PG_USER/PG_PASSWORD (default the
 * docker container on localhost:5433 used by verify:dialect). Run one engine
 * with `node scripts/verify-billing.js mysql` (or postgres).
 */
const path = require('path');
const { spawnSync } = require('child_process');

require('dotenv').config({ path: process.env.DEMO_ENV_FILE || path.join(__dirname, '..', 'cred.env') });

const engine = process.argv[2];

if (!engine) {
  let failed = false;
  for (const e of ['mysql', 'postgres']) {
    const run = spawnSync(process.execPath, [__filename, e], { stdio: 'inherit', env: process.env });
    if (run.status !== 0) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

const REAL_DB = process.env.DB_NAME || 'realto';
const SCRATCH = `${REAL_DB}_verify_billing`;
if (engine === 'postgres') {
  Object.assign(process.env, {
    DB_DIALECT: 'postgres',
    DB_HOST: process.env.PG_HOST || 'localhost',
    DB_PORT: process.env.PG_PORT || '5433',
    DB_USER: process.env.PG_USER || 'postgres',
    DB_PASSWORD: process.env.PG_PASSWORD || 'postgres',
  });
} else {
  process.env.DB_DIALECT = 'mysql';
}
Object.assign(process.env, {
  BILLING_ENABLED: 'true', REDIS_URL: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', SMS_ENABLED: 'false',
  RUN_SCHEDULED_JOBS: 'off',
});

const { Sequelize } = require('sequelize');

const admin = () => new Sequelize(engine === 'postgres' ? 'postgres' : '', process.env.DB_USER, process.env.DB_PASSWORD, {
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT), dialect: process.env.DB_DIALECT, logging: false,
});

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) pass += 1; else fail += 1;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  [${engine}] ${label}${detail ? `  (${detail})` : ''}`);
};

const main = async () => {
  if (SCRATCH === REAL_DB) throw new Error('scratch database name matches the configured one');
  const a = admin();
  if (engine === 'postgres') {
    await a.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${SCRATCH}'`).catch(() => {});
    await a.query(`DROP DATABASE IF EXISTS "${SCRATCH}"`);
    await a.query(`CREATE DATABASE "${SCRATCH}"`);
  } else {
    await a.query(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
    await a.query(`CREATE DATABASE \`${SCRATCH}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  }
  await a.close();
  process.env.DB_NAME = SCRATCH;

  // No mail, no push: replace the senders before anything loads them.
  const mt = require('../shared/src/mailTransport');
  mt.sendMail = async () => ({ sent: true });

  await require('../services/user-service/src/index.js').bootstrap();
  const models = require('../services/user-service/src/models');
  const { sequelize, Company, User, CompanySubscription } = models;
  const billing = require('../shared/src/billing');
  const service = require('../services/user-service/src/services/billingService');

  const plans = await billing.listPlans(sequelize);
  check('plans are seeded', plans.map((p) => p.code).join(',') === 'starter,professional,enterprise');

  const company = await Company.create({ name: 'Verify Billing Co', slug: 'verify-billing', email: 'vb@example.test', status: 'active' });
  await service.startTrial(company.id);
  let state = await billing.billingState(sequelize, company.id, { fresh: true });
  check('a new company starts a 7-day trial', state.status === 'trialing' && state.userLimit === null);

  // Five members in the company.
  const mk = (i, extra = {}) => User.create({ name: `Member ${i}`, email: `m${i}@example.test`, password: 'x', type: 'client', company_id: company.id, ...extra });
  for (let i = 1; i <= 5; i += 1) await mk(i); // eslint-disable-line no-await-in-loop
  check('trial: no limit', (await billing.canAdmitMember(sequelize, company.id)).admit === true);

  // Shrink Starter to 5 for the test, and put the company on it.
  await models.BillingPlan.update({ user_limit: 5 }, { where: { code: 'starter' } });
  await service.changePlan({ companyId: company.id, planCode: 'starter', interval: 'monthly' });
  let admission = await billing.canAdmitMember(sequelize, company.id);
  check('at the user limit, a new member is held', admission.admit === false && admission.reason === 'limit');

  // Lapse: the period ended 10 days ago.
  const sub = await CompanySubscription.findOne({ where: { company_id: company.id } });
  await sub.update({ current_period_end: new Date(Date.now() - 10 * billing.DAY_MS) });
  await billing.evictBilling(company.id);
  state = await billing.billingState(sequelize, company.id, { fresh: true });
  check('past the grace period the company is lapsed and read-only', state.status === 'lapsed' && state.readOnly === true);
  admission = await billing.canAdmitMember(sequelize, company.id);
  check('a lapsed company holds sign-ups', admission.admit === false && admission.reason === 'lapsed');

  // Three people sign up while lapsed: held.
  for (let i = 6; i <= 8; i += 1) await mk(i, { is_active: false, billing_hold: true }); // eslint-disable-line no-await-in-loop
  check('held accounts do not count as members', await billing.countMembers(sequelize, company.id) === 5);
  check('the queue holds three', await billing.countHeld(sequelize, company.id) === 3);

  // Raise Starter to 7, then renew: two of the three fit.
  await models.BillingPlan.update({ user_limit: 7 }, { where: { code: 'starter' } });
  const renewal = await service.activatePeriod({
    companyId: company.id, planCode: 'starter', interval: 'monthly', amount: 50000, reference: 'VERIFY-REF-1', provider: 'manual',
  });
  state = await billing.billingState(sequelize, company.id, { fresh: true });
  check('renewing makes the company active again', state.status === 'active' && state.readOnly === false);
  check('renewal releases the queue up to the limit', renewal.released.length === 2, `released ${renewal.released.length}`);
  check('the rest stay held', await billing.countHeld(sequelize, company.id) === 1);
  const released = await User.findAll({ where: { id: renewal.released } });
  check('released accounts are active and no longer held', released.every((u) => u.is_active && !u.billing_hold));

  const again = await service.activatePeriod({
    companyId: company.id, planCode: 'starter', interval: 'monthly', amount: 50000, reference: 'VERIFY-REF-1', provider: 'manual',
  });
  check('the same payment reference is recorded once', again.duplicate === true);

  const before = (await CompanySubscription.findOne({ where: { company_id: company.id } })).current_period_end;
  await service.activatePeriod({ companyId: company.id, planCode: 'starter', interval: 'annual', amount: 500000, reference: 'VERIFY-REF-2', provider: 'manual' });
  const after = (await CompanySubscription.findOne({ where: { company_id: company.id } })).current_period_end;
  const months = (new Date(after) - new Date(before)) / (30 * billing.DAY_MS);
  check('an early renewal extends from the current end (nothing lost)', months > 11.5 && months < 12.5, `${months.toFixed(2)} months`);

  const upgrade = await service.changePlan({ companyId: company.id, planCode: 'enterprise', interval: 'annual' });
  check('upgrading releases the rest of the queue', upgrade.released.length === 1 && await billing.countHeld(sequelize, company.id) === 0);

  // The sweep: a trial ending in 3 days gets one reminder, not two.
  const other = await Company.create({ name: 'Sweep Co', slug: 'sweep-co', email: 's@example.test', status: 'active' });
  await CompanySubscription.create({ company_id: other.id, status: 'trialing', trial_ends_at: new Date(Date.now() + 2.5 * billing.DAY_MS) });
  const first = await service.runBillingSweep();
  const second = await service.runBillingSweep();
  const otherSub = await CompanySubscription.findOne({ where: { company_id: other.id } });
  check('the sweep sends a trial reminder once', String(otherSub.last_reminder || '').startsWith('trial:3:') && first.reminded >= 1 && second.reminded === 0,
    `${otherSub.last_reminder}; first ${first.reminded}, second ${second.reminded}`);

  // Existing companies with no subscription get a trial when billing goes live.
  const legacy = await Company.create({ name: 'Legacy Co', slug: 'legacy-co', email: 'l@example.test', status: 'active' });
  await service.prepareBilling(models);
  const legacySub = await CompanySubscription.findOne({ where: { company_id: legacy.id } });
  check('existing companies get a fresh 7-day trial', legacySub?.status === 'trialing'
    && Math.abs(new Date(legacySub.trial_ends_at) - Date.now() - 7 * billing.DAY_MS) < 60 * 1000);

  await sequelize.close();
};

main()
  .catch((error) => { fail += 1; console.error(`[${engine}] ERROR`, error.stack || error.message); })
  .finally(async () => {
    try {
      const a = admin();
      if (engine === 'postgres') {
        await a.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${SCRATCH}'`).catch(() => {});
        await a.query(`DROP DATABASE IF EXISTS "${SCRATCH}"`);
      } else {
        await a.query(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
      }
      await a.close();
    } catch (error) { console.error('cleanup:', error.message); }
    console.log(`\n[${engine}] ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });

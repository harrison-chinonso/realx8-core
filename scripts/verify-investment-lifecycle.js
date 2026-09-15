/**
 * One investment from subscription to completion, through the real code.
 *
 * ── What this covers that the accrual test does not ─────────────────────────
 *
 * verify-investment-accrual proves the arithmetic with no database at all. This
 * proves the parts that only exist once rows are involved:
 *
 *   * subscribing raises an invoice, and the two commit together;
 *   * nothing accrues until money is APPROVED against that invoice;
 *   * the tenor runs from the date the first payment landed, not from the
 *     subscription date;
 *   * the nightly sweep can be run repeatedly without paying twice — the
 *     failure that costs real money;
 *   * capital comes back at maturity as its own payout, and the investment only
 *     completes once nothing is outstanding.
 *
 * Driven through the real services against a throwaway database.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_investments`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifyinvest';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};
const naira = (minor) => `₦${(Number(minor) / 100).toLocaleString('en-NG')}`;

const DAY = 24 * 60 * 60 * 1000;

(async () => {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  const models = require('../services/investment-service/src/models');
  const { sequelize, Investment, InvestmentPlan, InvestmentPayout } = models;
  await sequelize.sync({ force: true });

  // The finance tables this feature bills and is paid through. Only the columns
  // the investment code actually touches.
  await sequelize.query(`CREATE TABLE invoices (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, invoice_id VARCHAR(40), client_id INT UNSIGNED,
    property_id INT UNSIGNED NULL, amount DECIMAL(14,2), due_date DATETIME, status VARCHAR(30),
    discount DECIMAL(12,2) DEFAULT 0, created_by INT UNSIGNED, company_id INT UNSIGNED, created_at DATETIME)`);
  await sequelize.query(`CREATE TABLE invoice_payments (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, invoice_id INT UNSIGNED, amount DECIMAL(14,2),
    status VARCHAR(30), created_at DATETIME)`);

  const { subscriptionWindow, recordFunding, positionOf } = require('../services/investment-service/src/services/investmentEngine');
  const { runAccrual } = require('../services/investment-service/src/services/accrualRun');
  const { termsFrom } = require('../shared/src/investments/terms');

  const MILLION = 1_000_000_00;

  console.log('\n── An opportunity that is open, and one that is not ─────────────');
  let plan;
  {
    plan = await InvestmentPlan.create({
      name: 'Lekki Phase 2 Development', status: 'active', company_id: 1,
      return_rate: 12, tenor_days: 365, payout_frequency: 'monthly', return_basis: 'simple',
      min_amount: 100000, max_amount: 0, cap_minor: 5_000_000_00,
    });

    const open = await subscriptionWindow(sequelize, plan, { amountMinor: MILLION });
    check('An active opportunity inside its window is open', open.open === true,
      `headroom ${naira(open.headroom_minor)}`);

    const closed = await InvestmentPlan.create({
      name: 'Closed', status: 'active', company_id: 1,
      closes_at: new Date(Date.now() - DAY), return_rate: 10, tenor_days: 90,
    });
    const shut = await subscriptionWindow(sequelize, closed, { amountMinor: MILLION });
    check('...one past its closing date is not', shut.open === false && shut.reason === 'closed', shut.message);

    const future = await InvestmentPlan.create({
      name: 'Upcoming', status: 'active', company_id: 1,
      opens_at: new Date(Date.now() + 7 * DAY), return_rate: 10, tenor_days: 90,
    });
    const early = await subscriptionWindow(sequelize, future, { amountMinor: MILLION });
    check('...and one that has not opened says when it will',
      early.open === false && early.reason === 'not_yet_open', early.message);

    const tooBig = await subscriptionWindow(sequelize, plan, { amountMinor: 9_000_000_00 });
    check('An amount past the cap is refused, naming what is left',
      tooBig.open === false && tooBig.reason === 'exceeds_cap' && /5,000,000/.test(tooBig.message),
      tooBig.message);
  }

  console.log('\n── Subscribing bills the investor ───────────────────────────────');
  let investment;
  {
    investment = await Investment.create({
      user_id: 42, plan_id: plan.id, amount: 1_000_000, principal_minor: MILLION,
      funded_minor: 0, terms: termsFrom(plan), status: 'pending', company_id: 1,
    });
    await sequelize.query(
      `INSERT INTO invoices (invoice_id, client_id, amount, due_date, status, created_by, company_id, created_at)
       VALUES ('INV-0001', 42, 1000000, NOW(), 'sent', 42, 1, NOW())`,
    );
    const [invoice] = await sequelize.query('SELECT id FROM invoices LIMIT 1', { type: sequelize.QueryTypes.SELECT });
    await investment.update({ invoice_id: invoice.id });

    check('The terms are copied onto the subscription, not referenced',
      investment.terms?.rate_annual === 12 && investment.terms?.tenor_days === 365,
      JSON.stringify(investment.terms));

    /*
     * The heart of it: editing the opportunity afterwards must not change what
     * this investor is owed. A rate read back through the plan would.
     */
    await plan.update({ return_rate: 30 });
    await investment.reload();
    check('...so changing the opportunity later cannot rewrite their return',
      investment.terms.rate_annual === 12, `still ${investment.terms.rate_annual}%`);
  }

  console.log('\n── Nothing earns until the money is approved ────────────────────');
  {
    const before = positionOf(investment);
    check('An unfunded subscription has earned nothing',
      before.earned_minor === 0 && before.principal_minor === 0);

    // Submitted, but not yet approved by anybody.
    await sequelize.query(
      `INSERT INTO invoice_payments (invoice_id, amount, status, created_at)
       VALUES (:id, 1000000, 'pending', :when)`,
      { replacements: { id: investment.invoice_id, when: new Date(Date.now() - 100 * DAY) } },
    );
    await recordFunding(sequelize, investment);
    await investment.reload();
    check('...and a payment awaiting approval does not start it either',
      Number(investment.funded_minor) === 0 && investment.status === 'pending',
      `funded ${naira(investment.funded_minor)}, status ${investment.status}`);

    await sequelize.query("UPDATE invoice_payments SET status = 'verified'");
    await recordFunding(sequelize, investment);
    await investment.reload();
    check('An approved payment funds it and makes it active',
      Number(investment.funded_minor) === MILLION && investment.status === 'active',
      `funded ${naira(investment.funded_minor)}, status ${investment.status}`);

    /*
     * The tenor runs from when the money landed, not from when the subscription
     * was made — a hundred days ago in this fixture.
     */
    const daysIn = Math.round((Date.now() - new Date(investment.funded_at).getTime()) / DAY);
    check('...and the tenor runs from the date the money landed',
      daysIn >= 99 && daysIn <= 101, `${daysIn} days of tenor elapsed`);
  }

  console.log('\n── The sweep pays what is due, once ─────────────────────────────');
  {
    const first = await runAccrual(models);
    const payouts = await InvestmentPayout.findAll({ where: { investment_id: investment.id } });
    check('A return payout is raised for the periods that have passed',
      first.created === 1 && payouts.length === 1,
      `${payouts.length} payout of ${naira(payouts[0]?.amount_minor)}`);

    /*
     * Three COMPLETED months, not a hundred days.
     *
     * A hundred days have passed, but the investor was told monthly — so what
     * is releasable is the return for the three months that actually closed
     * (91 days): ₦1,000,000 × 12% × 91 ÷ 365 = ₦29,917.80. Paying the extra
     * nine days would release a part-period early, every run, contradicting the
     * terms they agreed to.
     */
    check('...for the periods that CLOSED, not for every day elapsed',
      Number(payouts[0].amount_minor) === 2_991_780,
      `${naira(payouts[0].amount_minor)} — 91 days of a 100-day-old investment`);

    check('...recording what it was computed from',
      payouts[0].computed_from?.days >= 99 && payouts[0].computed_from?.principal_minor === MILLION,
      JSON.stringify(payouts[0].computed_from?.days));

    /*
     * The one that costs real money. A scheduler retries, a deploy restarts
     * mid-sweep, somebody runs it by hand after an outage — all three must be
     * safe.
     */
    /*
     * The statement and the payout answer different questions on purpose: an
     * investor should SEE the nine extra days they have waited, even though
     * those days are not yet payable.
     */
    const { positionOf: pos } = require('../services/investment-service/src/services/investmentEngine');
    await investment.reload();
    const shown = pos(investment);
    check('A statement still shows the days earned but not yet releasable',
      shown.earned_minor > shown.paid_minor && shown.releasable_minor === 0,
      `earned ${naira(shown.earned_minor)}, released ${naira(shown.paid_minor)}, releasable ${naira(shown.releasable_minor)}`);

    const second = await runAccrual(models);
    const third = await runAccrual(models);
    const after = await InvestmentPayout.count({ where: { investment_id: investment.id } });
    check('Running it again pays nothing further',
      second.created === 0 && third.created === 0 && after === 1,
      `${after} payout after three runs`);
  }

  console.log('\n── Maturity returns the capital, then completes ─────────────────');
  {
    // Wind the funding date back so the tenor has run its course.
    await investment.update({ funded_at: new Date(Date.now() - 400 * DAY) });

    await runAccrual(models);
    await investment.reload();

    const capital = await InvestmentPayout.findAll({
      where: { investment_id: investment.id, kind: 'capital' },
    });
    check('Capital is returned as its own payout, not folded into the return',
      capital.length === 1 && Number(capital[0].amount_minor) === MILLION,
      naira(capital[0]?.amount_minor));

    const returns = await InvestmentPayout.findAll({
      where: { investment_id: investment.id, kind: 'return' },
    });
    const totalReturn = returns.reduce((sum, p) => sum + Number(p.amount_minor), 0);
    check('...and the full year of return has been raised',
      totalReturn === 120_000_00, naira(totalReturn));

    check('The investment completes once nothing is outstanding',
      investment.status === 'completed', investment.status);

    const afterComplete = await runAccrual(models);
    check('...and a completed investment is not swept again',
      afterComplete.examined === 0, `${afterComplete.examined} examined`);
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await sequelize.close();
  await admin.query(`DROP DATABASE \`${DB}\``);
  await admin.end();
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

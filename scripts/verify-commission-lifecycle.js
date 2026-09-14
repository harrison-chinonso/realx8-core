/**
 * Phase 2 against a real database: vesting, reversal, payout and recovery.
 *
 * verify:commission proves the arithmetic with no database. verify:
 * commission-store proves accrual and release persist correctly. This proves
 * the part that only shows up over a deal's LIFETIME — that a pro-rata plan
 * releases in step with the buyer rather than all at once, that a replayed
 * receipt releases nothing further, that a downward revision drains the
 * cheapest position first and only invoices for money that actually left, and
 * that a payout batch deducts, recovers and pays exactly what the ledger says.
 *
 * Drives the REAL migrations, store and bridge against a throwaway database.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { QueryTypes } = require('sequelize');
const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_commission_lifecycle`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }

/**
 * Before anything requires a model — config/database.js reads this at require
 * time, and without it the store below writes plans into the real database.
 */
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifylifecycle';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

const naira = (amount) => Math.round(amount * 100);
const show = (minor) => (Number(minor) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });

const PRICE = naira(50_000_000);

/** Seller on 6%, one generation on 1.5%, released in step with the buyer. */
const PRO_RATA_PLAN = {
  commissionable_base: { mode: 'GROSS_PRICE' },
  pool: { mode: 'PERCENTAGE', percentage: 8 },
  resolution: 'PRORATE',
  vesting: { release_trigger: 'PRO_RATA' },
  deductions: [
    { code: 'wht', label: 'Withholding tax', type: 'PERCENTAGE', value: 5, basis: 'GROSS', order: 1 },
  ],
  clawback_window_months: 12,
  clawback_recovery_percentage: 50,
  rules: [
    { id: 'direct', type: 'DIRECT_SALE', value_type: 'PERCENTAGE', basis: 'OF_COMMISSIONABLE_BASE' },
    {
      id: 'gen',
      type: 'GENERATIONAL_OVERRIDE',
      compression: 'NONE',
      tiers: [{ generation: 1, value_type: 'PERCENTAGE', value: 1.5, basis: 'OF_COMMISSIONABLE_BASE' }],
    },
  ],
};

(async () => {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  const { sequelize } = require('../services/finance-service/src/config/database');
  const userModels = require('../services/user-service/src/models');
  await userModels.Company.sync({ force: true });
  await userModels.RealtorLevel.sync({ force: true });
  await userModels.User.sync({ force: true });
  await userModels.Company.create({ id: 1, name: 'Test Company', slug: 'test-company', email: 'company@test' });

  await require('../services/user-service/src/migrations/addRealtorStatusHistory')(sequelize);
  await require('../services/finance-service/src/migrations/createCommissionEngine')(sequelize);

  /**
   * Enough of `invoices` for the self-dealing check to read a buyer.
   *
   * Hand-written rather than synced from the model because the finance model
   * pulls in half the service's associations, and this needs three columns. It
   * is a stand-in for one query, and the query is in the assertion below.
   */
  await sequelize.query(`CREATE TABLE invoices (
    id INT PRIMARY KEY, client_id INT, company_id INT, property_id INT,
    created_at DATETIME NULL
  )`);

  const store = require('../shared/src/commissionStore');
  const { recordStatus, STATUS } = require('../shared/src/realtorStatus');

  await sequelize.query("INSERT INTO realtor_levels (id, name, position, commission_percentage, company_id, created_at, updated_at) VALUES (1, 'Senior', 3, 6.00, 1, NOW(), NOW())");
  await sequelize.query(`INSERT INTO users (id, name, email, password, type, realtor_code, realtor_id, realtor_level_id, company_id, created_at, updated_at) VALUES
    (10, 'Seller',  'seller@test', 'x', 'realtor', 'AAAAA', 11,   1, 1, '2026-01-01', NOW()),
    (11, 'Sponsor', 'gen1@test',   'x', 'realtor', 'BBBBB', NULL, 1, 1, '2026-01-01', NOW())`);
  for (const id of [10, 11]) {
    // eslint-disable-next-line no-await-in-loop
    await recordStatus(sequelize, { userId: id, status: STATUS.ACTIVE, reason: 'administrative', at: '2026-01-01T00:00:00Z' });
  }

  await sequelize.query(
    `INSERT INTO commission_plans (id, company_id, name, is_default, status, created_at)
     VALUES (1, 1, 'Pro rata plan', 1, 'active', NOW())`,
    { type: QueryTypes.INSERT },
  );
  await sequelize.query(
    `INSERT INTO commission_plan_versions
       (id, plan_id, company_id, version, effective_from, status, config, engine_version, created_at)
     VALUES (1, 1, 1, 1, '2026-01-01', 'active', :config, :engine, NOW())`,
    { replacements: { config: JSON.stringify(PRO_RATA_PLAN), engine: store.ENGINE_VERSION }, type: QueryTypes.INSERT },
  );

  /**
   * Every deal in this suite is bought by client 20, who earns nothing — an
   * ordinary arm's-length sale, so the screening baseline is silence.
   *
   * Invoice 999 is the deliberate exception: bought by realtor 10, who also
   * earns on it. That is the self-purchase case, asserted directly rather than
   * by making the whole suite's fixtures suspicious.
   */
  await sequelize.query(`INSERT INTO users (id, name, email, password, type, company_id, created_at, updated_at)
    VALUES (20, 'A Client', 'client@test', 'x', 'client', 1, NOW(), NOW())`);
  await sequelize.query(`INSERT INTO invoices (id, client_id, company_id, property_id, created_at) VALUES
    (900, 20, 1, 100, '2026-08-01'),
    (901, 20, 1, 100, '2026-08-01'),
    (902, 20, 1, 100, '2026-08-01'),
    (999, 10, 1, 100, '2026-08-01')`);

  const deal = {
    deal_ref: 'DEAL-L1',
    company_id: 1,
    property_id: 100,
    invoice_id: 900,
    selling_realtor_id: 10,
    gross_price_minor: PRICE,
    discount_minor: 0,
    unit_count: 1,
    attribution_date: '2026-08-01T00:00:00Z',
  };

  const lineFor = async (realtorId, dealRef = deal.deal_ref) => {
    const [row] = await sequelize.query(
      `SELECT * FROM commission_entitlements
        WHERE deal_ref = :dealRef AND realtor_id = :realtorId ORDER BY id LIMIT 1`,
      { replacements: { dealRef, realtorId }, type: QueryTypes.SELECT },
    );
    return row;
  };

  // ── Vesting in step with the buyer ────────────────────────────────────────
  console.log('\n── §7.9  A pro-rata plan releases as the buyer pays ────────────');
  {
    const accrual = await store.accrueForDeal(sequelize, deal);
    check('The deal accrues two lines — seller and sponsor',
      accrual.accrued === 2, `${accrual.accrued} accrued`);

    const seller = await lineFor(10);
    check('The seller is entitled to 6% of the sale',
      Number(seller.constrained_minor) === naira(3_000_000), show(seller.constrained_minor));
    check('...and nothing has vested before a naira arrives',
      Number(seller.released_minor) === 0 && seller.status === 'ACCRUED');

    // First instalment: 20% of the price.
    const first = await store.releaseForDeal(sequelize, {
      dealRef: deal.deal_ref, receivedMinor: naira(10_000_000), at: '2026-09-01T00:00:00Z',
    });
    const afterFirst = await lineFor(10);
    check('20% paid releases 20% of the entitlement',
      Number(afterFirst.released_minor) === naira(600_000), show(afterFirst.released_minor));
    check('...and the line is PARTIALLY_RELEASED, not RELEASED',
      afterFirst.status === 'PARTIALLY_RELEASED', afterFirst.status);
    check('...for both participants',
      first.released === 2, `${first.released} lines`);

    /**
     * The replay. This is the check the whole cumulative design exists for: a
     * webhook delivered twice, or a job re-run, must not release again.
     */
    const replay = await store.releaseForDeal(sequelize, {
      dealRef: deal.deal_ref, receivedMinor: naira(10_000_000), at: '2026-09-02T00:00:00Z',
    });
    const afterReplay = await lineFor(10);
    check('The same receipt replayed releases nothing further',
      replay.released === 0 && Number(afterReplay.released_minor) === naira(600_000),
      `${show(afterReplay.released_minor)} still`);

    const [ledger] = await sequelize.query(
      `SELECT COUNT(*) AS n FROM commission_ledger_entries
        WHERE deal_ref = :dealRef AND entry_type = 'RELEASE'`,
      { replacements: { dealRef: deal.deal_ref }, type: QueryTypes.SELECT },
    );
    check('...and posts no second ledger entry',
      Number(ledger.n) === 2, `${ledger.n} RELEASE entries for 2 participants`);

    // Second instalment brings the buyer to 60%.
    await store.releaseForDeal(sequelize, {
      dealRef: deal.deal_ref, receivedMinor: naira(30_000_000), at: '2026-10-01T00:00:00Z',
    });
    const afterSecond = await lineFor(10);
    check('60% paid takes the cumulative release to 60%, not to another 20%',
      Number(afterSecond.released_minor) === naira(1_800_000), show(afterSecond.released_minor));

    const wallet = await store.walletFor(sequelize, 10);
    check('The wallet agrees with the entitlement it came from',
      wallet.available_minor === naira(1_800_000)
        && wallet.accrued_minor === naira(1_200_000),
      `available ${show(wallet.available_minor)}, still accruing ${show(wallet.accrued_minor)}`);
  }

  // ── Revision and clawback ─────────────────────────────────────────────────
  console.log('\n── §7.10  A deal that shrinks, drained cheapest-first ──────────');
  {
    /**
     * Pay out what has vested first, so the reversal below has all three
     * positions to drain: unreleased accrual, released-but-unpaid, and paid.
     */
    const built = await store.buildPayoutsFor(sequelize, { companyId: 1, batchRef: 'B1' });
    check('A payout is built per realtor, not per entitlement',
      built.payouts.length === 2, `${built.payouts.length} payouts`);

    const sellerPayout = built.payouts.find((p) => p.realtor_id === 10);
    check('Its gross is everything released and unpaid',
      sellerPayout.gross_minor === naira(1_800_000), show(sellerPayout.gross_minor));
    check('FR-PAY-003  5% withholding comes off, and the advice itemises it',
      sellerPayout.deductions_minor === naira(90_000)
        && sellerPayout.deductions[0].code === 'wht'
        && sellerPayout.net_minor === naira(1_710_000),
      `gross ${show(sellerPayout.gross_minor)} − ${show(sellerPayout.deductions_minor)} = ${show(sellerPayout.net_minor)}`);

    const stillDraft = await store.markPayoutPaid(sequelize, sellerPayout.id);
    check('A draft cannot be paid without an approval',
      stillDraft.skipped === 'not_approved:DRAFT', stillDraft.skipped);

    await store.approvePayout(sequelize, sellerPayout.id, { userId: 1 });
    await store.markPayoutPaid(sequelize, sellerPayout.id, { reference: 'TRF-1' });

    /**
     * The books must agree with the bank. A PAYOUT posted at gross with no
     * contra-entry says 1,800,000 left when 1,710,000 did, and carries no
     * liability for the 90,000 withheld.
     */
    const [withheld] = await sequelize.query(
      `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM commission_ledger_entries
        WHERE entry_type = 'DEDUCTION'`,
      { type: QueryTypes.SELECT },
    );
    check('What was withheld is posted, not just netted off',
      Number(withheld.total) === naira(90_000), show(withheld.total));

    const glAfterPay = await require('../shared/src/commissionAnalytics')
      .glExportFor(sequelize, { companyId: 1 });
    const bank = glAfterPay.journal.filter((l) => l.account === 'BANK');
    const cash = bank.reduce((t, l) => t + l.credit_minor - l.debit_minor, 0);
    check('...so the ledger moves cash by the NET, not the gross',
      cash === naira(1_710_000), `${show(cash)} out of the bank`);
    check('...and the withholding sits on the books as a liability',
      glAfterPay.journal.some((l) => l.account === 'WITHHOLDING_PAYABLE' && l.credit_minor === naira(90_000)),
      'a remittance nobody recorded is one nobody remits');

    const paidLine = await lineFor(10);
    check('Once paid, the entitlement records what actually left',
      Number(paidLine.paid_minor) === naira(1_800_000), show(paidLine.paid_minor));

    const wallet = await store.walletFor(sequelize, 10);
    check('...and the wallet is drawn down by it',
      wallet.available_minor === 0 && wallet.paid_minor === naira(1_800_000),
      `available ${show(wallet.available_minor)}`);

    /**
     * The renegotiation: 50M becomes 30M. The seller's entitlement falls from
     * 3,000,000 to 1,800,000 — which is exactly what has already been paid, so
     * nothing should be clawed back and the unreleased 1,200,000 should simply
     * cease to exist.
     */
    const revised = await store.reviseForDeal(
      sequelize,
      { ...deal, gross_price_minor: naira(30_000_000) },
      { reason: 'renegotiated', at: '2026-11-01T00:00:00Z' },
    );
    check('Both participants are revised', revised.revised === 2, `${revised.revised} lines`);

    const afterRevision = await lineFor(10);
    check('The entitlement is reduced to what the new price supports',
      Number(afterRevision.constrained_minor) === naira(1_800_000), show(afterRevision.constrained_minor));
    check('The unreleased accrual absorbed the whole reduction',
      Number(afterRevision.clawed_back_minor) === 0,
      'nobody is invoiced while an unreleased accrual sits against the same deal');
    check('...so no receivable was raised',
      (await store.openReceivablesFor(sequelize, 10)).length === 0);

    /**
     * Further: a cancellation, where the entitlement goes to zero and there is
     * no accrual left to absorb it. THIS is the case that becomes a receivable.
     */
    await store.reviseForDeal(
      sequelize,
      { ...deal, gross_price_minor: 0, discount_minor: 0 },
      { reason: 'cancelled', at: '2026-11-02T00:00:00Z' },
    );
    const owed = await store.openReceivablesFor(sequelize, 10);
    check('A cancellation after payment raises a receivable for what left',
      owed.length === 1 && Number(owed[0].amount_minor) === naira(1_800_000),
      owed.length ? show(owed[0].amount_minor) : 'none raised');

    const cancelled = await lineFor(10);
    check('...and the line is REVERSED rather than deleted',
      cancelled.status === 'REVERSED' && Number(cancelled.gross_minor) > 0,
      'the original trace survives, so what was agreed is still answerable');
  }

  // ── Recovery out of a later payout ────────────────────────────────────────
  console.log('\n── FR-ADJ-003  Recovering a clawback, a share at a time ────────');
  {
    const second = {
      ...deal, deal_ref: 'DEAL-L2', invoice_id: 901, attribution_date: '2026-11-10T00:00:00Z',
    };
    await store.accrueForDeal(sequelize, second);
    await store.releaseForDeal(sequelize, {
      dealRef: 'DEAL-L2', receivedMinor: PRICE, at: '2026-12-01T00:00:00Z',
    });

    const built = await store.buildPayoutsFor(sequelize, { companyId: 1, batchRef: 'B2', realtorIds: [10] });
    const payout = built.payouts[0];
    check('The new sale releases in full and is payable',
      payout.gross_minor === naira(3_000_000), show(payout.gross_minor));

    /**
     * 5% withholding on 3,000,000 leaves 2,850,000. The plan recovers at most
     * 50% of a payout, so 1,425,000 comes off the 1,800,000 owed.
     */
    check('Recovery is capped at the plan\'s share of the payout',
      payout.recovered_minor === naira(1_425_000) && payout.net_minor === naira(1_425_000),
      `recovered ${show(payout.recovered_minor)}, paid ${show(payout.net_minor)}`);
    check('...taken AFTER withholding, not before',
      payout.deductions_minor === naira(150_000),
      'recovering first would shrink the taxable figure and under-remit');

    const beforePaying = await store.openReceivablesFor(sequelize, 10);
    check('A draft payout has not yet reduced what is owed',
      Number(beforePaying[0].recovered_minor) === 0,
      'cancelling a batch must not quietly forgive a clawback');

    await store.approvePayout(sequelize, payout.id, { userId: 1 });
    await store.markPayoutPaid(sequelize, payout.id, { reference: 'TRF-2' });

    const after = await store.openReceivablesFor(sequelize, 10);
    check('Paying it reduces the receivable and leaves the rest open',
      after.length === 1 && Number(after[0].recovered_minor) === naira(1_425_000),
      `still owed ${show(Number(after[0].amount_minor) - Number(after[0].recovered_minor))}`);
  }

  // ── Eligibility at release ────────────────────────────────────────────────
  console.log('\n── §5.9  The status gate is asked again at every release ───────');
  {
    const third = {
      ...deal, deal_ref: 'DEAL-L3', invoice_id: 902, attribution_date: '2027-01-01T00:00:00Z',
    };
    await store.accrueForDeal(sequelize, third);

    // Active when the deal closed, suspended before the second instalment.
    await store.releaseForDeal(sequelize, {
      dealRef: 'DEAL-L3', receivedMinor: naira(10_000_000), at: '2027-02-01T00:00:00Z',
    });
    const afterFirst = await lineFor(10, 'DEAL-L3');
    check('Active at the first instalment, so it vests',
      Number(afterFirst.released_minor) === naira(600_000), show(afterFirst.released_minor));

    await recordStatus(sequelize, {
      userId: 10, status: STATUS.SUSPENDED, reason: 'compliance_lapse', at: '2027-03-01T00:00:00Z',
    });
    await store.releaseForDeal(sequelize, {
      dealRef: 'DEAL-L3', receivedMinor: PRICE, at: '2027-04-01T00:00:00Z',
    });

    const afterSuspension = await lineFor(10, 'DEAL-L3');
    check('Suspended before the next one, so nothing further vests',
      Number(afterSuspension.released_minor) === naira(600_000), show(afterSuspension.released_minor));
    check('Only the increment due while they were out is forfeited',
      Number(afterSuspension.forfeited_minor) === naira(2_400_000),
      `${show(afterSuspension.forfeited_minor)} — not the whole entitlement, which would leave nothing to reinstate`);
    check('...and what had already vested is untouched (FR-ELG-004)',
      Number(afterSuspension.released_minor) === naira(600_000),
      'deactivation never claws back what has been paid');

    const sponsor = await lineFor(11, 'DEAL-L3');
    check('The sponsor, still active, vests in full',
      Number(sponsor.released_minor) === naira(750_000), show(sponsor.released_minor));
  }

  // ── The statement ─────────────────────────────────────────────────────────
  console.log('\n── FR-PAY-008  What a realtor can be shown ─────────────────────');
  {
    const statement = await store.statementFor(sequelize, 10);
    check('Every entitlement across every deal', statement.entitlements.length >= 3,
      `${statement.entitlements.length} lines`);
    check('Every payout, with its advice readable',
      statement.payouts.length === 2 && statement.payouts[0].advice?.gross_minor > 0);
    check('What is still owed back', statement.owed_minor === naira(375_000),
      show(statement.owed_minor));
    check('...and the wallet, derived from the ledger',
      typeof statement.wallet.available_minor === 'number');

    /**
     * The ledger is the record of account (NFR-004), so if the entitlements and
     * the ledger disagree, one of them is wrong and there is no way to tell
     * which. Reconciled here rather than asserted anywhere in the code, because
     * the code that could assert it is the code that would be wrong.
     */
    const [totals] = await sequelize.query(
      `SELECT
         COALESCE(SUM(CASE WHEN entry_type = 'RELEASE' THEN amount_minor ELSE 0 END), 0) AS released,
         COALESCE(SUM(CASE WHEN entry_type = 'PAYOUT'  THEN amount_minor ELSE 0 END), 0) AS paid
       FROM commission_ledger_entries WHERE realtor_id = 10`,
      { type: QueryTypes.SELECT },
    );
    const [rows] = await sequelize.query(
      `SELECT COALESCE(SUM(released_minor), 0) AS released, COALESCE(SUM(paid_minor), 0) AS paid
         FROM commission_entitlements WHERE realtor_id = 10`,
      { type: QueryTypes.SELECT },
    );
    check('The ledger and the entitlements agree on what was paid',
      Number(totals.paid) === Number(rows.paid),
      `ledger ${show(totals.paid)} vs entitlements ${show(rows.paid)}`);
  }


  // ── Analytics ─────────────────────────────────────────────────────────────
  console.log('\n── §8  What it cost, what it owes, and what the books say ──────');
  {
    const analytics = require('../shared/src/commissionAnalytics');

    const summary = await analytics.summaryFor(sequelize, { companyId: 1 });
    check('Every deal and every earner is counted',
      summary.deals === 3 && summary.earners === 2,
      `${summary.deals} deals, ${summary.earners} earners`);

    /**
     * The two liability figures are kept apart deliberately. One total for both
     * overstates what is due this month and understates the exposure.
     */
    check('Accrued liability and payable are reported separately',
      summary.accrued_liability_minor >= 0 && summary.payable_minor >= 0
        && summary.accrued_liability_minor !== summary.payable_minor,
      `accrued ${show(summary.accrued_liability_minor)}, payable ${show(summary.payable_minor)}`);

    const breakage = await analytics.breakageFor(sequelize, { companyId: 1 });
    check('FR-ANL-004  breakage is reported BY CAUSE, not as one number',
      breakage.total_minor === naira(2_400_000) && breakage.causes.length >= 1,
      breakage.causes.map((c) => `${c.cause}/${c.role} ${show(c.amount_minor)}`).join(', '));
    check('...and the cause is the suspension, not "unallocated"',
      breakage.causes[0].cause !== 'unknown',
      'a company can act on a named cause and cannot act on a total');

    const cost = await analytics.costOfSaleFor(sequelize, { companyId: 1 });
    check('FR-ANL-002  the blended rate is a percentage of what was sold',
      cost.blended_rate > 0 && cost.blended_rate < 100, `${cost.blended_rate}%`);

    const board = await analytics.leaderboardFor(sequelize, { companyId: 1 });
    check('The leaderboard ranks by what was earned',
      board.length === 2 && Number(board[0].earned) >= Number(board[1].earned),
      board.map((r) => `${r.realtor_id}: ${show(r.earned)}`).join(', '));

    const liability = await analytics.liabilityFor(sequelize, { companyId: 1, at: '2027-05-01' });
    check('FR-ANL-005  outstanding obligation is aged from attribution',
      liability.aged.reduce((t, b) => t + b.amount_minor, 0) === liability.total_minor,
      liability.aged.filter((b) => b.lines).map((b) => `${b.label}: ${show(b.amount_minor)}`).join(', '));

    /**
     * The same quantity, computed two different ways, in two reports a finance
     * officer may well open side by side. If they disagree, neither can be
     * trusted and there is no way to tell which is wrong.
     */
    check('...and the summary agrees with it, to the kobo',
      summary.accrued_liability_minor === liability.accrued_liability_minor
        && summary.payable_minor === liability.payable_minor,
      `summary ${show(summary.accrued_liability_minor)}/${show(summary.payable_minor)} vs `
      + `liability ${show(liability.accrued_liability_minor)}/${show(liability.payable_minor)}`);

    /**
     * The one report whose job is to agree with the books. Every entry type
     * maps to exactly one debit and one credit, so an export that does not sum
     * to zero means a type has been added without deciding where it posts.
     */
    const gl = await analytics.glExportFor(sequelize, { companyId: 1 });
    check('FR-ANL-009  the GL export balances',
      gl.balanced && gl.debits_minor > 0,
      `Dr ${show(gl.debits_minor)} = Cr ${show(gl.credits_minor)}`);
    check('...and no entry type is silently unmapped',
      gl.unmapped_entry_types.length === 0,
      gl.unmapped_entry_types.join(', ') || 'every type posts somewhere');

    /**
     * FR-SIM-001, and the reason it re-runs the real engine: the only useful
     * answer to "what would this plan have cost" is the one the code that
     * would have produced it produces.
     */
    const cheaper = {
      ...PRO_RATA_PLAN,
      rules: [{ id: 'direct', type: 'DIRECT_SALE', value_type: 'PERCENTAGE', value: 2, basis: 'OF_COMMISSIONABLE_BASE' }],
    };
    const back = await analytics.backtest(sequelize, { companyId: 1, plan: cheaper });
    check('FR-SIM-001  a backtest prices history against a candidate plan',
      back.priced > 0, `${back.priced} priced, ${back.unpriced} not`);
    check('...and a 2% plan with no overrides costs less than 6% plus a generation',
      back.candidate_minor < back.actual_minor,
      `${show(back.candidate_minor)} vs ${show(back.actual_minor)} actually paid`);
    check('...while writing nothing',
      (await sequelize.query('SELECT COUNT(*) AS n FROM commission_entitlements',
        { type: QueryTypes.SELECT }))[0].n === summary.lines,
      'a simulation that wrote would make every what-if a commitment');
  }


  // ── Screening ─────────────────────────────────────────────────────────────
  console.log('\n── §7.14  Patterns worth a human look ──────────────────────────');
  {
    const fraud = require('../shared/src/commissionFraud');

    const flags = await sequelize.query(
      'SELECT code, severity, summary FROM commission_flags ORDER BY id',
      { type: QueryTypes.SELECT },
    );
    /**
     * Nothing should have been flagged. Every deal above is an ordinary sale by
     * an unrelated realtor, and a screening layer whose baseline is noise gets
     * switched off within a week.
     */
    check('Ordinary deals raise no flags at all',
      flags.length === 0,
      flags.map((f) => `${f.code}: ${f.summary}`).join(' | ') || 'clean');

    /**
     * FR-FRD-001, and the case worth the most: commission routed to the buyer
     * is a discount taken as commission, and a discount is approved where a
     * commission is not.
     */
    const selfBought = await fraud.selfDealing(sequelize, {
      dealRef: 'DEAL-SELF', invoiceId: 999, participants: [{ realtor_id: 10 }, { realtor_id: 11 }],
    });
    check('FR-FRD-001  a buyer earning on their own purchase is flagged HIGH',
      selfBought.some((f) => f.code === 'SELF_PURCHASE' && f.severity === 'HIGH'),
      selfBought.map((f) => f.code).join(', ') || 'nothing found');

    const armsLength = await fraud.selfDealing(sequelize, {
      dealRef: 'DEAL-L1', invoiceId: 900, participants: [{ realtor_id: 10 }, { realtor_id: 11 }],
    });
    check('...and an arm\'s-length sale is not',
      armsLength.length === 0, armsLength.map((f) => f.code).join(', ') || 'clean');

    /**
     * The seller and the sponsor share a phone number, which is the shape a
     * chain of accounts held by one person takes.
     */
    await sequelize.query("UPDATE users SET phone = '08030000000' WHERE id IN (10, 11)");
    const shared = await fraud.sharedIdentity(sequelize, {
      dealRef: 'DEAL-L1', participants: [{ realtor_id: 10 }, { realtor_id: 11 }],
    });
    check('FR-FRD-002  participants sharing a phone number are flagged',
      shared.length === 1 && shared[0].code === 'SHARED_IDENTITY',
      shared[0]?.summary);
    check('...and the flag says which fields it was actually able to compare',
      shared[0]?.evidence?.fields_checked?.includes('phone'),
      (shared[0]?.evidence?.fields_checked || []).join(', ')
      + ' — a check must not report "nothing found" when it could not look');
    await sequelize.query('UPDATE users SET phone = NULL WHERE id IN (10, 11)');

    check('...and two realtors with no phone on file are not flagged for sharing one',
      (await fraud.sharedIdentity(sequelize, {
        dealRef: 'DEAL-L1', participants: [{ realtor_id: 10 }, { realtor_id: 11 }],
      })).length === 0,
      'an empty column is not a match');

    /**
     * FR-FRD-004. DEAL-L1 was released, paid and then reversed — one is a buyer
     * changing their mind, which is why the check needs more than one.
     */
    const single = await fraud.releaseThenCancel(sequelize, { realtorId: 10, at: '2027-06-01' });
    check('FR-FRD-004  one released-then-reversed deal is not a pattern',
      single.length === 0, 'a single cancellation is a buyer, not a method');

    // A cycle: make the seller their own sponsor's sponsor.
    await sequelize.query('UPDATE users SET realtor_id = 10 WHERE id = 11');
    const cycle = await fraud.genealogyCycle(sequelize, { realtorId: 10 });
    check('FR-FRD-005  a looping genealogy is reported rather than silently truncated',
      cycle.length === 1 && cycle[0].code === 'GENEALOGY_CYCLE',
      cycle[0]?.summary);
    await sequelize.query('UPDATE users SET realtor_id = NULL WHERE id = 11');

    check('...and a well-formed chain is not',
      (await fraud.genealogyCycle(sequelize, { realtorId: 10 })).length === 0);

    /**
     * Nothing the screening found may have changed a figure. It reports; it
     * does not decide.
     */
    const [after] = await sequelize.query(
      'SELECT COALESCE(SUM(constrained_minor), 0) AS total FROM commission_entitlements',
      { type: QueryTypes.SELECT },
    );
    check('Screening changed nothing about what anybody is owed',
      Number(after.total) > 0, `${show(after.total)} still entitled`);
  }

  // ── Campaign scope ────────────────────────────────────────────────────────
  console.log('\n── §9  A campaign outranks a property-scoped plan ──────────────');
  {
    await sequelize.query(
      `INSERT INTO commission_plans (id, company_id, name, is_default, scope_type, scope_id, status, created_at)
       VALUES (2, 1, 'December promotion', 0, 'campaign', 77, 'active', NOW())`,
      { type: QueryTypes.INSERT },
    );
    await sequelize.query(
      `INSERT INTO commission_plan_versions
         (id, plan_id, company_id, version, effective_from, effective_to, status, config, engine_version, created_at)
       VALUES (2, 2, 1, 1, '2026-12-01', '2027-01-01', 'active', :config, :engine, NOW())`,
      { replacements: { config: JSON.stringify(PRO_RATA_PLAN), engine: store.ENGINE_VERSION }, type: QueryTypes.INSERT },
    );

    const inCampaign = await store.resolvePlanVersion(sequelize, {
      companyId: 1, propertyId: 100, campaignId: 77, at: '2026-12-15T00:00:00Z',
    });
    check('A deal inside the campaign resolves the campaign plan',
      inCampaign?.id === 2, `version ${inCampaign?.id}`);

    const outside = await store.resolvePlanVersion(sequelize, {
      companyId: 1, propertyId: 100, campaignId: 77, at: '2027-02-01T00:00:00Z',
    });
    check('...and one after it has expired falls back to the default',
      outside?.id === 1,
      'a campaign stops on its own rather than by somebody remembering to archive it');

    const noCampaign = await store.resolvePlanVersion(sequelize, {
      companyId: 1, propertyId: 100, at: '2026-12-15T00:00:00Z',
    });
    check('...and a deal belonging to no campaign never matches one',
      noCampaign?.id === 1, `version ${noCampaign?.id}`);
  }


  // ── Non-cash awards ───────────────────────────────────────────────────────
  console.log('\n── FR-INC-005  A prize is not a payment ────────────────────────');
  {
    /**
     * Realtor 10 was suspended in the eligibility section above. Reinstated
     * here, which is also the assertion that a reinstatement takes effect: the
     * status gate reads the history as at the release moment, so a realtor
     * cleared in May earns on a June deal without anything else being touched.
     */
    await recordStatus(sequelize, {
      userId: 10, status: STATUS.ACTIVE, reason: 'reinstated', at: '2027-05-01T00:00:00Z',
    });

    await sequelize.query(
      `INSERT INTO commission_plans (id, company_id, name, is_default, scope_type, scope_id, status, created_at)
       VALUES (3, 1, 'Award plan', 0, 'property', 555, 'active', NOW())`,
      { type: QueryTypes.INSERT },
    );
    await sequelize.query(
      `INSERT INTO commission_plan_versions
         (id, plan_id, company_id, version, effective_from, status, config, engine_version, created_at)
       VALUES (3, 3, 1, 1, '2026-01-01', 'active', :config, :engine, NOW())`,
      {
        replacements: {
          config: JSON.stringify({
            commissionable_base: { mode: 'GROSS_PRICE' },
            pool: { mode: 'UNCAPPED' },
            resolution: 'PRORATE',
            vesting: { release_trigger: 'ON_DEAL_CONFIRMATION' },
            rules: [
              { id: 'direct', type: 'DIRECT_SALE', value_type: 'PERCENTAGE', value: 2, basis: 'OF_COMMISSIONABLE_BASE' },
              {
                id: 'prize', type: 'DIRECT_SALE', value_type: 'NON_CASH',
                value_minor: naira(500_000), award: 'Weekend for two', stacking: 'ADDITIVE',
              },
            ],
          }),
          engine: store.ENGINE_VERSION,
        },
        type: QueryTypes.INSERT,
      },
    );

    const prizeDeal = {
      ...deal, deal_ref: 'DEAL-AWARD', property_id: 555, invoice_id: 902,
      attribution_date: '2027-06-01T00:00:00Z',
    };
    await store.accrueForDeal(sequelize, prizeDeal);

    const lines = await sequelize.query(
      `SELECT payout_type, constrained_minor FROM commission_entitlements
        WHERE deal_ref = 'DEAL-AWARD' AND realtor_id = 10 ORDER BY payout_type`,
      { type: QueryTypes.SELECT },
    );
    check('The award is entitled and valued like anything else',
      lines.length === 2 && lines.some((l) => l.payout_type === 'NON_CASH'
        && Number(l.constrained_minor) === naira(500_000)),
      lines.map((l) => `${l.payout_type} ${show(l.constrained_minor)}`).join(', '));

    await store.releaseForDeal(sequelize, {
      dealRef: 'DEAL-AWARD', receivedMinor: PRICE, at: '2027-06-02T00:00:00Z', confirmed: true,
    });

    /**
     * No period bound. `released_at` is stamped with the real clock while these
     * deals carry simulated dates, so a window expressed in the fixture's
     * calendar would exclude everything — which would look like the award
     * filter working when it was the date filter.
     */
    const built = await store.buildPayoutsFor(sequelize, {
      companyId: 1, batchRef: 'B3', realtorIds: [10],
    });
    const payout = built.payouts?.[0];

    /**
     * The whole point. A payout run that swept the award up would transfer the
     * value of the prize on top of the prize.
     */
    check('A payout run pays the cash and leaves the prize alone',
      payout && payout.gross_minor === naira(1_000_000),
      payout ? `${show(payout.gross_minor)} — 2% of the sale, with no trace of the 500,000 award`
        : 'nothing was built');

    const wallet = await store.walletFor(sequelize, 10);
    const awarded = await sequelize.query(
      `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM commission_ledger_entries
        WHERE realtor_id = 10 AND entry_type = 'AWARD'`,
      { type: QueryTypes.SELECT },
    );
    check('...and the award never enters the wallet as something drawable',
      Number(awarded[0].total) === naira(500_000)
        && wallet.available_minor < naira(500_000) + naira(1_000_000),
      `${show(awarded[0].total)} awarded, ${show(wallet.available_minor)} available`);

    const gl = await require('../shared/src/commissionAnalytics')
      .glExportFor(sequelize, { companyId: 1 });
    check('...while still costing the company something the books carry',
      gl.balanced && gl.journal.some((l) => l.account === 'COMMISSION_AWARDS'),
      'settled in kind, but an expense either way');
  }


  // ── Policy, against the database ──────────────────────────────────────────
  console.log('\n── Policy  The same lapse, three ways ──────────────────────────');
  {
    /**
     * Realtor 12 sells three identical deals under three plans that differ only
     * in policy, and is suspended before any of them releases. Same facts,
     * three answers — which is the point: the FRD supports more than one and
     * the company now picks.
     */
    await sequelize.query(`INSERT INTO users (id, name, email, password, type, realtor_code, realtor_id, realtor_level_id, company_id, created_at, updated_at)
      VALUES (12, 'Lapser', 'lapse@test', 'x', 'realtor', 'EEEEE', NULL, 1, 1, '2026-01-01', NOW())`);
    await recordStatus(sequelize, {
      userId: 12, status: STATUS.ACTIVE, reason: 'administrative', at: '2028-01-01T00:00:00Z',
    });

    const planFor = async (id, policy) => {
      await sequelize.query(
        `INSERT INTO commission_plans (id, company_id, name, is_default, scope_type, scope_id, status, created_at)
         VALUES (:id, 1, :name, 0, 'property', :id, 'active', NOW())`,
        { replacements: { id, name: `Policy plan ${id}` }, type: QueryTypes.INSERT },
      );
      await sequelize.query(
        `INSERT INTO commission_plan_versions
           (id, plan_id, company_id, version, effective_from, status, config, engine_version, created_at)
         VALUES (:id, :id, 1, 1, '2028-01-01', 'active', :config, :engine, NOW())`,
        {
          replacements: {
            id,
            config: JSON.stringify({
              commissionable_base: { mode: 'GROSS_PRICE' },
              pool: { mode: 'UNCAPPED' },
              resolution: 'PRORATE',
              vesting: { release_trigger: 'PRO_RATA' },
              rules: [{ id: 'direct', type: 'DIRECT_SALE', value_type: 'PERCENTAGE', value: 6, basis: 'OF_COMMISSIONABLE_BASE' }],
              policy,
            }),
            engine: store.ENGINE_VERSION,
          },
          type: QueryTypes.INSERT,
        },
      );
    };

    await planFor(10, {});                                   // ENFORCE + INCREMENT
    await planFor(11, { lapse_scope: 'REMAINING' });          // ENFORCE + REMAINING
    await planFor(12, { gate: 'ADVISORY' });                  // pays anyway

    const run = async (ref, propertyId) => {
      await store.accrueForDeal(sequelize, {
        deal_ref: ref, company_id: 1, property_id: propertyId, invoice_id: 901,
        selling_realtor_id: 12, gross_price_minor: PRICE, discount_minor: 0, unit_count: 1,
        attribution_date: '2028-02-01T00:00:00Z',
      });
      // 20% paid while active, then suspended, then the buyer reaches 100%.
      await store.releaseForDeal(sequelize, {
        dealRef: ref, receivedMinor: naira(10_000_000), at: '2028-03-01T00:00:00Z',
      });
      return ref;
    };

    await run('POL-ENFORCE', 10);
    await run('POL-REMAINING', 11);
    await run('POL-ADVISORY', 12);

    const first = await lineFor(12, 'POL-ENFORCE');
    check('All three vest 20% while the realtor is still active',
      Number(first.released_minor) === naira(600_000), show(first.released_minor));

    await recordStatus(sequelize, {
      userId: 12, status: STATUS.SUSPENDED, reason: 'compliance_lapse', at: '2028-04-01T00:00:00Z',
    });

    /**
     * The buyer reaches 60%, not 100%.
     *
     * At 100% the increment due and the whole remaining balance are the same
     * number, so both scopes would forfeit 2,400,000 and the checks below would
     * pass even if lapse_scope did nothing at all. At 60% the increment is
     * 1,200,000 and the remaining balance is 2,400,000, and the settings
     * separate.
     */
    for (const ref of ['POL-ENFORCE', 'POL-REMAINING', 'POL-ADVISORY']) {
      // eslint-disable-next-line no-await-in-loop
      await store.releaseForDeal(sequelize, {
        dealRef: ref, receivedMinor: naira(30_000_000), at: '2028-05-01T00:00:00Z',
      });
    }

    const enforced = await lineFor(12, 'POL-ENFORCE');
    check('ENFORCE + INCREMENT forfeits only what fell due while suspended',
      Number(enforced.released_minor) === naira(600_000)
        && Number(enforced.forfeited_minor) === naira(1_200_000),
      `${show(enforced.forfeited_minor)} lost — the 40% that fell due, not the 80% outstanding`);

    const remaining = await lineFor(12, 'POL-REMAINING');
    check('ENFORCE + REMAINING forfeits the whole unreleased balance instead',
      Number(remaining.forfeited_minor) === naira(2_400_000)
        && Number(remaining.released_minor) === naira(600_000),
      `${show(remaining.forfeited_minor)} lost on one missed checkpoint — `
      + 'twice the increment, which is what makes the setting a real choice');

    const advisory = await lineFor(12, 'POL-ADVISORY');
    check('ADVISORY pays the suspended realtor anyway — §7.9\'s reading',
      Number(advisory.released_minor) === naira(1_800_000)
        && Number(advisory.forfeited_minor) === 0,
      `${show(advisory.released_minor)} — the full 60% the buyer has paid, nothing forfeited`);

    /**
     * The check ran under ADVISORY too. The history of who was suspended when
     * is identical across all three; only the money differs.
     */
    const recorded = JSON.parse(advisory.eligibility_check || '{}');
    check('...and the status check is still recorded against it',
      recorded.status === 'suspended' && recorded.result === 'PASS_ADVISORY',
      `${recorded.status} / ${recorded.result}`);
  }

  console.log('\n── Policy  A scoped plan inherits the company answer ───────────');
  {
    /**
     * Plan 13 is scoped to a property and states no trigger. The company
     * default (plan 1) vests PRO_RATA, so this one must too — otherwise setting
     * a company-wide trigger silently fails to apply to exactly the estates
     * somebody scoped a plan to.
     */
    await sequelize.query(
      `INSERT INTO commission_plans (id, company_id, name, is_default, scope_type, scope_id, status, created_at)
       VALUES (13, 1, 'Silent scoped plan', 0, 'property', 13, 'active', NOW())`,
      { type: QueryTypes.INSERT },
    );
    await sequelize.query(
      `INSERT INTO commission_plan_versions
         (id, plan_id, company_id, version, effective_from, status, config, engine_version, created_at)
       VALUES (13, 13, 1, 1, '2028-01-01', 'active', :config, :engine, NOW())`,
      {
        replacements: {
          config: JSON.stringify({
            commissionable_base: { mode: 'GROSS_PRICE' },
            pool: { mode: 'UNCAPPED' },
            resolution: 'PRORATE',
            rules: [{ id: 'direct', type: 'DIRECT_SALE', value_type: 'PERCENTAGE', value: 6, basis: 'OF_COMMISSIONABLE_BASE' }],
          }),
          engine: store.ENGINE_VERSION,
        },
        type: QueryTypes.INSERT,
      },
    );

    const resolved = await store.vestingConfigFor(sequelize, 13);
    check('A scoped plan with no trigger follows the company default',
      resolved.release_trigger === 'PRO_RATA', resolved.release_trigger);

    const companyPlan = await store.vestingConfigFor(sequelize, 1);
    check('...and the default plan itself has nothing above it to inherit from',
      companyPlan.release_trigger === 'PRO_RATA', companyPlan.release_trigger);
  }


  // ── Building twice ────────────────────────────────────────────────────────
  console.log('\n── FR-PAY-002  Building a run twice must not pay twice ─────────');
  {
    const ref = 'DEAL-TWICE';
    await store.accrueForDeal(sequelize, {
      ...deal, deal_ref: ref, invoice_id: 901, attribution_date: '2029-01-01T00:00:00Z',
    });
    await store.releaseForDeal(sequelize, {
      dealRef: ref, receivedMinor: PRICE, at: '2029-02-01T00:00:00Z',
    });

    const first = await store.buildPayoutsFor(sequelize, { companyId: 1, batchRef: 'T1', realtorIds: [10] });
    check('The first run picks the commission up',
      first.payouts.length === 1, `${first.payouts.length} payout(s)`);

    /**
     * The bug this guards. `paid_minor` moves only when a payout is RECORDED
     * as paid, so without excluding lines an open payout already holds, every
     * press of the button wrote another draft for the same money — and
     * approving two of them paid the realtor twice.
     */
    const second = await store.buildPayoutsFor(sequelize, { companyId: 1, batchRef: 'T2', realtorIds: [10] });
    check('...and a second press finds nothing left to batch',
      second.payouts.length === 0,
      `${second.payouts.length} payout(s) — ${second.skipped || 'no reason given'}`);

    const payout = first.payouts[0];
    await store.approvePayout(sequelize, payout.id, { userId: 1 });
    await store.markPayoutPaid(sequelize, payout.id, { reference: 'TRF-TWICE' });

    const afterPaid = await store.buildPayoutsFor(sequelize, { companyId: 1, batchRef: 'T3', realtorIds: [10] });
    check('...and nothing is left once it has been paid either',
      afterPaid.payouts.length === 0, afterPaid.skipped || '');

    /**
     * Cancelling releases the hold, which is what makes a draft built by
     * mistake recoverable rather than permanently blocking that commission.
     */
    const ref2 = 'DEAL-CANCELLED';
    await store.accrueForDeal(sequelize, {
      ...deal, deal_ref: ref2, invoice_id: 902, attribution_date: '2029-03-01T00:00:00Z',
    });
    await store.releaseForDeal(sequelize, {
      dealRef: ref2, receivedMinor: PRICE, at: '2029-04-01T00:00:00Z',
    });
    const built = await store.buildPayoutsFor(sequelize, { companyId: 1, batchRef: 'C1', realtorIds: [10] });
    const blocked = await store.buildPayoutsFor(sequelize, { companyId: 1, batchRef: 'C2', realtorIds: [10] });
    check('An open draft holds its commission against a rebuild',
      blocked.payouts.length === 0);

    await store.cancelPayout(sequelize, built.payouts[0].id);
    const rebuilt = await store.buildPayoutsFor(sequelize, { companyId: 1, batchRef: 'C3', realtorIds: [10] });
    check('...and cancelling it hands the commission back to the next run',
      rebuilt.payouts.length === 1 && rebuilt.payouts[0].gross_minor === built.payouts[0].gross_minor,
      `${show(rebuilt.payouts[0]?.gross_minor)} available again`);

    /**
     * Belt and braces: a batch built BEFORE the guard existed must still not
     * pay twice. Approve the rebuild, pay it, then try to pay the stale one.
     */
    await store.approvePayout(sequelize, rebuilt.payouts[0].id, { userId: 1 });
    await store.markPayoutPaid(sequelize, rebuilt.payouts[0].id, { reference: 'TRF-C3' });

    await sequelize.query(
      "UPDATE commission_payouts SET status = 'APPROVED' WHERE id = :id",
      { replacements: { id: built.payouts[0].id }, type: QueryTypes.UPDATE },
    );
    const doubled = await store.markPayoutPaid(sequelize, built.payouts[0].id, { reference: 'TRF-DOUBLE' });
    check('A stale batch for money already paid is refused, not paid again',
      doubled.skipped === 'already_paid',
      doubled.message || `it returned ${JSON.stringify(doubled).slice(0, 80)}`);
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

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

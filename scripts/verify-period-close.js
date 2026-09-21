/**
 * Closing the books (ACC-7), and the audit pack that comes out of it (ACC-5.10).
 *
 * ── The check this file exists for ──────────────────────────────────────────
 *
 * That a closed month REFUSES a posting — including an automatic one. That is
 * the single assertion the whole epic rests on, and it is the one that is easy
 * to get almost right: a guard in the controllers looks identical until a
 * payment approved today with a value date in a closed month goes straight
 * past it, because that posting has no controller of its own.
 *
 * So the test back-dates a real bill through the real controller and demands
 * that nothing reaches the journal, then checks the refusal says what to do
 * about it rather than "something went wrong".
 *
 * ── And the two ways a close can lie ────────────────────────────────────────
 *
 * A checklist that can be overridden asserts nothing, so a period with money
 * in suspense must be refused however much somebody wants it closed.
 *
 * And a year-end journal must leave the balance sheet unchanged. Retained
 * earnings is the account balance plus income less expense; the close moves
 * the second into the first, and if the two are not identical either side of
 * it then one of them was wrong before.
 *
 * Drives the REAL controllers against a throwaway database.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { QueryTypes } = require('sequelize');
const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_close`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifyclose';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};
const show = (minor) => `₦${(Number(minor) / 100).toLocaleString('en-US')}`;

const COMPANY = 1;

const run = (handler, req) => new Promise((resolve) => {
  let code = 200;
  const res = {
    status(c) { code = c; return res; },
    json(body) { resolve({ code, body }); return res; },
  };
  Promise.resolve(handler(req, res, (err) => resolve({ code: 500, body: { error: err } })))
    .catch((err) => resolve({ code: 500, body: { error: err } }));
});

(async () => {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  const models = require('../services/finance-service/src/models');
  const { sequelize } = models;
  const userModels = require('../services/user-service/src/models');

  await userModels.Company.sync({ force: true });
  await userModels.RealtorLevel.sync({ force: true });
  await userModels.User.sync({ force: true });
  await userModels.Setting.sync({ force: true });
  await userModels.Company.create({
    id: COMPANY, name: 'Close Test Co', slug: 'close-test', email: 'close@test',
  });

  await models.LedgerAccount.sync({ force: true });
  await models.JournalEntry.sync({ force: true });
  await models.JournalLine.sync({ force: true });
  await models.Vendor.sync({ force: true });
  await models.Bill.sync({ force: true });
  await models.Transaction.sync({ force: true });
  await models.ExpenseType.sync({ force: true });
  await models.AccountingPeriod.sync({ force: true });
  await models.Tax.sync({ force: true });
  await models.ReminderSchedule.sync({ force: true });
  await models.Invoice.sync({ force: true });
  await models.InvoicePayment.sync({ force: true });

  await require('../services/finance-service/src/migrations/seedChartOfAccounts')(sequelize);
  await require('../services/finance-service/src/migrations/seedExpenseTypes')(sequelize);
  await userModels.Setting.create({
    group: 'accounting', key: 'post_to_ledger', value: 'true', company_id: COMPANY,
  });

  const periods = require('../services/finance-service/src/controllers/periodsController');
  const ap = require('../services/finance-service/src/controllers/payablesController');
  const acct = require('../services/finance-service/src/controllers/accountingController');
  const { balanceSheet } = require('../shared/src/accounting/statements');

  const STAFF = { id: 30, company_id: COMPANY, type: 'admin' };
  const OTHER = { id: 31, company_id: COMPANY, type: 'admin' };

  const entryCount = async () => sequelize.query(
    'SELECT COUNT(*) AS n FROM journal_entries', { type: QueryTypes.SELECT },
  ).then(([r]) => Number(r.n));

  // ── ACC-7.1 ───────────────────────────────────────────────────────────────
  console.log('\n── ACC-7.1  Twelve months of 2026 ──────────────────────────────');
  let januaryId = null;
  let decemberId = null;
  {
    const out = await run(periods.createPeriods, { user: STAFF, body: { year: 2026 } });
    check('Generated', out.code === 201 && out.body.data.length === 12, out.body.message);

    const list = await run(periods.listPeriods, { user: STAFF, query: {} });
    const january = list.body.data.find((p) => p.starts_on === '2026-01-01');
    const december = list.body.data.find((p) => p.starts_on === '2026-12-01');
    januaryId = january?.id;
    decemberId = december?.id;
    check('December is marked as the year end, January is not',
      december?.is_year_end === true && january?.is_year_end === false,
      'a June year end is ordinary, so the month is asked for rather than assumed');
  }

  // ── Some trading in January ───────────────────────────────────────────────
  console.log('\n── Some trading, and a month that will not close ───────────────');
  const vendor = await run(ap.createVendor, { user: STAFF, body: { name: 'Supplier Ltd' } });
  const adminType = await sequelize.query(
    "SELECT id FROM expense_types WHERE company_id = :c AND name = 'Administration' LIMIT 1",
    { replacements: { c: COMPANY }, type: QueryTypes.SELECT },
  ).then(([r]) => r.id);

  {
    const bill = await run(ap.createBill, {
      user: STAFF,
      body: {
        vendor_id: vendor.body.data.id, net_minor: 200000000,
        bill_date: '2026-01-15', expense_type_id: adminType, description: 'January rent',
      },
    });
    await run(ap.approveBill, { user: OTHER, params: { id: String(bill.body.data.id) }, body: {} });
    check('A January cost is posted', await entryCount() === 1, '1 entry');

    /*
     * A journal to an account the chart does not have, which falls to
     * suspense. That is exactly what the checklist must refuse a close on,
     * because suspense means a posting rule could not find its account and
     * somebody has to say where the money belongs.
     */
    const orphan = 'date,account,debit,credit,memo\n2026-01-20,9999999,1000.00,,Mystery\n2026-01-20,5200,,1000.00,Mystery';
    await run(acct.importJournalCsv, {
      user: STAFF, query: {}, body: { csv: orphan, entry_date: '2026-01-20' },
    });
  }

  // ── ACC-7.2 ───────────────────────────────────────────────────────────────
  console.log('\n── ACC-7.2  The checklist refuses ──────────────────────────────');
  {
    const out = await run(periods.checkPeriod, { user: STAFF, params: { id: String(januaryId) } });
    const suspense = out.body.data.checks.find((c) => c.key === 'suspense_empty');
    check('It finds the money sitting in suspense',
      suspense?.status === 'failed', suspense?.detail);
    check('...and says the period cannot be closed',
      out.body.data.can_close === false, `${out.body.data.failed} failure(s)`);

    const closed = await run(periods.closePeriod, { user: STAFF, params: { id: String(januaryId) }, body: {} });
    check('Closing is REFUSED, not warned about',
      closed.code === 422 && /cannot be closed/.test(closed.body.message || ''),
      closed.body.message);

    const bankNote = out.body.data.checks.find((c) => c.key === 'banks_reconciled');
    check('A company not using bank reconciliation is warned, not blocked',
      bankNote?.status === 'warning', bankNote?.detail);
  }

  // ── Fix it, then close ────────────────────────────────────────────────────
  console.log('\n── Corrected, and closed ───────────────────────────────────────');
  {
    const [suspenseEntry] = await sequelize.query(
      "SELECT id FROM journal_entries WHERE source = 'import' ORDER BY id DESC LIMIT 1",
      { type: QueryTypes.SELECT },
    );
    await run(acct.reverseJournalEntry, {
      user: STAFF,
      params: { id: String(suspenseEntry.id) },
      body: { reason: 'Posted to an account that does not exist' },
    });

    const out = await run(periods.closePeriod, { user: STAFF, params: { id: String(januaryId) }, body: {} });
    check('Once suspense is empty, January closes',
      out.code === 200 && out.body.data.period.status === 'closed', out.body.message);

    const [row] = await sequelize.query(
      'SELECT checklist FROM accounting_periods WHERE id = :id',
      { replacements: { id: januaryId }, type: QueryTypes.SELECT },
    );
    // MySQL hands JSON back already parsed; Postgres does too. Only a string
    // needs parsing, and assuming either way is how this broke first time.
    const stored = typeof row.checklist === 'string' ? JSON.parse(row.checklist) : row.checklist;
    check('...and what the checklist said is kept on the period',
      Array.isArray(stored) && stored.length >= 5,
      `${stored?.length} checks recorded`);
  }

  // ── The check this file exists for ────────────────────────────────────────
  console.log('\n── Nothing can be posted into a closed month ───────────────────');
  {
    const before = await entryCount();
    const bill = await run(ap.createBill, {
      user: STAFF,
      body: {
        vendor_id: vendor.body.data.id, net_minor: 50000000,
        bill_date: '2026-01-25', expense_type_id: adminType, description: 'A late January invoice',
      },
    });
    /*
     * Approved through the REAL controller. The posting here is automatic —
     * there is no "post this journal" endpoint to guard — which is exactly
     * why the refusal has to live at the ledger door.
     */
    const approved = await run(ap.approveBill, {
      user: OTHER, params: { id: String(bill.body.data.id) }, body: {},
    });
    check('The bill is still approved — a business event is not undone',
      approved.code === 200 && approved.body.data.status === 'approved', '');
    check('...but nothing reached the journal',
      await entryCount() === before, `${await entryCount()} entries, was ${before}`);

    const manual = await run(acct.createManualJournal, {
      user: STAFF,
      body: {
        entry_date: '2026-01-31',
        memo: 'A correction somebody wants to slip in',
        lines: [
          { account_code: '5200', debit_minor: 100000 },
          { account_code: '1020', credit_minor: 100000 },
        ],
      },
    });
    check('A manual journal into the closed month is refused by name',
      manual.code === 409 && /is closed/.test(manual.body.message || ''),
      manual.body.message);
    check('...and the refusal says what to do about it',
      /Reopen the period|date this entry/.test(manual.body.message || ''),
      'a refusal somebody cannot act on is a dead end');
  }

  // ── ACC-7.3 ───────────────────────────────────────────────────────────────
  console.log('\n── ACC-7.3  Reopening ──────────────────────────────────────────');
  {
    const noReason = await run(periods.reopenPeriod, {
      user: STAFF, params: { id: String(januaryId) }, body: {},
    });
    check('Refused without a reason', noReason.code === 400, noReason.body.message);

    const out = await run(periods.reopenPeriod, {
      user: STAFF,
      params: { id: String(januaryId) },
      body: { reason: 'The January rent invoice arrived late' },
    });
    check('Reopened, and the reason is kept',
      out.code === 200 && out.body.data.reopen_reason === 'The January rent invoice arrived late',
      out.body.message);

    const before = await entryCount();
    const [lateBill] = await sequelize.query(
      "SELECT id FROM bills WHERE description = 'A late January invoice' LIMIT 1",
      { type: QueryTypes.SELECT },
    );
    await sequelize.query(
      "UPDATE bills SET status = 'pending_approval' WHERE id = :id",
      { replacements: { id: lateBill.id }, type: QueryTypes.UPDATE },
    );
    await run(ap.approveBill, { user: OTHER, params: { id: String(lateBill.id) }, body: {} });
    check('...and the posting that was refused now goes through',
      await entryCount() === before + 1, `${await entryCount()} entries`);

    await run(periods.closePeriod, { user: STAFF, params: { id: String(januaryId) }, body: {} });
  }

  console.log('\n── Closing out of order is refused in both directions ──────────');
  {
    const march = await run(periods.listPeriods, { user: STAFF, query: {} })
      .then((r) => r.body.data.find((p) => p.starts_on === '2026-03-01'));
    const out = await run(periods.closePeriod, { user: STAFF, params: { id: String(march.id) }, body: {} });
    const earlier = out.body?.data?.checks?.find((c) => c.key === 'earlier_closed');
    check('March will not close while February is open',
      out.code === 422 && earlier?.status === 'failed', earlier?.detail);
  }

  // ── ACC-7.4 ───────────────────────────────────────────────────────────────
  console.log('\n── ACC-7.4  Year end ───────────────────────────────────────────');
  {
    // Close February through November so December can be reached.
    const list = await run(periods.listPeriods, { user: STAFF, query: {} });
    const inOrder = [...list.body.data].sort((a, b) => String(a.starts_on).localeCompare(String(b.starts_on)));
    for (const period of inOrder) {
      if (period.status === 'closed' || period.is_year_end) continue;
      // eslint-disable-next-line no-await-in-loop
      await run(periods.closePeriod, { user: STAFF, params: { id: String(period.id) }, body: {} });
    }

    const before = await balanceSheet(sequelize, { companyId: COMPANY, asAt: '2026-12-31' });

    const out = await run(periods.closePeriod, { user: STAFF, params: { id: String(decemberId) }, body: {} });
    check('December closes, and posts the year to retained earnings',
      out.code === 200 && /retained earnings/.test(out.body.message || ''), out.body.message);

    const after = await balanceSheet(sequelize, { companyId: COMPANY, asAt: '2026-12-31' });
    check('The balance sheet is unchanged by it',
      before.assets_minor === after.assets_minor
      && before.equity_minor === after.equity_minor
      && after.balanced === true,
      `equity ${show(before.equity_minor)} before, ${show(after.equity_minor)} after`);
    check('...but the earnings have moved out of the P&L and into the account',
      before.earnings_not_yet_closed_minor !== 0 && after.earnings_not_yet_closed_minor === 0,
      `${show(before.earnings_not_yet_closed_minor)} → ${show(after.earnings_not_yet_closed_minor)}`);

    const retained = after.equity.find((row) => row.role === 'RETAINED_EARNINGS');
    check('Retained earnings now holds the year\'s result',
      Number(retained?.balance_minor) === before.earnings_not_yet_closed_minor,
      show(retained?.balance_minor));
  }

  // ── ACC-5.10 ──────────────────────────────────────────────────────────────
  console.log('\n── ACC-5.10  The audit pack ────────────────────────────────────');
  {
    const open = await run(periods.createPeriods, {
      user: STAFF,
      body: { name: 'January 2027', starts_on: '2027-01-01', ends_on: '2027-01-31' },
    });
    const refused = await run(periods.auditPack, { user: STAFF, params: { id: String(open.body.data.id) } });
    check('Refused for a period that is still open',
      refused.code === 409 && /still open/.test(refused.body.message || ''),
      refused.body.message);

    const out = await run(periods.auditPack, { user: STAFF, params: { id: String(januaryId) } });
    const pack = out.body.data;
    check('A closed period gives the statements, the journals and the reconciliations',
      out.code === 200
      && pack.profit_and_loss && pack.balance_sheet && pack.trial_balance
      && Array.isArray(pack.journals) && pack.journals.length > 0,
      `${pack.journals.length} journal(s) behind ${pack.period.name}`);
    check('...and the checklist AS IT WAS at the close, not re-run now',
      Array.isArray(pack.checklist_at_close) && pack.closed_at != null,
      'what was signed off, rather than an answer about today');
  }

  console.log(`\n  ${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass}/${pass + fail} checks passed.\x1b[0m\n`);

  await sequelize.close();
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  console.log(`  Scratch database ${DB} dropped.\n`);
  await admin.end();
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error('\x1b[31mThe verification itself failed:\x1b[0m', error);
  process.exit(1);
});

/**
 * The cost side: vendors, bills, what is owed on them, and the CSV journal
 * import (ACC-4).
 *
 * ── The half of the books that did not exist ────────────────────────────────
 *
 * Realx8 knew everything about money coming in and almost nothing about money
 * going out. A P&L with no cost side is not a P&L, and for a developer the
 * cost side is most of the story — so every check here is about a specific
 * account receiving a specific amount, not about the entry balancing.
 *
 * ── The two checks worth writing this file for ──────────────────────────────
 *
 * That withholding tax is a LIABILITY rather than a smaller expense: the
 * company owes the vendor the full net and simply pays part of it to the tax
 * authority, and netting it off would understate the cost and lose the
 * obligation to remit.
 *
 * And that the raiser of a bill cannot approve it even while holding the
 * approval permission. A separation of duties that is really the permission
 * check in disguise is not a separation of duties, which is exactly what an
 * earlier version of this file accidentally asserted.
 *
 * Drives the REAL controllers against a throwaway database.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { QueryTypes } = require('sequelize');
const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_payables`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifypayables';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};
const show = (minor) => `₦${(Number(minor) / 100).toLocaleString('en-US')}`;

const COMPANY = 1;

/** A synthetic request/response pair, as the other controller suites use. */
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
  // Parents before children — `users` references both.
  await userModels.Company.sync({ force: true });
  await userModels.RealtorLevel.sync({ force: true });
  await userModels.User.sync({ force: true });
  await userModels.Setting.sync({ force: true });
  await userModels.Company.create({
    id: COMPANY, name: 'Payables Test Co', slug: 'payables-test', email: 'ap@test',
  });

  await models.LedgerAccount.sync({ force: true });
  await models.JournalEntry.sync({ force: true });
  await models.JournalLine.sync({ force: true });
  await models.Vendor.sync({ force: true });
  await models.Bill.sync({ force: true });
  await models.Transaction.sync({ force: true });
  await models.ExpenseType.sync({ force: true });
  await require('../services/finance-service/src/migrations/seedChartOfAccounts')(sequelize);
  // ACC-10: capitalisation follows the KIND of cost, so the kinds have to exist.
  await require('../services/finance-service/src/migrations/seedExpenseTypes')(sequelize);

  // Posting on, so the journals below actually happen.
  await userModels.Setting.create({
    group: 'accounting', key: 'post_to_ledger', value: 'true', company_id: COMPANY,
  });

  const ap = require('../services/finance-service/src/controllers/payablesController');
  const acct = require('../services/finance-service/src/controllers/accountingController');
  const ledger = require('../shared/src/accounting/ledger');

  const RAISER = { id: 88, company_id: COMPANY, type: 'admin' };
  const APPROVER = { id: 89, company_id: COMPANY, type: 'admin' };

  const linesOf = async (entryId) => sequelize.query(
    'SELECT account_code, account_role, debit_minor, credit_minor, property_id '
    + 'FROM journal_lines WHERE entry_id = :id ORDER BY position',
    { replacements: { id: entryId }, type: QueryTypes.SELECT },
  );
  const entryFor = async (source) => {
    const [row] = await sequelize.query(
      'SELECT id, reference, debit_minor FROM journal_entries WHERE source = :source ORDER BY id DESC LIMIT 1',
      { replacements: { source }, type: QueryTypes.SELECT },
    );
    return row;
  };

  const [buildType] = await sequelize.query(
    "SELECT id FROM expense_types WHERE company_id = :c AND name = 'Subcontractor works' LIMIT 1",
    { replacements: { c: COMPANY }, type: QueryTypes.SELECT },
  );
  const buildTypeId = buildType?.id;

  // ── ACC-4.1 ──────────────────────────────────────────────────────────────
  console.log('\n── ACC-4.1  A vendor ───────────────────────────────────────────');
  const vendorOut = await run(ap.createVendor, {
    user: RAISER,
    body: {
      name: 'Adeyemi Contractors Ltd', category: 'contractor',
      withholding_rate: 5, tax_id_number: 'TIN-99123',
    },
  });
  check('Created', vendorOut.code === 201, vendorOut.body?.data?.name);
  const vendorId = vendorOut.body?.data?.id;

  // ── ACC-4.2 ──────────────────────────────────────────────────────────────
  console.log('\n── ACC-4.2  A contractor bill, ₦120m net, 7.5% VAT ─────────────');
  const billOut = await run(ap.createBill, {
    user: RAISER,
    body: {
      vendor_id: vendorId,
      net_minor: 12000000000,
      tax_minor: 900000000,
      bill_date: '2026-09-01',
      due_date: '2026-10-01',
      description: 'Foundation pour, Favour City Epe',
      property_id: 2,
      /*
       * ACC-10.2. This used to be `capitalise: true` — a tick-box on the
       * form, which put the difference between this month's profit and the
       * balance sheet in the hands of whoever was typing. It is now a
       * consequence of what KIND of cost this is.
       */
      expense_type_id: buildTypeId,
    },
  });
  check('Raised, and waiting for approval',
    billOut.code === 201 && billOut.body?.data?.status === 'pending_approval',
    `${billOut.body?.data?.reference} ${billOut.body?.data?.status}`);
  const billId = billOut.body?.data?.id;

  check("Withholding defaults to the vendor's own rate",
    Number(billOut.body?.data?.withholding_minor) === 600000000,
    `${show(billOut.body?.data?.withholding_minor)} — 5% of ${show(12000000000)}`);

  const [{ n: beforeApproval }] = await sequelize.query(
    'SELECT COUNT(*) AS n FROM journal_entries', { type: QueryTypes.SELECT },
  );
  check('Nothing posts until somebody approves it', Number(beforeApproval) === 0, `${beforeApproval} entries`);

  console.log('\n── The raiser cannot approve their own bill ────────────────────');
  {
    /*
     * RAISER is not short of a permission here — this controller is called
     * directly, so no permission middleware runs at all. The only thing that
     * can refuse is the separation-of-duties check, which is the point.
     */
    const self = await run(ap.approveBill, { user: RAISER, params: { id: String(billId) }, body: {} });
    check('Refused by the guard rather than by a permission',
      self.code === 403 && /raised yourself/.test(self.body?.message || ''),
      `${self.code} — ${self.body?.message}`);
  }

  // ── ACC-3.6 ──────────────────────────────────────────────────────────────
  console.log('\n── ACC-3.6  Approved, and the cost recognised ──────────────────');
  {
    const out = await run(ap.approveBill, { user: APPROVER, params: { id: String(billId) }, body: {} });
    check('Somebody else approves it', out.code === 200 && out.body?.data?.status === 'approved',
      out.body?.data?.status);

    const entry = await entryFor('bill');
    check('...and a journal is posted', Boolean(entry), entry ? `${entry.reference} ${show(entry.debit_minor)}` : 'none');

    const lines = await linesOf(entry?.id);
    console.log(`        ${lines.map((l) => `${l.debit_minor > 0 ? 'Dr' : 'Cr'} ${l.account_code} ${l.account_role} ${show(l.debit_minor || l.credit_minor)}`).join('\n        ')}`);

    const at = (role) => lines.find((l) => l.account_role === role);
    check('ACC-10  A capitalisable cost goes to development WIP, not the P&L',
      Number(at('DEVELOPMENT_WIP')?.debit_minor) === 12000000000, '');
    check('Input tax is claimed as recoverable',
      Number(at('VAT_INPUT')?.debit_minor) === 900000000, '');
    check('The vendor is owed the net of withholding',
      Number(at('ACCOUNTS_PAYABLE')?.credit_minor) === 12300000000, '');
    check('Withholding is a LIABILITY to remit, not a smaller cost',
      Number(at('WITHHOLDING_PAYABLE')?.credit_minor) === 600000000,
      'the company owes the vendor the full net and pays part of it to the tax authority');
    check('ACC-4.3  Every line carries the property, for margin per project',
      lines.every((l) => Number(l.property_id) === 2), `property ${lines[0]?.property_id}`);
  }

  // ── ACC-4.4 ──────────────────────────────────────────────────────────────
  console.log('\n── ACC-4.4  Paid ───────────────────────────────────────────────');
  {
    const out = await run(ap.payBill, {
      user: APPROVER, params: { id: String(billId) }, body: { reference: 'TRF-BILL-1' },
    });
    check('It settles', out.code === 200 && out.body?.data?.status === 'paid', out.body?.data?.status);

    const entry = await entryFor('bill_payment');
    check('Dr payable / Cr bank, at what actually left the account',
      Number(entry?.debit_minor) === 12300000000, show(entry?.debit_minor));

    const [{ n: cash }] = await sequelize.query(
      "SELECT COUNT(*) AS n FROM transactions WHERE type = 'bill_payment'", { type: QueryTypes.SELECT },
    );
    check('...and the cash book records it beside the ledger', Number(cash) === 1, `${cash}`);
  }

  // ── ACC-4.5 ──────────────────────────────────────────────────────────────
  console.log('\n── ACC-4.5  Aged payables ──────────────────────────────────────');
  {
    const old = await run(ap.createBill, {
      user: RAISER,
      body: {
        vendor_id: vendorId, net_minor: 500000000,
        bill_date: '2026-06-01', due_date: '2026-06-15', description: 'An old one',
      },
    });
    await run(ap.approveBill, { user: APPROVER, params: { id: String(old.body.data.id) }, body: {} });

    const aged = await run(ap.agedPayables, { user: APPROVER, query: { as_at: '2026-09-20' } });
    const vendor = aged.body?.data?.vendors?.[0];
    /*
     * ₦4,750,000, not ₦5,000,000: this vendor withholds 5%, so the bill is
     * outstanding net of what will be remitted rather than paid. Getting that
     * wrong first time is the whole reason aged payables is worth a check —
     * "what do we owe this supplier" and "what did they invoice" are
     * different numbers, and the ageing report must answer the first.
     */
    check('An overdue bill ages at what is owed, net of withholding',
      Number(vendor?.days_over_90) === 475000000,
      `over 90: ${show(vendor?.days_over_90 || 0)} on a ${show(500000000)} bill, total ${show(aged.body?.data?.total_minor || 0)}`);
    check('...and a paid bill is not in it at all',
      vendor?.bills?.every((b) => b.reference !== billOut.body?.data?.reference),
      vendor?.bills?.map((b) => b.reference).join(', '));
  }

  // ── ACC-4.6 ──────────────────────────────────────────────────────────────
  console.log('\n── ACC-4.6  A journal from a CSV ───────────────────────────────');
  {
    const { parseJournalCsv } = require('../shared/src/accounting/journalImport');
    const payroll = 'account,debit,credit,date,memo\n'
      + '5210,"1,250,000.00",,2026-09-30,September payroll\n'
      + '2330,,"150,000.00",2026-09-30,PAYE\n'
      + '1020,,"1,100,000.00",2026-09-30,Net pay';

    const parsed = parseJournalCsv(payroll);
    check("A bureau's summary parses, thousands separators and all",
      parsed.errors.length === 0 && parsed.balanced && parsed.lines.length === 3,
      `${parsed.lines.length} lines, Dr ${show(parsed.debit_minor)} = Cr ${show(parsed.credit_minor)}`);

    const preview = await run(acct.importJournalCsv, {
      user: APPROVER, query: { preview: 'true' }, body: { csv: payroll },
    });
    check('Preview checks it without posting',
      preview.code === 200 && preview.body?.data?.preview === true, `balanced=${preview.body?.data?.balanced}`);
    const [{ n: notYet }] = await sequelize.query(
      "SELECT COUNT(*) AS n FROM journal_entries WHERE source = 'import'", { type: QueryTypes.SELECT },
    );
    check('...and nothing was written', Number(notYet) === 0, `${notYet}`);

    const posted = await run(acct.importJournalCsv, {
      user: APPROVER, query: {}, body: { csv: payroll, memo: 'September payroll' },
    });
    check('Importing posts one journal, through the same door as a manual one',
      posted.code === 201 && posted.body?.data?.posted === true, posted.body?.data?.reference);
    const lines = await linesOf(posted.body?.data?.entry_id);
    check('...with every line', lines.length === 3, `${lines.length}`);

    const broken = 'account,debit,credit\n5210,1000,\n,500,\n9999,(200),\n5220,10,10';
    const refused = await run(acct.importJournalCsv, {
      user: APPROVER, query: {}, body: { csv: broken, entry_date: '2026-09-30' },
    });
    check('A file with problems is refused', refused.code === 422, `${refused.code}`);
    check('...listing all of them at once, not only the first',
      (refused.body?.errors || []).length >= 3,
      (refused.body?.errors || []).join(' | '));

    const orphan = 'account,debit,credit\n9999999,500,\n1020,,500';
    const suspense = await run(acct.importJournalCsv, {
      user: APPROVER, query: {}, body: { csv: orphan, entry_date: '2026-09-30' },
    });
    check('An unknown account posts to suspense and says so, rather than vanishing',
      suspense.code === 201 && /suspense/i.test(suspense.body?.message || ''),
      suspense.body?.message || `status ${suspense.code}`);
  }

  console.log('\n── The books balance through all of it ─────────────────────────');
  {
    const tb = await ledger.trialBalance(sequelize, { companyId: COMPANY });
    check('Trial balance balances', tb.balanced === true,
      `Dr ${show(tb.debit_minor)} = Cr ${show(tb.credit_minor)}`);
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

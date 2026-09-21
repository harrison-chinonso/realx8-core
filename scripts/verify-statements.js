/**
 * The statements a company files from (ACC-5).
 *
 * ── What is actually being checked ──────────────────────────────────────────
 *
 * Not that a profit and loss adds up — a sum of a column is not where this
 * goes wrong. The failures worth catching are the ones that produce a
 * statement which looks complete:
 *
 * That the balance sheet BALANCES after trading, which it only does if
 * retained earnings is computed from the same journal the profit and loss was.
 * Storing it is how the two come apart, and a balance sheet that disagrees
 * with the statement above it is worse than no balance sheet.
 *
 * That the cash flow RECONCILES to the movement in the bank. An indirect cash
 * flow is a classification exercise, and an account the classifier has not
 * been taught about produces three tidy sections that are wrong by exactly the
 * amount it could not place.
 *
 * That aged receivables agrees with the AR control account — the property that
 * makes a subledger a subledger.
 *
 * That the VAT return does not count output tax twice when revenue is
 * recognised at handover. The tax followed the invoice; the recognition
 * happened later; a return that picked up both would overstate what is owed.
 *
 * And that the exported journal goes back in where it came out, because that
 * round trip is the exit guarantee a company is being asked to rely on.
 *
 * Drives the REAL controllers against a throwaway database.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { QueryTypes } = require('sequelize');
const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_statements`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifystmt';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};
const show = (minor) => `₦${(Number(minor) / 100).toLocaleString('en-US')}`;

const COMPANY = 1;
const PROJECT = 3;

const run = (handler, req) => new Promise((resolve) => {
  let code = 200;
  const headers = {};
  const res = {
    status(c) { code = c; return res; },
    json(body) { resolve({ code, body, headers }); return res; },
    setHeader(k, v) { headers[k] = v; return res; },
    send(body) { resolve({ code, body, headers }); return res; },
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
  const propertyModels = require('../services/property-service/src/models');

  await userModels.Company.sync({ force: true });
  await userModels.RealtorLevel.sync({ force: true });
  await userModels.User.sync({ force: true });
  await userModels.Setting.sync({ force: true });
  await userModels.Company.create({
    id: COMPANY, name: 'Statements Test Co', slug: 'stmt-test', email: 'stmt@test',
  });
  await userModels.User.create({
    id: 601, name: 'Buyer One', email: 'b1@test', password: 'x', type: 'client', company_id: COMPANY,
  });

  await propertyModels.Branch.sync({ force: true });
  await propertyModels.PropertyUnit.sync({ force: true });
  await propertyModels.Property.sync({ force: true });
  await propertyModels.PropertyUnits.sync({ force: true });
  await propertyModels.Property.create({
    id: PROJECT, name: 'Ilupeju Court', type: 'estate', company_id: COMPANY, status: 'available',
  });
  await propertyModels.PropertyUnits.bulkCreate([
    { id: 21, property_id: PROJECT, name: 'Flat 1', size: '100', price: 40000000, quantity: 1 },
    { id: 22, property_id: PROJECT, name: 'Flat 2', size: '100', price: 40000000, quantity: 1 },
  ]);

  await models.LedgerAccount.sync({ force: true });
  await models.JournalEntry.sync({ force: true });
  await models.JournalLine.sync({ force: true });
  await models.Vendor.sync({ force: true });
  await models.Bill.sync({ force: true });
  await models.Transaction.sync({ force: true });
  await models.ExpenseType.sync({ force: true });
  await models.AccountingPolicy.sync({ force: true });
  await models.Handover.sync({ force: true });
  await models.Tax.sync({ force: true });
  await models.ReminderSchedule.sync({ force: true });
  await models.Invoice.sync({ force: true });
  await models.InstallmentPlan.sync({ force: true });
  await models.InvoicePaymentPlan.sync({ force: true });
  await models.InvoicePayment.sync({ force: true });

  await require('../services/finance-service/src/migrations/seedChartOfAccounts')(sequelize);
  await require('../services/finance-service/src/migrations/seedExpenseTypes')(sequelize);
  await userModels.Setting.create({
    group: 'accounting', key: 'post_to_ledger', value: 'true', company_id: COMPANY,
  });

  const ap = require('../services/finance-service/src/controllers/payablesController');
  const ho = require('../services/finance-service/src/controllers/handoverController');
  const stmt = require('../services/finance-service/src/controllers/statementsController');
  const acct = require('../services/finance-service/src/controllers/accountingController');
  const { postEvent } = require('../shared/src/accounting/posting');

  const STAFF = { id: 70, company_id: COMPANY, type: 'admin' };
  const OTHER = { id: 71, company_id: COMPANY, type: 'admin' };

  const typeNamed = async (name) => {
    const [row] = await sequelize.query(
      'SELECT id FROM expense_types WHERE company_id = :c AND name = :name LIMIT 1',
      { replacements: { c: COMPANY, name }, type: QueryTypes.SELECT },
    );
    return row?.id;
  };

  // ── A year of trading ─────────────────────────────────────────────────────
  console.log('\n── A year of trading, posted through the real controllers ──────');

  const vendor = await run(ap.createVendor, { user: STAFF, body: { name: 'Builders Ltd', withholding_rate: 5 } });
  const vendorId = vendor.body.data.id;
  const buildType = await typeNamed('Subcontractor works');
  const adminType = await typeNamed('Administration');

  const raiseAndApprove = async (body) => {
    const raised = await run(ap.createBill, { user: STAFF, body });
    await run(ap.approveBill, { user: OTHER, params: { id: String(raised.body.data.id) }, body: {} });
    return raised.body.data;
  };

  // ₦80m of build cost, capitalised.
  await raiseAndApprove({
    vendor_id: vendorId, net_minor: 8000000000, tax_minor: 600000000,
    bill_date: '2026-02-01', property_id: PROJECT, expense_type_id: buildType,
    description: 'Blocks 1 and 2',
  });
  // ₦6m of administration, expensed.
  await raiseAndApprove({
    vendor_id: vendorId, net_minor: 600000000,
    bill_date: '2026-03-01', expense_type_id: adminType, description: 'Office rent',
  });

  // Two ₦50m sales, invoiced with 7.5% VAT, revenue deferred to handover.
  const invoices = [];
  for (const [unitId, ref] of [[21, 'INV-0001'], [22, 'INV-0002']]) {
    // eslint-disable-next-line no-await-in-loop
    const invoice = await models.Invoice.create({
      company_id: COMPANY,
      invoice_id: ref,
      client_id: 601,
      property_id: PROJECT,
      // Major units: ₦50,000,000 plus ₦3,750,000 of VAT, which is what the
      // journal below puts into the receivables control account.
      amount: 53750000,
      status: 'sent',
      type: 'property_sale',
      due_date: '2026-05-01',
    });
    /*
     * Dated afterwards, in SQL.
     *
     * Sequelize manages createdAt itself and silently overwrites whatever a
     * fixture passes for it, so an invoice "raised in April" arrives stamped
     * today — and an ageing report asked for August then sees nothing at all.
     * `invoices` has no separate issue date, so created_at IS the date it was
     * raised and the fixture has to say so directly.
     */
    // eslint-disable-next-line no-await-in-loop
    await sequelize.query(
      "UPDATE invoices SET created_at = '2026-04-01 09:00:00' WHERE id = :id",
      { replacements: { id: invoice.id }, type: QueryTypes.UPDATE },
    );
    // eslint-disable-next-line no-await-in-loop
    await models.InvoicePaymentPlan.create({
      invoice_id: invoice.id, payment_type: 'outright',
      property_unit_id: unitId, unit_price_minor: 5000000000,
    });
    // eslint-disable-next-line no-await-in-loop
    await postEvent(sequelize, {
      rule: 'invoice',
      companyId: COMPANY,
      entryDate: '2026-04-01',
      source: 'invoice',
      sourceId: String(invoice.id),
      memo: ref,
      input: {
        grossMinor: 5000000000,
        vatMinor: 375000000,
        recognition: 'ON_HANDOVER',
        dimensions: { property_id: PROJECT, party_id: 601, party_type: 'client' },
      },
    });
    invoices.push(invoice);
  }

  /*
   * The first buyer pays in full — recorded as a payment row AND posted.
   *
   * Both, because they answer different questions: the row is what aged
   * receivables reads, the journal is what the control account reads, and the
   * two agreeing is the property the ageing report exists to demonstrate.
   */
  await models.InvoicePayment.create({
    invoice_id: invoices[0].id,
    amount: 53750000,
    payment_method: 'transfer',
    status: 'completed',
    company_id: COMPANY,
  });
  await sequelize.query(
    "UPDATE invoice_payments SET created_at = '2026-05-01 10:00:00' WHERE invoice_id = :id",
    { replacements: { id: invoices[0].id }, type: QueryTypes.UPDATE },
  );

  await postEvent(sequelize, {
    rule: 'invoice_payment',
    companyId: COMPANY,
    entryDate: '2026-05-01',
    source: 'invoice_payment',
    sourceId: `${invoices[0].id}:1`,
    memo: 'Payment on INV-0001',
    input: {
      amountMinor: 5375000000,
      dimensions: { property_id: PROJECT, party_id: 601, party_type: 'client' },
    },
  });

  // And the first unit is handed over.
  const handover = await run(ho.recordHandover, {
    user: STAFF,
    body: {
      invoice_id: invoices[0].id,
      handover_date: '2026-06-30',
      acknowledgement_url: 'https://res.cloudinary.com/demo/image/upload/v1/ack.png',
    },
  });
  check('One sale recognised, one still deferred',
    handover.body?.posted === true, handover.body?.message);

  const WINDOW = { from: '2026-01-01', to: '2026-12-31' };

  // ── ACC-5.2 ───────────────────────────────────────────────────────────────
  console.log('\n── ACC-5.2  Profit and loss ────────────────────────────────────');
  {
    const out = await run(stmt.profitAndLoss, { user: STAFF, query: { ...WINDOW, compare: 'none' } });
    const pl = out.body.data;
    check('Only the handed-over sale is revenue',
      pl.revenue_minor === 5000000000,
      `${show(pl.revenue_minor)} — the second is still deferred`);
    check('Its cost of sales is the unit\'s share of the project',
      pl.cost_of_sales_minor === 4000000000,
      `${show(pl.cost_of_sales_minor)} — half of ${show(8000000000)}`);
    check('Gross profit is the difference',
      pl.gross_profit_minor === 1000000000, show(pl.gross_profit_minor));
    check('Office rent is an overhead, not a cost of sale',
      pl.overheads_minor === 600000000,
      pl.overheads.map((r) => `${r.code} ${show(r.balance_minor)}`).join(' · '));
    check('Net profit', pl.net_profit_minor === 400000000, show(pl.net_profit_minor));

    const withCompare = await run(stmt.profitAndLoss, { user: STAFF, query: WINDOW });
    check('A comparative period is offered without being asked for',
      withCompare.body.data.previous !== null
      && withCompare.body.data.compare_from === '2025-01-01',
      `${withCompare.body.data.compare_from} to ${withCompare.body.data.compare_to}`);

    const perProject = await run(stmt.profitAndLoss, {
      user: STAFF, query: { ...WINDOW, compare: 'none', property_id: String(PROJECT) },
    });
    check('ACC-5.2  Filterable to one project',
      perProject.body.data.revenue_minor === 5000000000
      && perProject.body.data.overheads_minor === 0,
      'the office rent was not coded to a project, so it is not in the project P&L');
  }

  // ── ACC-5.3 ───────────────────────────────────────────────────────────────
  console.log('\n── ACC-5.3  Balance sheet, retained earnings computed ──────────');
  {
    const out = await run(stmt.balanceSheet, { user: STAFF, query: { as_at: WINDOW.to } });
    const bs = out.body.data;
    check('It balances', bs.balanced === true,
      `assets ${show(bs.assets_minor)} = liabilities ${show(bs.liabilities_minor)} + equity ${show(bs.equity_minor)}`);
    check('Equity is this year\'s earnings, because nothing else is in it',
      bs.earnings_not_yet_closed_minor === 400000000,
      show(bs.earnings_not_yet_closed_minor));
    const wip = bs.assets.find((row) => row.role === 'DEVELOPMENT_WIP');
    check('The unsold unit is still carried as inventory',
      Number(wip?.balance_minor) === 4000000000, show(wip?.balance_minor));
    const deferred = bs.liabilities.find((row) => row.role === 'CONTRACT_LIABILITY');
    check('...and the sale not yet handed over is still a liability',
      Number(deferred?.balance_minor) === 5000000000, show(deferred?.balance_minor));
  }

  // ── ACC-5.4 ───────────────────────────────────────────────────────────────
  console.log('\n── ACC-5.4  Cash flow, indirect ────────────────────────────────');
  {
    const out = await run(stmt.cashFlow, { user: STAFF, query: WINDOW });
    const cf = out.body.data;
    check('It reconciles to the movement in the bank',
      cf.reconciles === true,
      `net ${show(cf.net_movement_minor)} = cash ${show(cf.cash_movement_minor)}`);
    check('...which is the one payment received',
      cf.cash_movement_minor === 5375000000, show(cf.cash_movement_minor));
  }

  // ── ACC-5.9 ───────────────────────────────────────────────────────────────
  console.log('\n── ACC-5.9  The same trading, on a cash basis ──────────────────');
  {
    const out = await run(stmt.cashBasis, { user: STAFF, query: WINDOW });
    const cb = out.body.data;
    /*
     * The accrual profit counts the second sale's cost but not its cash; the
     * cash basis counts neither. The two differing is the whole point — if
     * they agreed, one of them would not be worth producing.
     */
    check('Cash and accrual disagree, which is why both exist',
      cb.cash_profit_minor !== cb.accrual_profit_minor,
      `cash ${show(cb.cash_profit_minor)} · accrual ${show(cb.accrual_profit_minor)}`);
    check('Cash revenue is accrual revenue less the rise in receivables',
      cb.cash_revenue_minor === cb.accrual_revenue_minor - cb.receivables_movement_minor,
      `${show(cb.accrual_revenue_minor)} less ${show(cb.receivables_movement_minor)}`);
  }

  // ── ACC-5.5 ───────────────────────────────────────────────────────────────
  console.log('\n── ACC-5.5  Aged receivables ───────────────────────────────────');
  {
    const out = await run(stmt.agedReceivables, { user: STAFF, query: { as_at: '2026-08-01' } });
    const aged = out.body.data;
    check('The unpaid invoice is overdue and the paid one is gone',
      aged.total_minor === 5375000000,
      `${show(aged.total_minor)} across ${aged.clients.length} client(s)`);
    check('It agrees with the receivables control account',
      aged.reconciles === true,
      `subledger ${show(aged.total_minor)} · control ${show(aged.control_balance_minor)}`);
    const client = aged.clients[0];
    check('...aged into the bucket its due date puts it in',
      client.days_over_90 === 5375000000,
      Object.entries(client).filter(([k, v]) => k.startsWith('days') && v).map(([k, v]) => `${k} ${show(v)}`).join(' · '));
  }

  // ── ACC-5.6 ───────────────────────────────────────────────────────────────
  console.log('\n── ACC-5.6  VAT return ─────────────────────────────────────────');
  {
    const out = await run(stmt.vatReturn, { user: STAFF, query: WINDOW });
    const vat = out.body.data;
    check('Output tax is charged once per sale, at the invoice',
      vat.output_tax_minor === 750000000,
      `${show(vat.output_tax_minor)} — two sales at ${show(375000000)}, and NOT again at handover`);
    check('Input tax is what the bills carried',
      vat.input_tax_minor === 600000000, show(vat.input_tax_minor));
    check('Net payable', vat.net_payable_minor === 150000000, show(vat.net_payable_minor));
  }

  // ── ACC-5.7 ───────────────────────────────────────────────────────────────
  console.log('\n── ACC-5.7  Withholding still to remit ─────────────────────────');
  {
    const out = await run(stmt.withholdingSchedule, { user: STAFF, query: WINDOW });
    const wht = out.body.data;
    check('Held, and not yet paid over',
      wht.outstanding_minor === 430000000,
      `${show(wht.outstanding_minor)} — 5% of ${show(8000000000)} and of ${show(600000000)}`);
  }

  // ── ACC-5.8 ───────────────────────────────────────────────────────────────
  console.log('\n── ACC-5.8  The export, and the round trip ─────────────────────');
  {
    const out = await run(stmt.exportJournal, { user: STAFF, query: WINDOW });
    const csv = String(out.body);
    check('It is a CSV with a header a person can read',
      csv.startsWith('date,account,debit,credit'), csv.split('\n')[0]);
    check('...and one row per journal line',
      csv.trim().split('\n').length - 1 === await sequelize.query(
        'SELECT COUNT(*) AS n FROM journal_lines', { type: QueryTypes.SELECT },
      ).then(([r]) => Number(r.n)),
      `${csv.trim().split('\n').length - 1} rows`);

    /*
     * The round trip. Two lines of the export are fed back through the import
     * that ACC-4.6 built — same columns, same reader. An export nobody can
     * read back in is not an exit guarantee, it is a file.
     */
    const lines = csv.trim().split('\n');
    const header = lines[0];
    /*
     * A WHOLE entry, not the first two rows.
     *
     * Taking two arbitrary rows takes two debits off the same bill, which of
     * course does not balance — the import was right to refuse it and the
     * test was wrong to expect otherwise. Grouping by the reference column is
     * what makes this a round trip rather than a syntax check.
     */
    const reference = (row) => row.split(',')[5];
    const first = reference(lines[1]);
    const sample = lines.slice(1).filter((row) => reference(row) === first).join('\n');
    const back = await run(acct.importJournalCsv, {
      user: STAFF,
      query: { preview: 'true' },
      body: { csv: `${header}\n${sample}`, entry_date: '2026-12-31' },
    });
    check('An exported journal reads back in through the import',
      back.code === 200 && back.body?.data?.balanced === true,
      `${back.body?.message || ''} ${(back.body?.errors || []).join(' | ')}`.trim()
        || `balanced=${back.body?.data?.balanced}`);
  }

  // ── ACC-5.1 ───────────────────────────────────────────────────────────────
  console.log('\n── ACC-5.1  Drilling from a figure to its document ─────────────');
  {
    const tb = await run(stmt.profitAndLoss, { user: STAFF, query: { ...WINDOW, compare: 'none' } });
    const costOfSales = tb.body.data.cost_of_sales[0];

    const all = await run(acct.listJournal, { user: STAFF, query: { ...WINDOW, limit: '200' } });
    const drilled = await run(acct.listJournal, {
      user: STAFF,
      query: { ...WINDOW, account_id: String(costOfSales.account_id), limit: '200' },
    });

    check('Drilling into an account returns fewer journals than the whole ledger',
      drilled.body.data.length > 0 && drilled.body.data.length < all.body.data.length,
      `${drilled.body.data.length} of ${all.body.data.length} touch ${costOfSales.code}`);

    /*
     * The check this endpoint exists for. A drill-through whose rows add up
     * to something other than the figure that was clicked has explained
     * nothing — and the obvious implementation, showing each ENTRY's total,
     * does exactly that: the handover entry is ₦90m across four legs and this
     * account's share of it is ₦40m.
     */
    const contributed = drilled.body.data.reduce(
      (total, row) => total + Number(row.account_debit_minor) - Number(row.account_credit_minor), 0,
    );
    check('...and they add up to the figure that was clicked',
      contributed === costOfSales.balance_minor,
      `${show(contributed)} against ${show(costOfSales.balance_minor)} on the statement`);

    const entryTotals = drilled.body.data.reduce((total, row) => total + Number(row.debit_minor), 0);
    check('...which is NOT the total of those journals',
      entryTotals !== contributed,
      `the entries total ${show(entryTotals)}; this account took ${show(contributed)} of it`);

    const one = await run(acct.getJournalEntry, {
      user: STAFF, params: { id: String(drilled.body.data[0].id) },
    });
    check('An entry opens with every line and the account each one hit',
      one.code === 200 && one.body.data.lines.length >= 2
      && one.body.data.lines.every((l) => l.account_code),
      one.body.data.lines.map((l) => l.account_code).join(', '));
    check('...and says which document caused it, for the last step out',
      Boolean(one.body.data.source), `${one.body.data.source} ${one.body.data.source_id || ''}`);
  }

  // ── ACC-5.2, the dimension filter ─────────────────────────────────────────
  console.log('\n── ACC-5.2  One project, through the pack ──────────────────────');
  {
    const filtered = await run(stmt.statementPack, {
      user: STAFF, query: { ...WINDOW, property_id: String(PROJECT) },
    });
    const whole = await run(stmt.statementPack, { user: STAFF, query: WINDOW });

    check('The filter reaches the profit and loss',
      filtered.body.data.profit_and_loss.overheads_minor === 0
      && whole.body.data.profit_and_loss.overheads_minor === 600000000,
      'the office rent was not coded to a project, so it leaves the project P&L');
    check('...and is echoed back, so a filtered statement cannot be mistaken for a whole one',
      Number(filtered.body.data.property_id) === PROJECT
      && whole.body.data.property_id === null, '');
    check('The balance sheet is NOT filtered, because it cannot be',
      filtered.body.data.balance_sheet.assets_minor === whole.body.data.balance_sheet.assets_minor,
      'a bank account cannot be divided between projects');
  }

  // ── ACC-5.10, in part ─────────────────────────────────────────────────────
  console.log('\n── Everything at once, from one read ───────────────────────────');
  {
    const out = await run(stmt.statementPack, { user: STAFF, query: WINDOW });
    const checks = out.body.data.checks;
    check('The pack leads with whether it can be relied on',
      checks.trial_balance_balanced && checks.balance_sheet_balanced
      && checks.cash_flow_reconciles && checks.receivables_reconcile,
      Object.entries(checks).map(([k, v]) => `${k}=${v}`).join(' · '));
    check('...and the profit in it is the profit in the P&L',
      out.body.data.profit_and_loss.net_profit_minor === 400000000,
      show(out.body.data.profit_and_loss.net_profit_minor));
  }

  console.log(`\n  ${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass}/${pass + fail} checks passed.\x1b[0m\n`);

  await sequelize.close();
  if (!process.env.KEEP_DB) await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  console.log(`  Scratch database ${DB} dropped.\n`);
  await admin.end();
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error('\x1b[31mThe verification itself failed:\x1b[0m', error);
  process.exit(1);
});

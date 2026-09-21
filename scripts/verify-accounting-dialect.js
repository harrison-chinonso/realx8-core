/**
 * The accounting module, against BOTH engines, compared answer by answer.
 *
 * ── Why this is separate from verify:dialect ────────────────────────────────
 *
 * That suite proves the queries it was written for still behave. This one
 * proves the ACCOUNTING queries do — the statements, the WIP report, the close
 * checklist, the bank reconciliation — and it does something the other does
 * not: it runs the same scenario on MySQL and on Postgres and demands the two
 * produce the SAME NUMBERS, not merely that neither threw.
 *
 * A query that parses on both and answers differently is the dangerous case.
 * `ORDER BY company_id IS NULL DESC` sorts one way on MySQL and the other on
 * Postgres; `GROUP BY` accepts columns on MySQL it rejects on Postgres; a
 * boolean compared to 1 matches on one and matches nothing on the other. None
 * of those throw where it would be noticed.
 *
 * ── The schema comes from the models, not from hand-written DDL ─────────────
 *
 * Sequelize emits the right types for each engine, which is the point: if a
 * model cannot be created on Postgres, that is the finding. Hand-writing the
 * DDL twice would test the DDL rather than the application.
 *
 * Postgres comes from PG_* (defaults suit the realx8-pg container on 5433). If
 * it is not reachable the run SKIPS loudly rather than passing.
 *
 *   npm run verify:acct-dialect
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { QueryTypes } = require('sequelize');
const mysql = require('mysql2/promise');
const { Client } = require('pg');

const MYSQL_DB = `${process.env.DB_NAME || 'realto'}_verify_acctdialect`;
const PG = {
  host: process.env.PG_HOST || 'localhost',
  port: Number(process.env.PG_PORT || 5433),
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
  database: process.env.PG_DATABASE_ACCT || 'realx8_acct_dialect',
};

const COMPANY = 1;
const PROJECT = 5;

let pass = 0; let fail = 0;
const answers = { mysql: {}, postgres: {} };

const record = (engine, key, value) => { answers[engine][key] = value; };

const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

/**
 * Run the whole accounting story on one engine and return what it answered.
 *
 * Deliberately one function rather than a per-engine variant: the moment the
 * two diverge in the SCRIPT, the comparison stops meaning anything.
 */
const runOn = async (engine) => {
  /*
   * The models read their connection from the environment at require time, so
   * the cache has to be cleared between engines. Ugly, and the alternative —
   * a second process — cannot compare the two sets of answers in one place.
   */
  Object.keys(require.cache).forEach((key) => {
    if (/Realx8-Core\/(services|shared)\//.test(key)) delete require.cache[key];
  });

  const models = require('../services/finance-service/src/models');
  const { sequelize } = models;
  const userModels = require('../services/user-service/src/models');
  const propertyModels = require('../services/property-service/src/models');

  await userModels.Company.sync({ force: true });
  await userModels.RealtorLevel.sync({ force: true });
  await userModels.User.sync({ force: true });
  await userModels.Setting.sync({ force: true });
  await userModels.Company.create({
    id: COMPANY, name: 'Dialect Co', slug: `dialect-${engine}`, email: `d@${engine}`,
  });
  await userModels.User.create({
    id: 901, name: 'Buyer', email: `b@${engine}`, password: 'x', type: 'client', company_id: COMPANY,
  });

  await propertyModels.Branch.sync({ force: true });
  await propertyModels.PropertyUnit.sync({ force: true });
  await propertyModels.Property.sync({ force: true });
  await propertyModels.PropertyUnits.sync({ force: true });
  await propertyModels.Property.create({
    id: PROJECT, name: 'Dialect Estate', type: 'estate', company_id: COMPANY, status: 'available',
  });
  await propertyModels.PropertyUnits.bulkCreate([
    { id: 31, property_id: PROJECT, name: 'Unit A', size: '100', price: 40000000, quantity: 1 },
    { id: 32, property_id: PROJECT, name: 'Unit B', size: '300', price: 60000000, quantity: 1 },
  ]);

  /* Every table the accounting module owns, created from its own model. */
  for (const model of [
    'LedgerAccount', 'JournalEntry', 'JournalLine', 'Vendor', 'Bill', 'Transaction',
    'ExpenseType', 'AccountingPolicy', 'Handover', 'AccountingPeriod',
    'BankStatementLine', 'BankReconciliation', 'ImportMapping',
    'Tax', 'ReminderSchedule', 'Invoice', 'InstallmentPlan', 'InvoicePaymentPlan',
    'InvoicePayment', 'Refund',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await models[model].sync({ force: true });
  }

  await require('../services/finance-service/src/migrations/seedChartOfAccounts')(sequelize);
  await require('../services/finance-service/src/migrations/seedExpenseTypes')(sequelize);
  await userModels.Setting.create({
    group: 'accounting', key: 'post_to_ledger', value: 'true', company_id: COMPANY,
  });

  const run = (handler, req) => new Promise((resolve) => {
    let code = 200;
    const res = {
      status(c) { code = c; return res; },
      json(body) { resolve({ code, body }); return res; },
      setHeader() { return res; },
      send(body) { resolve({ code, body }); return res; },
    };
    Promise.resolve(handler(req, res, (err) => resolve({ code: 500, body: { error: err?.message || String(err) } })))
      .catch((err) => resolve({ code: 500, body: { error: err?.message || String(err) } }));
  });

  const ap = require('../services/finance-service/src/controllers/payablesController');
  const dev = require('../services/finance-service/src/controllers/developmentController');
  const ho = require('../services/finance-service/src/controllers/handoverController');
  const stmt = require('../services/finance-service/src/controllers/statementsController');
  const periodCtl = require('../services/finance-service/src/controllers/periodsController');
  const bank = require('../services/finance-service/src/controllers/bankRecController');
  const { postEvent } = require('../shared/src/accounting/posting');

  const STAFF = { id: 50, company_id: COMPANY, type: 'admin' };
  const OTHER = { id: 51, company_id: COMPANY, type: 'admin' };

  const typeId = async (name) => sequelize.query(
    'SELECT id FROM expense_types WHERE company_id = :c AND name = :name LIMIT 1',
    { replacements: { c: COMPANY, name }, type: QueryTypes.SELECT },
  ).then(([row]) => row?.id);

  record(engine, 'chart_seeded', await sequelize.query(
    'SELECT COUNT(*) AS n FROM ledger_accounts', { type: QueryTypes.SELECT },
  ).then(([r]) => Number(r.n)));
  record(engine, 'cost_types_seeded', await sequelize.query(
    'SELECT COUNT(*) AS n FROM expense_types', { type: QueryTypes.SELECT },
  ).then(([r]) => Number(r.n)));

  // ── Costs ────────────────────────────────────────────────────────────────
  const vendor = await run(ap.createVendor, {
    user: STAFF, body: { name: 'Contractor', withholding_rate: 5 },
  });
  const buildType = await typeId('Subcontractor works');
  const adminType = await typeId('Administration');

  const raiseAndApprove = async (body) => {
    const raised = await run(ap.createBill, { user: STAFF, body });
    await run(ap.approveBill, { user: OTHER, params: { id: String(raised.body.data.id) }, body: {} });
    return raised;
  };

  await raiseAndApprove({
    vendor_id: vendor.body.data.id,
    net_minor: 4000000000,
    tax_minor: 300000000,
    bill_date: '2026-02-01',
    property_id: PROJECT,
    expense_type_id: buildType,
    description: 'Build',
  });
  await raiseAndApprove({
    vendor_id: vendor.body.data.id,
    net_minor: 500000000,
    bill_date: '2026-02-10',
    expense_type_id: adminType,
    description: 'Office',
  });

  // ── A sale, deferred, then handed over ───────────────────────────────────
  const invoice = await models.Invoice.create({
    company_id: COMPANY,
    invoice_id: 'INV-D001',
    client_id: 901,
    property_id: PROJECT,
    amount: 21500000,
    status: 'sent',
    type: 'property_sale',
    due_date: '2026-04-30',
  });
  await sequelize.query(
    "UPDATE invoices SET created_at = '2026-03-01 09:00:00' WHERE id = :id",
    { replacements: { id: invoice.id }, type: QueryTypes.UPDATE },
  );
  await models.InvoicePaymentPlan.create({
    invoice_id: invoice.id, payment_type: 'outright',
    property_unit_id: 31, unit_price_minor: 2000000000,
  });
  await postEvent(sequelize, {
    rule: 'invoice',
    companyId: COMPANY,
    entryDate: '2026-03-01',
    source: 'invoice',
    sourceId: String(invoice.id),
    memo: 'INV-D001',
    input: {
      grossMinor: 2000000000,
      vatMinor: 150000000,
      recognition: 'ON_HANDOVER',
      dimensions: { property_id: PROJECT, party_id: 901, party_type: 'client' },
    },
  });

  record(engine, 'awaiting_handover', await run(ho.awaitingHandover, { user: STAFF, query: {} })
    .then((r) => (r.body.data || []).map((row) => [row.reference, Number(row.deferred_minor)])));

  const handover = await run(ho.recordHandover, {
    user: STAFF,
    body: {
      invoice_id: invoice.id,
      handover_date: '2026-06-30',
      acknowledgement_url: 'https://res.cloudinary.com/demo/image/upload/v1/ack.png',
    },
  });
  record(engine, 'handover_posted', handover.body?.posted === true);
  record(engine, 'handover_cost', Number(handover.body?.data?.cost_released_minor));

  // ── The reports ──────────────────────────────────────────────────────────
  const WINDOW = { from: '2026-01-01', to: '2026-12-31' };

  record(engine, 'wip', await run(dev.wipReport, { user: STAFF, query: {} }).then((r) => ({
    control: Number(r.body.data?.control_balance_minor),
    projects: Number(r.body.data?.projects_balance_minor),
    unassigned: Number(r.body.data?.unassigned_minor),
    units: (r.body.data?.projects?.[0]?.units || []).map((u) => [u.name, u.allocated_minor]),
  })));

  record(engine, 'project_detail', await run(dev.projectDetail, {
    user: STAFF, params: { propertyId: String(PROJECT) }, query: {},
  }).then((r) => ({
    basis: r.body.data?.basis,
    capitalised: Number(r.body.data?.movements?.capitalised_minor),
    released: Number(r.body.data?.movements?.released_minor),
    catch_up: Number(r.body.data?.catch_up_minor),
  })));

  record(engine, 'profit_and_loss', await run(stmt.profitAndLoss, {
    user: STAFF, query: { ...WINDOW, compare: 'none' },
  }).then((r) => ({
    revenue: Number(r.body.data?.revenue_minor),
    cost_of_sales: Number(r.body.data?.cost_of_sales_minor),
    overheads: Number(r.body.data?.overheads_minor),
    net: Number(r.body.data?.net_profit_minor),
  })));

  record(engine, 'balance_sheet', await run(stmt.balanceSheet, {
    user: STAFF, query: { as_at: WINDOW.to },
  }).then((r) => ({
    assets: Number(r.body.data?.assets_minor),
    liabilities: Number(r.body.data?.liabilities_minor),
    equity: Number(r.body.data?.equity_minor),
    balanced: r.body.data?.balanced,
  })));

  record(engine, 'cash_flow', await run(stmt.cashFlow, { user: STAFF, query: WINDOW })
    .then((r) => ({
      profit: Number(r.body.data?.profit_minor),
      net_movement: Number(r.body.data?.net_movement_minor),
      cash_movement: Number(r.body.data?.cash_movement_minor),
      reconciles: r.body.data?.reconciles,
    })));

  record(engine, 'cash_basis', await run(stmt.cashBasis, { user: STAFF, query: WINDOW })
    .then((r) => Number(r.body.data?.cash_profit_minor)));

  record(engine, 'aged_receivables', await run(stmt.agedReceivables, {
    user: STAFF, query: { as_at: '2026-08-01' },
  }).then((r) => ({
    total: Number(r.body.data?.total_minor),
    control: Number(r.body.data?.control_balance_minor),
    reconciles: r.body.data?.reconciles,
    buckets: r.body.data?.buckets,
  })));

  record(engine, 'vat', await run(stmt.vatReturn, { user: STAFF, query: WINDOW })
    .then((r) => [
      Number(r.body.data?.output_tax_minor),
      Number(r.body.data?.input_tax_minor),
      Number(r.body.data?.net_payable_minor),
    ]));

  record(engine, 'withholding', await run(stmt.withholdingSchedule, { user: STAFF, query: WINDOW })
    .then((r) => Number(r.body.data?.outstanding_minor)));

  record(engine, 'deferred_revenue', await run(ho.deferredRevenue, { user: STAFF, query: {} })
    .then((r) => ({
      total: Number(r.body.data?.total_minor),
      unexplained: Number(r.body.data?.unexplained_minor),
    })));

  record(engine, 'export_rows', await run(stmt.exportJournal, { user: STAFF, query: WINDOW })
    .then((r) => String(r.body).trim().split('\n').length));

  record(engine, 'pack_checks', await run(stmt.statementPack, { user: STAFF, query: WINDOW })
    .then((r) => r.body.data?.checks));

  // ── Periods ──────────────────────────────────────────────────────────────
  await run(periodCtl.createPeriods, { user: STAFF, body: { year: 2026 } });
  const periodList = await run(periodCtl.listPeriods, { user: STAFF, query: {} });
  const june = periodList.body.data.find((p) => String(p.starts_on).slice(0, 10) === '2026-06-01');

  record(engine, 'periods_created', periodList.body.data.length);
  record(engine, 'checklist', await run(periodCtl.checkPeriod, {
    user: STAFF, params: { id: String(june.id) },
  }).then((r) => (r.body.data?.checks || []).map((c) => [c.key, c.status])));

  // ── The bank ─────────────────────────────────────────────────────────────
  const bankAccount = await run(bank.bankAccounts, { user: STAFF, query: {} })
    .then((r) => r.body.data.find((a) => a.role === 'BANK'));

  const STATEMENT = [
    'Value Date,Narration,Reference,Withdrawals,Lodgement',
    '05/03/2026,TRF FRM BUYER,INV-D001,,"215,000.00"',
    '31/03/2026,COMMISSION ON TURNOVER,CHG-0331,"1,075.00",',
  ].join('\n');

  record(engine, 'bank_import', await run(bank.importStatement, {
    user: STAFF,
    query: {},
    body: { account_id: bankAccount.id, csv: STATEMENT, source: 'TestBank' },
  }).then((r) => ({ code: r.code, imported: Number(r.body.data?.to_import) })));

  record(engine, 'bank_reimport', await run(bank.importStatement, {
    user: STAFF,
    query: {},
    body: { account_id: bankAccount.id, csv: STATEMENT, source: 'TestBank' },
  }).then((r) => r.code));

  record(engine, 'bank_lines', await run(bank.listLines, {
    user: STAFF, query: { account_id: String(bankAccount.id) },
  }).then((r) => (r.body.data || []).map((l) => [
    String(l.statement_date).slice(0, 10), Number(l.amount_minor), l.status,
  ])));

  record(engine, 'bank_summary', await run(bank.summary, {
    user: STAFF, query: { account_id: String(bankAccount.id), as_at: '2026-12-31' },
  }).then((r) => ({
    ledger: Number(r.body.data?.ledger_balance_minor),
    unmatched: Number(r.body.data?.unmatched_lines),
  })));

  record(engine, 'mappings', await run(bank.listMappings, {
    user: STAFF, query: { kind: 'bank_statement' },
  }).then((r) => (r.body.data || []).map((m) => m.source)));

  record(engine, 'suggestions', await run(bank.suggestions, {
    user: STAFF, query: { account_id: String(bankAccount.id) },
  }).then((r) => (r.body.data || []).map((row) => [
    row.line.reference, row.suggestions.length, row.suggestions[0]?.certainty || null,
  ])));

  /*
   * A trial balance with a window in the future. The subquery form was written
   * because the obvious LEFT JOIN filtered the ENTRY and not the LINE — on
   * MySQL. Whether it also did so on Postgres was never established, so it is
   * established here.
   */
  const { trialBalance } = require('../shared/src/accounting/ledger');
  record(engine, 'trial_balance', await trialBalance(sequelize, { companyId: COMPANY })
    .then((tb) => ({ dr: tb.debit_minor, cr: tb.credit_minor, balanced: tb.balanced })));
  record(engine, 'trial_balance_future', await trialBalance(sequelize, {
    companyId: COMPANY, from: '2030-01-01', to: '2030-12-31',
  }).then((tb) => ({ dr: tb.debit_minor, cr: tb.credit_minor, accounts: tb.accounts.length })));

  await sequelize.close();
};

(async () => {
  console.log('\n── The accounting module on MySQL ──────────────────────────────');
  {
    const admin = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });
    await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
    await admin.query(`CREATE DATABASE \`${MYSQL_DB}\``);
    await admin.end();

    process.env.DB_NAME = MYSQL_DB;
    process.env.DB_DIALECT = 'mysql';
    process.env.CACHE_PREFIX = 'acctdialectmy';
    await runOn('mysql');
    console.log('  ran.');
  }

  console.log('\n── The same thing on Postgres ──────────────────────────────────');
  let postgresRan = false;
  try {
    const client = new Client({ ...PG, database: 'postgres' });
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS ${PG.database}`);
    await client.query(`CREATE DATABASE ${PG.database}`);
    await client.end();

    process.env.DB_DIALECT = 'postgres';
    process.env.DB_HOST_PG = PG.host;
    process.env.DB_NAME = PG.database;
    process.env.DB_HOST = PG.host;
    process.env.DB_PORT = String(PG.port);
    process.env.DB_USER = PG.user;
    process.env.DB_PASSWORD = PG.password;
    process.env.CACHE_PREFIX = 'acctdialectpg';
    await runOn('postgres');
    postgresRan = true;
    console.log('  ran.');
  } catch (error) {
    console.log(`\n  \x1b[33mSKIPPED — Postgres was not reachable: ${error.message}\x1b[0m`);
    console.log('  Start it with:  docker start realx8-pg\n');
  }

  if (!postgresRan) {
    console.log('\n  \x1b[33mNo comparison was made. This run proves nothing about Postgres.\x1b[0m\n');
    process.exit(1);
  }

  console.log('\n── The two engines, answer by answer ───────────────────────────');
  const keys = Object.keys(answers.mysql);
  keys.forEach((key) => {
    const left = JSON.stringify(answers.mysql[key]);
    const right = JSON.stringify(answers.postgres[key]);
    check(
      key.replace(/_/g, ' '),
      left === right,
      left === right ? left.slice(0, 160) : `mysql    ${left}\n        postgres ${right}`,
    );
  });

  /*
   * Named separately because a silent nothing is the failure mode this whole
   * file exists for: two engines that agree because neither did anything.
   */
  check('Both engines actually did the work',
    answers.mysql.chart_seeded > 60 && answers.postgres.chart_seeded > 60,
    `${answers.mysql.chart_seeded} accounts on mysql, ${answers.postgres.chart_seeded} on postgres`);

  console.log(`\n  ${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass}/${pass + fail} answers agree.\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error('\x1b[31mThe verification itself failed:\x1b[0m', error);
  process.exit(1);
});

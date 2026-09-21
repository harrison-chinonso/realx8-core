/**
 * Moving a company's books in (ACC-9).
 *
 * ── The checks worth writing this file for ──────────────────────────────────
 *
 * That the opening balance journal will NOT post without the tenant's own
 * written confirmation. Those figures decide what the company is worth on the
 * day it arrives, and every later dispute rewinds to that moment — a Realx8
 * admin attesting alone would place the liability on us for numbers we have no
 * way to verify.
 *
 * That two sets of opening balances cannot be posted, because that doubles the
 * company and balances perfectly while doing it.
 *
 * That an unbalanced trial balance goes to SUSPENSE rather than being absorbed
 * into equity — and therefore that no period can close until somebody corrects
 * it, which is the whole mechanism by which it gets corrected.
 *
 * And that the open items are checked AGAINST the control account they are
 * supposed to explain, because a receivables subledger that does not add up to
 * its control account is wrong from the first day and stays wrong.
 *
 * Drives the REAL controllers against a throwaway database.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { QueryTypes } = require('sequelize');
const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_migration`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifymigration';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};
const show = (minor) => `₦${(Number(minor) / 100).toLocaleString('en-US')}`;

const COMPANY = 1;
const PROOF = 'https://res.cloudinary.com/demo/image/upload/v1/attestation.pdf';

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
    id: COMPANY, name: 'Arriving Co', slug: 'arriving', email: 'in@test',
  });
  await userModels.User.bulkCreate([
    { id: 801, name: 'Kelvin Obi', email: 'k@test', password: 'x', type: 'client', company_id: COMPANY },
    { id: 802, name: 'Favour Ada', email: 'f@test', password: 'x', type: 'client', company_id: COMPANY },
  ]);

  await models.LedgerAccount.sync({ force: true });
  await models.JournalEntry.sync({ force: true });
  await models.JournalLine.sync({ force: true });
  await models.ImportMapping.sync({ force: true });
  await models.OpeningAttestation.sync({ force: true });
  await models.AccountingPeriod.sync({ force: true });
  await models.Vendor.sync({ force: true });
  await models.Bill.sync({ force: true });
  await models.Tax.sync({ force: true });
  await models.ReminderSchedule.sync({ force: true });
  await models.Invoice.sync({ force: true });
  await models.InvoicePayment.sync({ force: true });

  await require('../services/finance-service/src/migrations/seedChartOfAccounts')(sequelize);
  /*
   * As the service does at start-up. The document sequence creates its table
   * lazily, and DDL issued while a transaction is open invalidates that
   * transaction on MySQL — "Table definition has changed". The opening
   * balance import posts its journal and its sign-off in one transaction, so
   * without this the first run fails and the second succeeds, which is the
   * worst shape a bug can have.
   */
  await require('../shared/src/documentSequence').ensureTable(sequelize);
  await userModels.Setting.create({
    group: 'accounting', key: 'post_to_ledger', value: 'true', company_id: COMPANY,
  });

  const migration = require('../services/finance-service/src/controllers/migrationController');
  const periods = require('../services/finance-service/src/controllers/periodsController');
  const stmt = require('../services/finance-service/src/controllers/statementsController');

  const STAFF = { id: 60, company_id: COMPANY, type: 'admin' };

  // ── ACC-9.2 ───────────────────────────────────────────────────────────────
  console.log('\n── ACC-9.2  Their chart of accounts ────────────────────────────');
  {
    const SAGE = [
      'Nominal Code,Account Name,Category,Parent',
      '1250,Client account,Current Asset,1200',
      '4900,Other trading income,Turnover,4000',
      '7100,Rent and rates,Overheads,7000',
      '9999,Suspense holding,Nominal Group 9,',
    ].join('\n');

    const preview = await run(migration.importChart, {
      user: STAFF, query: { preview: 'true' }, body: { csv: SAGE },
    });
    check('Previewed without writing anything',
      preview.code === 200 && preview.body.data.to_create === 4, `${preview.body.data.to_create} to create`);
    check('...and the account nobody can classify is named',
      preview.body.data.unclassified.length === 1
      && preview.body.data.unclassified[0].code === '9999',
      preview.body.data.unclassified[0]?.source_type);

    const refused = await run(migration.importChart, { user: STAFF, query: {}, body: { csv: SAGE } });
    check('Importing is REFUSED while a type is unknown',
      refused.code === 422 && /Classify them/.test(refused.body.message || ''),
      refused.body.message);

    const classified = await run(migration.importChart, {
      user: STAFF,
      query: {},
      body: { csv: SAGE, source: 'Sage 50', type_map: { 'nominal group 9': 'asset' } },
    });
    check('Classified, it imports',
      classified.code === 201 && classified.body.data.to_create === 4, classified.body.message);

    const [row] = await sequelize.query(
      "SELECT name, type, is_system, role FROM ledger_accounts WHERE code = '1250'",
      { type: QueryTypes.SELECT },
    );
    check('An imported account claims no role',
      row?.role === null,
      'a role would silently redirect postings that belong to the seeded chart');
    check('...and is not marked as one of ours', Number(row?.is_system) === 0, '');

    const [mapping] = await sequelize.query(
      "SELECT source FROM import_mappings WHERE kind = 'chart_of_accounts'",
      { type: QueryTypes.SELECT },
    );
    check('How to read this package is remembered', mapping?.source === 'Sage 50', mapping?.source);

    const again = await run(migration.importChart, {
      user: STAFF, query: {}, body: { csv: SAGE, type_map: { 'nominal group 9': 'asset' } },
    });
    check('Importing the same chart twice creates nothing',
      again.code === 409, again.body.message);
  }

  // ── ACC-9.3 ───────────────────────────────────────────────────────────────
  console.log('\n── ACC-9.3  What they closed with ──────────────────────────────');
  const BALANCES = [
    'Account,Name,Debit,Credit',
    '1020,Bank,"15,000,000.00",',
    '1110,Trade debtors,"42,000,000.00",',
    '2010,Trade creditors,,"7,000,000.00"',
    '3010,Share capital,,"50,000,000.00"',
  ].join('\n');

  {
    const preview = await run(migration.importOpeningBalances, {
      user: STAFF, query: { preview: 'true' }, body: { csv: BALANCES, as_at: '2026-12-31' },
    });
    check('It balances, and says so before anything is written',
      preview.body.data.balanced === true,
      `Dr ${show(preview.body.data.debit_minor)} = Cr ${show(preview.body.data.credit_minor)}`);

    const noName = await run(migration.importOpeningBalances, {
      user: STAFF, query: {}, body: { csv: BALANCES, as_at: '2026-12-31' },
    });
    check('Refused with nobody at the company confirming them',
      noName.code === 422 && /confirms these are the balances/.test(noName.body.message || ''),
      noName.body.message);

    const noProof = await run(migration.importOpeningBalances, {
      user: STAFF,
      query: {},
      body: { csv: BALANCES, as_at: '2026-12-31', attested_by: 'Mrs Adeleke, FCA' },
    });
    check('...and refused on a name alone, without their written confirmation',
      noProof.code === 422 && /Attach their written confirmation/.test(noProof.body.message || ''),
      'a Realx8 admin attesting alone would put the liability on us');

    const typed = await run(migration.importOpeningBalances, {
      user: STAFF,
      query: {},
      body: {
        csv: BALANCES,
        as_at: '2026-12-31',
        attested_by: 'Mrs Adeleke, FCA',
        attestation_url: 'https://example.test/i-typed-this.pdf',
      },
    });
    check('A hand-typed link is not a document',
      typed.code === 422, typed.body.message);

    const posted = await run(migration.importOpeningBalances, {
      user: STAFF,
      query: {},
      body: {
        csv: BALANCES,
        as_at: '2026-12-31',
        attested_by: 'Mrs Adeleke, FCA',
        attestation_url: PROOF,
      },
    });
    check('Signed off, it posts as ONE journal',
      posted.code === 201 && Boolean(posted.body.data.reference), posted.body.message);

    const [{ n }] = await sequelize.query(
      "SELECT COUNT(*) AS n FROM journal_entries WHERE source = 'opening_balance'",
      { type: QueryTypes.SELECT },
    );
    check('...one, not one per account', Number(n) === 1, `${n} entry`);

    const [attestation] = await sequelize.query(
      'SELECT attested_by, attestation_url, entry_id FROM opening_attestations',
      { type: QueryTypes.SELECT },
    );
    check('...and who confirmed it is kept beside the journal',
      /Adeleke/.test(attestation?.attested_by || '') && Boolean(attestation?.entry_id),
      'every later dispute comes back to this');

    const twice = await run(migration.importOpeningBalances, {
      user: STAFF,
      query: {},
      body: {
        csv: BALANCES, as_at: '2026-12-31', attested_by: 'Mrs Adeleke, FCA', attestation_url: PROOF,
      },
    });
    check('A second set of opening balances is refused',
      twice.code === 409 && /double the company/.test(twice.body.message || ''),
      twice.body.message);
  }

  console.log('\n── The balance sheet they arrive with ──────────────────────────');
  {
    const out = await run(stmt.balanceSheet, { user: STAFF, query: { as_at: '2026-12-31' } });
    const bs = out.body.data;
    check('It balances', bs.balanced === true,
      `assets ${show(bs.assets_minor)} = liabilities ${show(bs.liabilities_minor)} + equity ${show(bs.equity_minor)}`);
    check('Nothing masquerades as this year\'s trading',
      bs.earnings_not_yet_closed_minor === 0,
      'opening balances land in equity, not in the profit and loss');
  }

  // ── ACC-9.4 ───────────────────────────────────────────────────────────────
  console.log('\n── ACC-9.4  The invoices behind the ₦42m ───────────────────────');
  {
    const SHORT = [
      'Customer,Invoice No,Invoice Date,Due Date,Amount,Paid',
      'Kelvin Obi,INV-9001,03/11/2026,03/12/2026,"30,000,000.00",',
    ].join('\n');

    const preview = await run(migration.importOpenItems, {
      user: STAFF, query: { preview: 'true' }, body: { csv: SHORT, side: 'receivable' },
    });
    check('The detail is checked against the control account it explains',
      preview.body.data.reconciles === false
      && preview.body.data.difference_minor === -1200000000,
      `items ${show(preview.body.data.total_minor)} against control ${show(preview.body.data.control_balance_minor)}`);

    const FULL = [
      'Customer,Invoice No,Invoice Date,Due Date,Amount,Paid',
      'Kelvin Obi,INV-9001,03/11/2026,03/12/2026,"30,000,000.00",',
      'Favour Ada,INV-9002,20/12/2026,19/01/2027,"12,000,000.00",',
    ].join('\n');

    const stranger = await run(migration.importOpenItems, {
      user: STAFF,
      query: {},
      body: {
        csv: `${FULL}\nSomebody Else,INV-9003,01/12/2026,31/12/2026,"1.00",`,
        side: 'receivable',
      },
    });
    check('A customer the system has never heard of is refused, not invented',
      stranger.code === 422 && /not on the system yet/.test(stranger.body.message || ''),
      stranger.body.message);

    const out = await run(migration.importOpenItems, {
      user: STAFF, query: {}, body: { csv: FULL, side: 'receivable' },
    });
    check('The full file agrees with the control account, and imports',
      out.code === 201 && out.body.data.reconciles === true, out.body.message);

    const aged = await run(stmt.agedReceivables, { user: STAFF, query: { as_at: '2027-01-31' } });
    check('Aged receivables now works from day one',
      aged.body.data.reconciles === true && aged.body.data.total_minor === 4200000000,
      `${show(aged.body.data.total_minor)} across ${aged.body.data.clients.length} buyer(s)`);
    check('...and each invoice ages from its OWN date, not from today',
      aged.body.data.clients.some((client) => client.days_1_30 > 0)
      && aged.body.data.clients.some((client) => client.days_31_60 > 0),
      aged.body.data.clients.map((c) => `${c.client_name}: ${show(c.total_minor)}`).join(' · '));
  }

  console.log('\n── The suppliers behind the ₦7m ────────────────────────────────');
  {
    const PAYABLES = [
      'Supplier,Document,Date,Due Date,Outstanding',
      'Adeyemi Contractors,SUP-441,01/12/2026,31/12/2026,"7,000,000.00"',
    ].join('\n');

    const out = await run(migration.importOpenItems, {
      user: STAFF, query: {}, body: { csv: PAYABLES, side: 'payable', as_at: '2026-12-31' },
    });
    check('Open bills come in, and the supplier is created with them',
      out.code === 201 && out.body.data.reconciles === true, out.body.message);

    const [{ n }] = await sequelize.query(
      "SELECT COUNT(*) AS n FROM journal_entries WHERE source = 'bill'",
      { type: QueryTypes.SELECT },
    );
    check('...and NOTHING is posted for them',
      Number(n) === 0,
      'the money came in with the opening balances; posting again would double the payables');
  }

  // ── The unbalanced case ───────────────────────────────────────────────────
  console.log('\n── A trial balance that does not balance ───────────────────────');
  {
    /*
     * A second company, because the first has already had its opening
     * balances and correctly refuses a second set.
     */
    await userModels.Company.create({ id: 2, name: 'Wonky Co', slug: 'wonky', email: 'w@test' });
    await require('../services/finance-service/src/migrations/seedChartOfAccounts')(sequelize);
    await userModels.Setting.create({
      group: 'accounting', key: 'post_to_ledger', value: 'true', company_id: 2,
    });

    const WONKY = [
      'Account,Debit,Credit',
      '1020,"1,500,000.00",',
      '3010,,"1,400,000.00"',
    ].join('\n');
    const OTHER = { id: 61, company_id: 2, type: 'admin' };

    const out = await run(migration.importOpeningBalances, {
      user: OTHER,
      query: {},
      body: {
        csv: WONKY, as_at: '2026-12-31', attested_by: 'Their bookkeeper', attestation_url: PROOF,
      },
    });
    check('It posts, with the difference in SUSPENSE',
      out.code === 201 && out.body.data.to_suspense_minor === 10000000,
      out.body.message);

    await run(periods.createPeriods, { user: OTHER, body: { year: 2026 } });
    const list = await run(periods.listPeriods, { user: OTHER, query: {} });
    const december = list.body.data.find((p) => String(p.starts_on).slice(0, 10) === '2026-12-01');
    const closed = await run(periods.closePeriod, {
      user: OTHER, params: { id: String(december.id) }, body: {},
    });
    check('...and no month can close until somebody corrects it',
      closed.code === 422
      && closed.body.data.checks.find((c) => c.key === 'suspense_empty')?.status === 'failed',
      'which is the whole mechanism by which it gets corrected rather than forgotten');
  }

  console.log('\n── Where this company has got to ───────────────────────────────');
  {
    const out = await run(migration.migrationStatus, { user: STAFF, query: {} });
    check('The status says what is done and what is not',
      out.body.data.accounts > 60
      && Boolean(out.body.data.opening_balances)
      && out.body.data.migrated_invoices === 2
      && out.body.data.suspense_minor === 0,
      `${out.body.data.accounts} accounts, ${out.body.data.migrated_invoices} invoices, `
      + `${show(out.body.data.suspense_minor)} in suspense`);
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

/**
 * Agreeing with the bank (ACC-6).
 *
 * ── The checks worth writing this file for ──────────────────────────────────
 *
 * That a statement re-imported does not double every movement in it. People
 * re-download a month to pick up the last few days constantly, and an import
 * that duplicates on the second read is one that destroys the account it was
 * meant to prove.
 *
 * That a date is not guessed. 03/04/2026 is the third of April to a Nigerian
 * bank and the fourth of March to an American one; reading it the wrong way
 * round puts transactions in the wrong month, which survives every check until
 * a period close finds it a quarter later.
 *
 * That nothing is matched automatically. A wrong automatic match is invisible
 * — the reconciliation balances, both sides are used up, and the two
 * transactions that were actually swapped are never looked at again.
 *
 * And that a reconciliation cannot be locked with unmatched lines in it, since
 * period close leans on that lock to let a month close.
 *
 * Drives the REAL controllers against a throwaway database.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { QueryTypes } = require('sequelize');
const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_bankrec`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifybank';

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
  // ── The matching arithmetic, with no database ─────────────────────────────
  console.log('\n── ACC-6.2  What counts as a match ─────────────────────────────');
  {
    const { scoreCandidate, referenceMatches } = require('../shared/src/accounting/bankMatch');

    const line = {
      statement_date: '2026-05-04', amount_minor: 5000000,
      reference: 'TRF FRM KELVIN O/REF INV-0001', description: 'Transfer',
    };

    const exact = scoreCandidate(line, {
      entry_date: '2026-05-04', amount_minor: 5000000, reference: 'INV-0001',
    });
    check('Same amount, same day, reference on both — certain',
      exact?.certainty === 'certain', exact?.reasons.join(', '));

    const wrongWay = scoreCandidate(line, {
      entry_date: '2026-05-04', amount_minor: -5000000, reference: 'INV-0001',
    });
    check('The SAME amount in the opposite direction is not a match at all',
      wrongWay === null,
      'a receipt and a payment of the same size are opposite events, not a near miss');

    const different = scoreCandidate(line, {
      entry_date: '2026-05-04', amount_minor: 5000001, reference: 'INV-0001',
    });
    check('A different amount is not scored at all',
      different === null, 'an amount mismatch is a different transaction, not a weak match');

    const noReference = scoreCandidate(line, {
      entry_date: '2026-05-09', amount_minor: 5000000, reference: 'SOMETHING ELSE',
    });
    check('Same amount five days apart with no reference is only possible',
      noReference?.certainty === 'possible', noReference?.reasons.join(', '));

    check('A short fragment does not match everything',
      referenceMatches('REF', 'REFERENCE 12') === false,
      '"REF" appears in half a bank\'s narrations');
  }

  // ── The date reader ───────────────────────────────────────────────────────
  console.log('\n── The one field worth refusing to guess ───────────────────────');
  {
    const { parseDate, parseSignedAmount } = require('../shared/src/accounting/csvImport');
    check('03/04/2026 reads as the third of April by default',
      parseDate('03/04/2026') === '2026-04-03', parseDate('03/04/2026'));
    check('...and as the fourth of March when the source is known to be American',
      parseDate('03/04/2026', { dayFirst: false }) === '2026-03-04',
      parseDate('03/04/2026', { dayFirst: false }));
    check('A day above twelve settles it whichever convention was meant',
      parseDate('25/04/2026', { dayFirst: false }) === '2026-04-25',
      parseDate('25/04/2026', { dayFirst: false }));
    check('Nonsense is refused rather than turned into a date',
      parseDate('not a date') === null, '');

    check('A bracketed amount on a statement is money OUT, not an ambiguity',
      parseSignedAmount('(1,200.00)') === -120000,
      'one amount column means there is no second column it could have belonged to');
    check('...and so is a trailing minus',
      parseSignedAmount('1,200.00-') === -120000, '');
  }

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
    id: COMPANY, name: 'Bank Test Co', slug: 'bank-test', email: 'bank@test',
  });

  await models.LedgerAccount.sync({ force: true });
  await models.JournalEntry.sync({ force: true });
  await models.JournalLine.sync({ force: true });
  await models.BankStatementLine.sync({ force: true });
  await models.BankReconciliation.sync({ force: true });
  await models.ImportMapping.sync({ force: true });
  await models.AccountingPeriod.sync({ force: true });

  await require('../services/finance-service/src/migrations/seedChartOfAccounts')(sequelize);
  await userModels.Setting.create({
    group: 'accounting', key: 'post_to_ledger', value: 'true', company_id: COMPANY,
  });

  const bank = require('../services/finance-service/src/controllers/bankRecController');
  const { post } = require('../shared/src/accounting/ledger');

  const STAFF = { id: 40, company_id: COMPANY, type: 'admin' };

  const accounts = await run(bank.bankAccounts, { user: STAFF, query: {} });
  const bankAccount = accounts.body.data.find((a) => a.role === 'BANK');
  check('The chart\'s bank accounts are offered',
    Boolean(bankAccount), `${accounts.body.data.length} found, using ${bankAccount?.code}`);

  // Two receipts and a payment, in the books.
  const entries = {};
  for (const [key, date, amount, reference] of [
    ['receipt1', '2026-05-04', 5000000, 'INV-0001'],
    ['receipt2', '2026-05-06', 5000000, 'INV-0002'],
    ['payment', '2026-05-10', -1750000, 'BILL-0003'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const entry = await post(sequelize, {
      companyId: COMPANY,
      entryDate: date,
      source: 'invoice_payment',
      sourceId: key,
      memo: reference,
      lines: amount > 0
        ? [
          { account_id: bankAccount.id, debit_minor: amount, credit_minor: 0 },
          { role: 'ACCOUNTS_RECEIVABLE', debit_minor: 0, credit_minor: amount },
        ]
        : [
          { role: 'ACCOUNTS_PAYABLE', debit_minor: -amount, credit_minor: 0 },
          { account_id: bankAccount.id, debit_minor: 0, credit_minor: -amount },
        ],
    });
    entries[key] = entry;
  }

  // ── ACC-6.1 ───────────────────────────────────────────────────────────────
  console.log('\n── ACC-6.1  A statement, read ──────────────────────────────────');
  const STATEMENT = [
    'Value Date,Narration,Reference,Withdrawals,Lodgement,Balance',
    '04/05/2026,TRF FRM KELVIN O/REF INV-0001,INV-0001,,"50,000.00","50,000.00"',
    '06/05/2026,TRF FRM FAVOUR,INV-0002,,"50,000.00","100,000.00"',
    '10/05/2026,PAYMENT TO BUILDERS,BILL-0003,"17,500.00",,"82,500.00"',
    '31/05/2026,COMMISSION ON TURNOVER,CHG-0531,"1,075.00",,"81,425.00"',
  ].join('\n');

  {
    const preview = await run(bank.importStatement, {
      user: STAFF,
      query: { preview: 'true' },
      body: { account_id: bankAccount.id, csv: STATEMENT, source: 'GTBank' },
    });
    check('Previewed without writing anything',
      preview.code === 200 && preview.body.data.to_import === 4
      && await sequelize.query('SELECT COUNT(*) AS n FROM bank_statement_lines', { type: QueryTypes.SELECT })
        .then(([r]) => Number(r.n)) === 0,
      `${preview.body.data.to_import} lines, ${show(preview.body.data.money_in_minor)} in`);

    check('The bank\'s own column names are understood',
      preview.body.data.read === 4,
      'Value Date / Narration / Withdrawals / Lodgement');

    const out = await run(bank.importStatement, {
      user: STAFF,
      query: {},
      body: { account_id: bankAccount.id, csv: STATEMENT, source: 'GTBank' },
    });
    check('Imported', out.code === 201, out.body.message);

    const [mapping] = await sequelize.query(
      "SELECT source, columns FROM import_mappings WHERE kind = 'bank_statement'",
      { type: QueryTypes.SELECT },
    );
    check('...and how to read this bank is remembered for next month',
      mapping?.source === 'GTBank',
      typeof mapping?.columns === 'string' ? mapping.columns : JSON.stringify(mapping?.columns));
  }

  console.log('\n── The same statement again ────────────────────────────────────');
  {
    const again = await run(bank.importStatement, {
      user: STAFF,
      query: {},
      body: { account_id: bankAccount.id, csv: STATEMENT, source: 'GTBank' },
    });
    check('Every line is recognised and nothing is doubled',
      again.code === 409 && /already been imported/.test(again.body.message || ''),
      again.body.message);

    const [{ n }] = await sequelize.query(
      'SELECT COUNT(*) AS n FROM bank_statement_lines', { type: QueryTypes.SELECT },
    );
    check('...so the account still holds four lines', Number(n) === 4, `${n}`);

    const extended = `${STATEMENT}\n01/06/2026,TRF FRM NEW BUYER,INV-0004,,"25,000.00","106,425.00"`;
    const partial = await run(bank.importStatement, {
      user: STAFF,
      query: {},
      body: { account_id: bankAccount.id, csv: extended, source: 'GTBank' },
    });
    check('A re-download with three new days adds only what is new',
      partial.code === 201 && partial.body.data.to_import === 1
      && partial.body.data.already_imported === 4,
      partial.body.message);
  }

  // ── ACC-6.2 ───────────────────────────────────────────────────────────────
  console.log('\n── ACC-6.2  Suggestions, not decisions ─────────────────────────');
  {
    const out = await run(bank.suggestions, {
      user: STAFF, query: { account_id: String(bankAccount.id) },
    });
    const byLine = out.body.data;
    check('Every unmatched line gets candidates',
      byLine.length === 5, `${byLine.length} lines`);

    const first = byLine.find((row) => row.line.reference === 'INV-0001');
    check('The receipt is matched to its own journal, on the reference',
      first?.suggestions[0]?.candidate.entry_id === entries.receipt1.entry_id
      && first.suggestions[0].certainty === 'certain',
      first?.suggestions[0]?.reasons.join(', '));

    const second = byLine.find((row) => row.line.reference === 'INV-0002');
    check('...and the second ₦50,000 receipt is NOT offered the same journal',
      second?.suggestions[0]?.candidate.entry_id === entries.receipt2.entry_id,
      'one entry cannot be two bank lines');

    const charge = byLine.find((row) => row.line.reference === 'CHG-0531');
    check('The bank charge has nothing behind it, and is offered nothing',
      charge?.suggestions.length === 0,
      'there is no document for it — the bank is the document');

    const [{ n }] = await sequelize.query(
      "SELECT COUNT(*) AS n FROM bank_statement_lines WHERE status <> 'unmatched'",
      { type: QueryTypes.SELECT },
    );
    check('Nothing was matched automatically', Number(n) === 0,
      'a wrong automatic match is invisible; a wrong suggestion costs a glance');
  }

  // ── Accepting them ────────────────────────────────────────────────────────
  console.log('\n── Accepting, and refusing to accept twice ─────────────────────');
  const lines = await sequelize.query(
    'SELECT id, reference, amount_minor FROM bank_statement_lines ORDER BY statement_date',
    { type: QueryTypes.SELECT },
  );
  {
    for (const [reference, key] of [['INV-0001', 'receipt1'], ['INV-0002', 'receipt2'], ['BILL-0003', 'payment']]) {
      const line = lines.find((row) => row.reference === reference);
      // eslint-disable-next-line no-await-in-loop
      await run(bank.matchLine, {
        user: STAFF, params: { id: String(line.id) }, body: { entry_id: entries[key].entry_id },
      });
    }
    const [{ n }] = await sequelize.query(
      "SELECT COUNT(*) AS n FROM bank_statement_lines WHERE status = 'matched'",
      { type: QueryTypes.SELECT },
    );
    check('Three matched by hand', Number(n) === 3, `${n}`);

    const spare = lines.find((row) => row.reference === 'INV-0004');
    const twice = await run(bank.matchLine, {
      user: STAFF, params: { id: String(spare.id) }, body: { entry_id: entries.receipt1.entry_id },
    });
    check('One journal cannot be matched to a second bank line',
      twice.code === 409 && /already matched/.test(twice.body.message || ''),
      twice.body.message);
  }

  // ── ACC-6.3 ───────────────────────────────────────────────────────────────
  console.log('\n── ACC-6.3  A line with nothing behind it ──────────────────────');
  {
    const charge = lines.find((row) => row.reference === 'CHG-0531');
    const [charges] = await sequelize.query(
      "SELECT id FROM ledger_accounts WHERE company_id = :c AND code = '5300' LIMIT 1",
      { replacements: { c: COMPANY }, type: QueryTypes.SELECT },
    );
    const out = await run(bank.postLine, {
      user: STAFF,
      params: { id: String(charge.id) },
      body: { account_id: charges.id, memo: 'Commission on turnover' },
    });
    check('Posted straight to an account', out.code === 201, out.body.message);

    const [entry] = await sequelize.query(
      "SELECT e.id, e.entry_date FROM journal_entries e WHERE e.source = 'bank_line' ORDER BY e.id DESC LIMIT 1",
      { type: QueryTypes.SELECT },
    );
    check('...dated when the bank says it happened, not today',
      String(entry.entry_date).slice(0, 10) === '2026-05-31', String(entry.entry_date).slice(0, 10));

    const unmatch = await run(bank.unmatchLine, { user: STAFF, params: { id: String(charge.id) }, body: {} });
    check('A posted line cannot simply be unmatched',
      unmatch.code === 409 && /Reverse the journal/.test(unmatch.body.message || ''),
      unmatch.body.message);
  }

  // ── ACC-6.4 ───────────────────────────────────────────────────────────────
  console.log('\n── ACC-6.4  Locking it ─────────────────────────────────────────');
  {
    const early = await run(bank.lockReconciliation, {
      user: STAFF,
      body: { account_id: bankAccount.id, statement_date: '2026-06-30' },
    });
    check('Refused while a line is still unmatched',
      early.code === 422 && /still unmatched/.test(early.body.message || ''),
      early.body.message);

    const summaryOut = await run(bank.summary, {
      user: STAFF, query: { account_id: String(bankAccount.id), as_at: '2026-05-31' },
    });
    check('The summary says what is on each side',
      summaryOut.body.data?.unmatched_lines === 0
      && summaryOut.body.data?.ledger_balance_minor === 8142500,
      summaryOut.body?.error?.message
        || `ledger ${show(summaryOut.body.data?.ledger_balance_minor)}, `
          + `${summaryOut.body.data?.unmatched_lines} unmatched to 31 May`);

    const locked = await run(bank.lockReconciliation, {
      user: STAFF,
      body: {
        account_id: bankAccount.id,
        statement_date: '2026-05-31',
        statement_balance_minor: 8142500,
      },
    });
    check('Locked once everything up to that date is accounted for',
      locked.code === 200 && locked.body.data.status === 'locked', locked.body.message);

    const wrong = await run(bank.lockReconciliation, {
      user: STAFF,
      body: {
        account_id: bankAccount.id,
        statement_date: '2026-05-31',
        statement_balance_minor: 9999999,
      },
    });
    check('A balance that does not agree is refused, with the difference',
      wrong.code === 422 && /difference/.test(wrong.body.message || ''),
      wrong.body.message);
  }

  // ── The reason ACC-7 cares ────────────────────────────────────────────────
  console.log('\n── What period close now sees ──────────────────────────────────');
  {
    const { banksReconciled } = require('../shared/src/accounting/periodClose');
    const may = await banksReconciled(sequelize, { companyId: COMPANY, to: '2026-05-31' });
    check('May can close: the account was reconciled to the end of it',
      may.status === 'ok', may.detail);

    const june = await banksReconciled(sequelize, { companyId: COMPANY, to: '2026-06-30' });
    check('June cannot: the last reconciliation predates it',
      june.status === 'failed', june.detail);
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

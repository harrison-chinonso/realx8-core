/**
 * The posting rules, and the switch that decides whether they fire (ACC-3).
 *
 * ── Two halves, and the first is the pure one ───────────────────────────────
 *
 * Every rule in shared/src/accounting/rules.js is a function from an event to
 * journal lines, with no database anywhere near it. So the arithmetic is
 * asserted here directly — line by line, against literal amounts, the way the
 * commission engine's worked examples are. An accountant can read these checks
 * and say whether they are right, which is the only review that matters for a
 * posting rule and is impossible if the only way to see one is to run a
 * payment through a fixture.
 *
 * The second half proves the wiring: that a company which has not opted in
 * posts nothing at all, that one which has posts exactly once per event, and
 * that a rule which stops balancing is refused before the ledger sees it.
 *
 * ── Why "a wrong rule" is the thing being tested ────────────────────────────
 *
 * A wrong posting rule produces books that BALANCE and are false, and as book
 * of record there is no incumbent running alongside to catch it. Every check
 * below that matters is therefore an assertion about a SPECIFIC account and a
 * SPECIFIC amount, not about the entry balancing — balancing is necessary and
 * nowhere near sufficient.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { QueryTypes } = require('sequelize');
const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_posting`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifyposting';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};
const show = (minor) => `₦${(Number(minor) / 100).toLocaleString('en-US')}`;

/** A rule's lines as `ROLE Dr amount` / `ROLE Cr amount`, for a readable failure. */
const describe = (lines) => lines
  .map((l) => `${l.role} ${l.debit_minor ? 'Dr' : 'Cr'} ${show(l.debit_minor || l.credit_minor)}`)
  .join(' | ');

/** One side of a rule's output, by role. */
const leg = (lines, role) => lines.find((l) => l.role === role);

const COMPANY = 1;

(async () => {
  // ── Part one: the rules, with no database at all ─────────────────────────
  const rules = require('../shared/src/accounting/rules');
  const { ROLE } = require('../shared/src/accounting/chart');

  console.log('\n── ACC-3.7  Every rule balances, by construction ───────────────');
  {
    const cases = [
      ['property sale', rules.invoiceRaised({ grossMinor: 1000000000, discountMinor: 50000000, vatMinor: 71250000 })],
      ['service fee', rules.feeInvoiceRaised({ grossMinor: 2500000, vatMinor: 187500 })],
      ['payment', rules.paymentApproved({ amountMinor: 200000000 })],
      ['overpayment', rules.overpaymentHeld({ surplusMinor: 15000000 })],
      ['credit note', rules.creditNoteApproved({ netMinor: 200000000, vatMinor: 15000000 })],
      ['refund', rules.refundPaid({ amountMinor: 15000000 })],
      ['commission accrual', rules.commissionEntry({ entryType: 'ACCRUAL', amountMinor: 200000000 })],
      ['commission payout', rules.commissionEntry({ entryType: 'PAYOUT', amountMinor: 171000000 })],
      ['commission deduction', rules.commissionEntry({ entryType: 'DEDUCTION', amountMinor: 9000000 })],
    ];
    const unbalanced = cases.filter(([, lines]) => rules.imbalanceOf(lines) !== 0);
    check(`All ${cases.length} rules balance`, unbalanced.length === 0,
      unbalanced.map(([name, lines]) => `${name} out by ${rules.imbalanceOf(lines)}`).join(', ') || 'none out');
  }

  console.log('\n── ACC-3.1  A property sale, ₦10m less ₦500k, VAT ₦712,500 ─────');
  {
    const lines = rules.invoiceRaised({
      grossMinor: 1000000000, discountMinor: 50000000, vatMinor: 71250000,
    });
    check('The buyer is charged gross less discount, plus tax',
      leg(lines, ROLE.ACCOUNTS_RECEIVABLE)?.debit_minor === 1021250000,
      show(leg(lines, ROLE.ACCOUNTS_RECEIVABLE)?.debit_minor));
    check('Revenue is credited at the FULL price',
      leg(lines, ROLE.CONTRACT_LIABILITY)?.credit_minor === 1000000000,
      show(leg(lines, ROLE.CONTRACT_LIABILITY)?.credit_minor));
    check('...and the discount is debited back out, so it is visible',
      leg(lines, ROLE.REVENUE_DISCOUNTS)?.debit_minor === 50000000,
      `${describe(lines)}`);
    check('Output tax is raised as a liability',
      leg(lines, ROLE.VAT_OUTPUT)?.credit_minor === 71250000,
      show(leg(lines, ROLE.VAT_OUTPUT)?.credit_minor));

    /*
     * The decision that most needs an accountant's eye. An off-plan unit is
     * not revenue when the paperwork is raised, and the credit waits in a
     * liability until control passes.
     */
    check('By default the credit waits in contract liability, not revenue',
      leg(lines, ROLE.CONTRACT_LIABILITY) != null && leg(lines, ROLE.REVENUE_UNIT_SALES) == null,
      'default is recognition on handover');

    const atInvoice = rules.invoiceRaised({
      grossMinor: 1000000000, recognition: rules.RECOGNITION.ON_INVOICE,
    });
    check('...and a property that recognises on invoice credits revenue instead',
      leg(atInvoice, ROLE.REVENUE_UNIT_SALES)?.credit_minor === 1000000000,
      describe(atInvoice));
  }

  console.log('\n── ACC-3.4  The rule two PRD revisions got wrong ───────────────');
  {
    const lines = rules.creditNoteApproved({ netMinor: 200000000, vatMinor: 15000000 });
    check('Dr revenue at the net',
      leg(lines, ROLE.REVENUE_UNIT_SALES)?.debit_minor === 200000000, describe(lines));
    check('Dr VAT output, reversing the tax',
      leg(lines, ROLE.VAT_OUTPUT)?.debit_minor === 15000000, '');
    check('Cr receivable at the GROSS the buyer no longer owes',
      leg(lines, ROLE.ACCOUNTS_RECEIVABLE)?.credit_minor === 215000000, '');
    check('...and it balances, which revision 2 of the PRD did not',
      rules.imbalanceOf(lines) === 0, `out by ${rules.imbalanceOf(lines)}`);
  }

  console.log('\n── A refund is not negative revenue ────────────────────────────');
  {
    const lines = rules.refundPaid({ amountMinor: 15000000 });
    check('Dr customer credit balances / Cr bank',
      leg(lines, ROLE.CUSTOMER_CREDIT_BALANCES)?.debit_minor === 15000000
        && leg(lines, ROLE.BANK)?.credit_minor === 15000000, describe(lines));
    check('...and no revenue account is touched in either direction',
      !lines.some((l) => l.role.startsWith('REVENUE')), describe(lines));
  }

  // ── Part two: the wiring, against a real database ────────────────────────
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  const models = require('../services/finance-service/src/models');
  const { sequelize } = models;
  const userModels = require('../services/user-service/src/models');
  // Parents before children: `users` carries foreign keys to both, and MySQL
  // refuses to create a table whose referenced table is not there yet.
  await userModels.Company.sync({ force: true });
  await userModels.RealtorLevel.sync({ force: true });
  await userModels.User.sync({ force: true });
  await userModels.Setting.sync({ force: true });
  await userModels.Company.create({
    id: COMPANY, name: 'Posting Test Co', slug: 'posting-test', email: 'posting@test',
  });
  const buyer = await userModels.User.create({
    name: 'Ada Buyer', email: 'ada@posting.test', password: 'x', type: 'client', company_id: COMPANY,
  });

  await models.LedgerAccount.sync({ force: true });
  await models.JournalEntry.sync({ force: true });
  await models.JournalLine.sync({ force: true });
  await require('../services/finance-service/src/migrations/seedChartOfAccounts')(sequelize);

  const { postEvent, postingEnabled } = require('../shared/src/accounting/posting');
  const ledger = require('../shared/src/accounting/ledger');

  const payment = (id) => ({
    rule: 'invoice_payment',
    companyId: COMPANY,
    entryDate: '2026-09-20',
    source: 'invoice_payment',
    sourceId: String(id),
    memo: `Payment ${id}`,
    createdBy: 5,
    input: {
      amountMinor: 20000000,
      dimensions: { party_id: buyer.id, party_type: 'client' },
    },
  });

  console.log('\n── Off until a company asks for it ─────────────────────────────');
  {
    check('A company with no setting is not posting', (await postingEnabled(sequelize, COMPANY)) === false);
    const out = await postEvent(sequelize, payment(1));
    check('...and an event on it posts nothing', out.skipped === 'posting_disabled', JSON.stringify(out));
    const [{ n }] = await sequelize.query('SELECT COUNT(*) AS n FROM journal_entries', { type: QueryTypes.SELECT });
    check('...leaving the journal empty', Number(n) === 0, `${n} entries`);
  }

  console.log('\n── Switched on ─────────────────────────────────────────────────');
  {
    await userModels.Setting.create({
      group: 'accounting', key: 'post_to_ledger', value: 'true', company_id: COMPANY,
    });
    check('The company is now posting', (await postingEnabled(sequelize, COMPANY)) === true);

    const out = await postEvent(sequelize, payment(2));
    check('An event posts a journal', out.posted === true, out.reference);

    const [lines] = [await sequelize.query(
      'SELECT account_code, account_role, debit_minor, credit_minor, party_id, party_type '
      + 'FROM journal_lines WHERE entry_id = :id ORDER BY position',
      { replacements: { id: out.entry_id }, type: QueryTypes.SELECT },
    )];
    check('Dr Bank / Cr Accounts receivable, to the named accounts',
      lines.length === 2
        && lines[0].account_role === 'BANK' && Number(lines[0].debit_minor) === 20000000
        && lines[1].account_role === 'ACCOUNTS_RECEIVABLE' && Number(lines[1].credit_minor) === 20000000,
      lines.map((l) => `${l.debit_minor > 0 ? 'Dr' : 'Cr'} ${l.account_code} ${show(l.debit_minor || l.credit_minor)}`).join(' | '));
    check('...carrying the counterparty on the receivable line',
      Number(lines[1].party_id) === buyer.id && lines[1].party_type === 'client',
      `${lines[1].party_type} ${lines[1].party_id}`);

    const again = await postEvent(sequelize, payment(2));
    check('ACC-2.3  The same event replayed posts once',
      again.replayed === true && again.entry_id === out.entry_id, `entry ${again.entry_id}`);
  }

  console.log('\n── A rule that stops balancing is refused ──────────────────────');
  {
    const original = rules.RULES.refund;
    rules.RULES.refund = () => [rules.dr('BANK', 500), rules.cr('CASH', 400)];
    const out = await postEvent(sequelize, {
      rule: 'refund', companyId: COMPANY, entryDate: '2026-09-20', source: 'probe_bad', input: {},
    });
    rules.RULES.refund = original;

    check('Refused beside the rule, which names the rule', out.skipped === 'rule_unbalanced',
      JSON.stringify(out));
    const [{ n }] = await sequelize.query(
      "SELECT COUNT(*) AS n FROM journal_entries WHERE source = 'probe_bad'",
      { type: QueryTypes.SELECT },
    );
    check('...and nothing reached the table', Number(n) === 0, `${n}`);
  }

  console.log('\n── The books balance ───────────────────────────────────────────');
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

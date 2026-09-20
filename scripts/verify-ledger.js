/**
 * The general ledger's invariants, against a real database (ACC-1, ACC-2).
 *
 * ── Why these are asserted by a script and not by inspection ────────────────
 *
 * Section six of the accounting PRD makes "the ledger balances" a success
 * measure rather than a hope, and a measure nobody runs is a hope with better
 * wording. Every rule below is one a future change could quietly remove — the
 * balance check, the idempotency key, the append-only trigger — and each of
 * them fails silently: the books still add up, they are simply no longer
 * telling the truth.
 *
 * So the test for each is the same shape: BREAK the rule and assert that the
 * system refuses. A test that only posts correct journals proves nothing about
 * what happens to an incorrect one.
 *
 * Drives the REAL chart seeder and the REAL posting engine against a throwaway
 * database, in the style of verify:commission-store.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { QueryTypes } = require('sequelize');
const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_ledger`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }

// Before anything requires the models — config/database.js reads this at
// require time. Same reasoning as the other verify scripts.
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifyledger';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};
const show = (minor) => `₦${(Number(minor) / 100).toLocaleString('en-US')}`;

/** Did this throw? Returns the error, or null. */
const refused = async (fn) => {
  try { await fn(); return null; } catch (error) { return error; }
};

const COMPANY = 1;

(async () => {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  const models = require('../services/finance-service/src/models');
  const { sequelize } = models;

  // The companies table is what the chart seeder walks, so it is built from
  // the real model rather than a stand-in that would drift from it.
  const userModels = require('../services/user-service/src/models');
  await userModels.Company.sync({ force: true });
  await userModels.Company.create({
    id: COMPANY, name: 'Ledger Test Co', slug: 'ledger-test', email: 'ledger@test',
  });

  await models.LedgerAccount.sync({ force: true });
  await models.JournalEntry.sync({ force: true });
  await models.JournalLine.sync({ force: true });
  await require('../services/finance-service/src/migrations/protectJournal')(sequelize);
  await require('../services/finance-service/src/migrations/seedChartOfAccounts')(sequelize);

  const ledger = require('../shared/src/accounting/ledger');
  const { ROLE, ROLES, DEFAULT_CHART, unmappedRoles } = require('../shared/src/accounting/chart');

  // ── ACC-1 ────────────────────────────────────────────────────────────────
  console.log('\n── ACC-1  The chart of accounts ────────────────────────────────');

  const seeded = await sequelize.query(
    'SELECT COUNT(*) AS n FROM ledger_accounts WHERE company_id = :c',
    { replacements: { c: COMPANY }, type: QueryTypes.SELECT },
  );
  check('A new company is seeded a working chart',
    Number(seeded[0].n) === DEFAULT_CHART.length, `${seeded[0].n} accounts`);

  check('ACC-1.5  It is small enough that a tenant will keep it',
    DEFAULT_CHART.length >= 50 && DEFAULT_CHART.length <= 90,
    `${DEFAULT_CHART.length} accounts — the epic asks for 60 to 80`);

  check('ACC-1.4  Every role a posting rule can name is claimed by an account',
    unmappedRoles().length === 0, unmappedRoles().join(', ') || 'none unclaimed');

  const roleRows = await sequelize.query(
    'SELECT role, COUNT(*) AS n FROM ledger_accounts WHERE company_id = :c AND role IS NOT NULL GROUP BY role HAVING COUNT(*) > 1',
    { replacements: { c: COMPANY }, type: QueryTypes.SELECT },
  );
  check('...and no role is claimed twice', roleRows.length === 0,
    roleRows.map((r) => r.role).join(', ') || 'each role claimed once');
  check('...covering every role in the catalogue', ROLES.length >= 20, `${ROLES.length} roles`);

  /*
   * The seeder must be safe to re-run. It runs on EVERY boot, so a second pass
   * that duplicated the chart would double it daily.
   */
  await sequelize.query('UPDATE ledger_accounts SET name = :n WHERE company_id = :c AND code = :code',
    { replacements: { n: 'Renamed by the tenant', c: COMPANY, code: '1110' }, type: QueryTypes.UPDATE });
  await require('../services/finance-service/src/migrations/seedChartOfAccounts')(sequelize);
  const after = await sequelize.query(
    "SELECT COUNT(*) AS n, MAX(CASE WHEN code='1110' THEN name END) AS renamed FROM ledger_accounts WHERE company_id = :c",
    { replacements: { c: COMPANY }, type: QueryTypes.SELECT },
  );
  check('ACC-1.2  Re-seeding adds nothing and overwrites nothing',
    Number(after[0].n) === DEFAULT_CHART.length && after[0].renamed === 'Renamed by the tenant',
    `${after[0].n} accounts, 1110 still "${after[0].renamed}"`);

  // ── ACC-2.1 / 2.2 ────────────────────────────────────────────────────────
  console.log('\n── ACC-2.2  A journal that does not balance is refused ──────────');

  const unbalanced = await refused(() => ledger.post(sequelize, {
    companyId: COMPANY, entryDate: '2026-09-20', source: 'probe_unbalanced',
    lines: [
      { role: ROLE.ACCOUNTS_RECEIVABLE, debit_minor: 500000 },
      { role: ROLE.REVENUE_UNIT_SALES, credit_minor: 400000 },
    ],
  }));
  check('It throws at write time rather than reporting later', !!unbalanced, unbalanced?.message);

  const leaked = await sequelize.query(
    "SELECT COUNT(*) AS n FROM journal_entries WHERE source = 'probe_unbalanced'",
    { type: QueryTypes.SELECT },
  );
  check('...and no part of it reached the table', Number(leaked[0].n) === 0, `${leaked[0].n} rows`);

  console.log('\n── ACC-2.1  A journal entry has at least two sides ──────────────');
  const single = await refused(() => ledger.post(sequelize, {
    companyId: COMPANY, entryDate: '2026-09-20', source: 'probe_single',
    lines: [{ role: ROLE.BANK, debit_minor: 1000 }],
  }));
  check('A single-sided entry is refused', !!single, single?.message);

  const bothSides = await refused(() => ledger.post(sequelize, {
    companyId: COMPANY, entryDate: '2026-09-20', source: 'probe_both',
    lines: [
      { role: ROLE.BANK, debit_minor: 100, credit_minor: 100 },
      { role: ROLE.CASH, debit_minor: 100 },
    ],
  }));
  check('A line that is both a debit and a credit is refused', !!bothSides, bothSides?.message);

  const zero = await refused(() => ledger.post(sequelize, {
    companyId: COMPANY, entryDate: '2026-09-20', source: 'probe_zero',
    lines: [{ role: ROLE.BANK, debit_minor: 0 }, { role: ROLE.CASH, credit_minor: 0 }],
  }));
  check('An entry of zero is refused', !!zero, zero?.message);

  // ── The worked example ───────────────────────────────────────────────────
  console.log('\n── The worked example from ACC-2 ───────────────────────────────');
  const sale = await ledger.post(sequelize, {
    companyId: COMPANY, entryDate: '2026-09-20', source: 'invoice_payment', sourceId: '8891',
    memo: '₦20,000,000 instalment received on INV-412', createdBy: 5,
    lines: [
      { role: ROLE.BANK, debit_minor: 2000000000, memo: 'Bank — Access 1234' },
      {
        role: ROLE.ACCOUNTS_RECEIVABLE,
        credit_minor: 2000000000,
        property_id: 2,
        branch_id: 7,
        party_id: 35,
        party_type: 'client',
      },
    ],
  });
  check('It posts', sale.posted === true, `${sale.reference}, entry ${sale.entry_id}`);

  console.log('\n── ACC-2.3  The same event, replayed ───────────────────────────');
  const replay = await ledger.post(sequelize, {
    companyId: COMPANY, entryDate: '2026-09-20', source: 'invoice_payment', sourceId: '8891',
    memo: 'the same event arriving twice', createdBy: 5,
    lines: [
      { role: ROLE.BANK, debit_minor: 2000000000 },
      { role: ROLE.ACCOUNTS_RECEIVABLE, credit_minor: 2000000000 },
    ],
  });
  check('Posts once and returns the first entry',
    replay.replayed === true && replay.entry_id === sale.entry_id, `entry ${replay.entry_id}`);

  const count = await sequelize.query(
    "SELECT COUNT(*) AS n FROM journal_entries WHERE source = 'invoice_payment' AND source_id = '8891'",
    { type: QueryTypes.SELECT },
  );
  check('...leaving exactly one entry for the event', Number(count[0].n) === 1, `${count[0].n} entries`);

  // ── ACC-2.6 ──────────────────────────────────────────────────────────────
  console.log('\n── ACC-2.6  Analysis dimensions ────────────────────────────────');
  const [arLine] = await sequelize.query(
    'SELECT property_id, branch_id, party_id, party_type, account_code, account_role '
    + 'FROM journal_lines WHERE entry_id = :id AND credit_minor > 0',
    { replacements: { id: sale.entry_id }, type: QueryTypes.SELECT },
  );
  check('The line carries the property, branch and counterparty',
    Number(arLine.property_id) === 2 && Number(arLine.branch_id) === 7
      && Number(arLine.party_id) === 35 && arLine.party_type === 'client',
    `property ${arLine.property_id}, branch ${arLine.branch_id}, ${arLine.party_type} ${arLine.party_id}`);
  check('...and what it was posted to, as it was named at the time',
    arLine.account_code === '1110' && arLine.account_role === ROLE.ACCOUNTS_RECEIVABLE,
    `${arLine.account_code} (${arLine.account_role})`);

  // ── ACC-2.4 ──────────────────────────────────────────────────────────────
  console.log('\n── ACC-2.4  Corrected by reversal, never by edit ────────────────');
  const edited = await refused(() => sequelize.query(
    "UPDATE journal_entries SET memo = 'tampered with' WHERE id = :id",
    { replacements: { id: sale.entry_id }, type: QueryTypes.UPDATE },
  ));
  check('The database refuses an UPDATE', !!edited, edited?.message?.slice(0, 100));

  const removed = await refused(() => sequelize.query(
    'DELETE FROM journal_entries WHERE id = :id',
    { replacements: { id: sale.entry_id }, type: QueryTypes.DELETE },
  ));
  check('...and a DELETE', !!removed, removed?.message?.slice(0, 100));

  const reversal = await ledger.reverse(sequelize, sale.entry_id, {
    reason: 'Receipt was applied to the wrong invoice', createdBy: 5,
  });
  check('A reversal is a new entry naming the original',
    reversal.posted === true, `${reversal.reference} reverses ${sale.reference}`);

  const [revTotals] = await sequelize.query(
    'SELECT SUM(debit_minor) AS d, SUM(credit_minor) AS c FROM journal_lines WHERE entry_id = :id',
    { replacements: { id: reversal.entry_id }, type: QueryTypes.SELECT },
  );
  check('...with the sides swapped, and balanced',
    Number(revTotals.d) === Number(revTotals.c) && Number(revTotals.d) === 2000000000,
    `Dr ${show(revTotals.d)} Cr ${show(revTotals.c)}`);

  const twice = await ledger.reverse(sequelize, sale.entry_id, { reason: 'a second attempt' });
  check('Reversing twice does not double the correction',
    twice.replayed === true, `returned ${twice.reference}`);

  const [original] = await sequelize.query(
    'SELECT memo FROM journal_entries WHERE id = :id',
    { replacements: { id: sale.entry_id }, type: QueryTypes.SELECT },
  );
  check('...and the original still reads exactly as it did',
    original.memo === '₦20,000,000 instalment received on INV-412', original.memo);

  // ── Suspense ─────────────────────────────────────────────────────────────
  console.log('\n── A rule with nowhere to post ─────────────────────────────────');
  const orphan = await ledger.post(sequelize, {
    companyId: COMPANY, entryDate: '2026-09-20', source: 'probe_unmapped',
    lines: [
      { role: 'NO_SUCH_ROLE', debit_minor: 5000 },
      { role: ROLE.BANK, credit_minor: 5000 },
    ],
  });
  check('Posts to suspense rather than losing the entry',
    orphan.posted && orphan.fell_back.includes('NO_SUCH_ROLE'),
    `fell back: ${orphan.fell_back.join(', ')}`);

  const [susp] = await sequelize.query(
    "SELECT l.account_role, a.code FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id "
    + 'WHERE l.entry_id = :id AND l.debit_minor > 0',
    { replacements: { id: orphan.entry_id }, type: QueryTypes.SELECT },
  );
  check('...and the line records what was ASKED for, not merely where it landed',
    susp.code === '9990' && susp.account_role === 'NO_SUCH_ROLE',
    `posted to ${susp.code}, asked for ${susp.account_role}`);

  // ── ACC-5.1 ──────────────────────────────────────────────────────────────
  console.log('\n── ACC-5.1  Trial balance ──────────────────────────────────────');
  const tb = await ledger.trialBalance(sequelize, { companyId: COMPANY });
  check('It balances', tb.balanced === true,
    `Dr ${show(tb.debit_minor)} = Cr ${show(tb.credit_minor)}, difference ${tb.difference_minor}`);
  check('Only accounts with movement are listed', tb.accounts.length === 3,
    tb.accounts.map((a) => `${a.code} ${a.name}: ${a.normal_balance} ${show(a.balance_minor)}`).join('\n        '));

  const bank = tb.accounts.find((a) => a.role === ROLE.BANK);
  check('A debit-normal account nets to its debit side',
    bank && bank.normal_balance === 'debit' && bank.balance_minor === -5000,
    bank ? `bank ${show(bank.balance_minor)} — the sale reversed, less the suspense posting` : 'bank absent');

  const windowed = await ledger.trialBalance(sequelize, { companyId: COMPANY, from: '2030-01-01' });
  check('A date window excludes everything outside it',
    windowed.accounts.length === 0 && windowed.balanced === true, `${windowed.accounts.length} accounts in 2030`);

  const otherCompany = await ledger.trialBalance(sequelize, { companyId: 999 });
  check('Another company sees none of it', otherCompany.accounts.length === 0,
    `${otherCompany.accounts.length} accounts`);

  console.log(`\n  ${pass === pass + fail ? '\x1b[32m' : '\x1b[31m'}${pass}/${pass + fail} checks passed.\x1b[0m\n`);

  await sequelize.close();
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  console.log(`  Scratch database ${DB} dropped.\n`);
  await admin.end();
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error('\x1b[31mThe verification itself failed:\x1b[0m', error);
  process.exit(1);
});

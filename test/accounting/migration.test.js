const test = require('node:test');
const assert = require('node:assert/strict');

const {
  typeFromWord, parseChartCsv, parseOpeningBalancesCsv, parseOpenItemsCsv,
} = require('../../shared/src/accounting/migration');
const { TYPE } = require('../../shared/src/accounting/chart');

/**
 * Reading somebody else's books (ACC-9).
 *
 * ── The failures worth catching here ────────────────────────────────────────
 *
 * An account typed wrongly puts a liability in the assets and produces a
 * balance sheet that balances while describing a different company. A trial
 * balance that does not balance and is imported anyway hides the difference
 * somewhere nobody looks. And an open-items file that does not add up to the
 * control account leaves a receivables ledger that never reconciles — from the
 * first day, for ever, until somebody eventually asks who owes the money.
 *
 * All three produce a successful-looking import, which is why they are tested
 * rather than trusted.
 */

// ── ACC-9.6: the type vocabulary ────────────────────────────────────────────

test('each package\'s word for a type is understood', () => {
  assert.equal(typeFromWord('Other Current Asset'), TYPE.ASSET);      // QuickBooks
  assert.equal(typeFromWord('Current Liability'), TYPE.LIABILITY);
  assert.equal(typeFromWord('Capital and Reserves'), TYPE.EQUITY);    // Sage
  assert.equal(typeFromWord('Turnover'), TYPE.INCOME);
  assert.equal(typeFromWord('Cost of Goods Sold'), TYPE.EXPENSE);
});

test('a word nobody can be sure of returns null rather than a guess', () => {
  assert.equal(typeFromWord('Nominal Group 4'), null);
  assert.equal(typeFromWord(''), null);
});

test('a per-source mapping overrides everything', () => {
  // ACC-9.6's classify screen writes one of these.
  assert.equal(typeFromWord('nominal group 4', { 'nominal group 4': TYPE.INCOME }), TYPE.INCOME);
});

test('an exact match is never second-guessed by a substring', () => {
  // "cash" is in the asset list; "cash flow" is not a type anybody means.
  assert.equal(typeFromWord('Cash'), TYPE.ASSET);
});

// ── ACC-9.2: the chart ──────────────────────────────────────────────────────

test('a chart export is read, whatever it calls its columns', () => {
  const result = parseChartCsv([
    'Nominal Code,Account Name,Category,Parent',
    '1100,Debtors,Current Asset,1000',
    '4000,Sales,Turnover,',
  ].join('\n'));

  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.records.map((row) => [row.code, row.type]), [
    ['1100', TYPE.ASSET],
    ['4000', TYPE.INCOME],
  ]);
});

test('an account whose type is unrecognised is held back, not refused', () => {
  const result = parseChartCsv([
    'code,name,type',
    '1100,Debtors,Current Asset',
    '9000,Mystery,Nominal Group 4',
  ].join('\n'));

  // The FILE is fine; somebody just has to say what the word means.
  assert.equal(result.errors.length, 0);
  assert.equal(result.unclassified.length, 1);
  assert.equal(result.unclassified[0].code, '9000');
});

test('a duplicated account code is an error', () => {
  const result = parseChartCsv('code,name,type\n1100,Debtors,Asset\n1100,Also debtors,Asset');
  assert.match(result.errors[0], /appears more than once/);
});

test('a chart with no code column is refused outright', () => {
  const result = parseChartCsv('name,type\nDebtors,Asset');
  assert.equal(result.records.length, 0);
  assert.match(result.errors[0], /No code column/);
});

// ── ACC-9.3: opening balances ───────────────────────────────────────────────

test('a two-column trial balance is read and checked', () => {
  const result = parseOpeningBalancesCsv([
    'Account,Name,Debit,Credit',
    '1020,Bank,"1,500,000.00",',
    '1110,Trade debtors,"4,200,000.00",',
    '2010,Trade creditors,,"700,000.00"',
    '3010,Share capital,,"5,000,000.00"',
  ].join('\n'));

  assert.equal(result.errors.length, 0);
  assert.equal(result.debit_minor, 570000000);
  assert.equal(result.credit_minor, 570000000);
  assert.equal(result.balanced, true);
});

test('a trial balance that does not balance says so, and by how much', () => {
  const result = parseOpeningBalancesCsv([
    'Account,Debit,Credit',
    '1020,"1,500,000.00",',
    '3010,,"1,400,000.00"',
  ].join('\n'));

  assert.equal(result.balanced, false);
  assert.equal(result.difference_minor, 10000000);
});

test('a single signed balance column reads a minus as the other side', () => {
  /*
   * Here a negative IS unambiguous — there is no second column it could have
   * belonged to — unlike the two-column layout where a bracket is refused.
   */
  const result = parseOpeningBalancesCsv([
    'Account,Balance',
    '1020,"1,500,000.00"',
    '3010,"-1,500,000.00"',
  ].join('\n'));

  assert.equal(result.records[0].debit_minor, 150000000);
  assert.equal(result.records[1].credit_minor, 150000000);
  assert.equal(result.balanced, true);
});

test('an account with a balance on both sides is an error', () => {
  const result = parseOpeningBalancesCsv('Account,Debit,Credit\n1020,100,100');
  assert.match(result.errors[0], /debit or a credit, never both/);
});

test('an account with nothing on it is skipped, not an error', () => {
  const result = parseOpeningBalancesCsv('Account,Debit,Credit\n1020,100,\n1030,,\n2010,,100');
  assert.equal(result.errors.length, 0);
  assert.equal(result.records.length, 2);
});

// ── ACC-9.4: open items ─────────────────────────────────────────────────────

test('open invoices are read and totalled', () => {
  const result = parseOpenItemsCsv([
    'Customer,Invoice No,Invoice Date,Due Date,Amount,Paid',
    'Kelvin Obi,INV-1001,03/01/2026,02/02/2026,"5,000,000.00","1,000,000.00"',
    'Favour Ada,INV-1002,15/01/2026,14/02/2026,"2,000,000.00",',
  ].join('\n'));

  assert.equal(result.errors.length, 0);
  assert.equal(result.total_minor, 600000000);
  assert.equal(result.records[0].date, '2026-01-03'); // day-first
  assert.equal(result.records[0].outstanding_minor, 400000000);
});

test('a file that states an outstanding figure disagreeing with its own arithmetic is refused', () => {
  /*
   * It nearly always means a payment was recorded in one place and not the
   * other. Importing it would produce a subledger that never reconciles to
   * its control account, which is the exact failure ACC-9.4 exists to prevent.
   */
  const result = parseOpenItemsCsv([
    'Customer,Invoice,Amount,Paid,Outstanding',
    'Kelvin Obi,INV-1001,"5,000,000.00","1,000,000.00","5,000,000.00"',
  ].join('\n'));

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /recorded in one place and not the other/);
});

test('a file with only an outstanding column is enough', () => {
  const result = parseOpenItemsCsv([
    'Supplier,Document,Outstanding',
    'Adeyemi Contractors,SUP-88,"750,000.00"',
  ].join('\n'));

  assert.equal(result.errors.length, 0);
  assert.equal(result.total_minor, 75000000);
});

test('a row with no customer or no document number is an error', () => {
  const result = parseOpenItemsCsv([
    'Customer,Invoice,Amount',
    ',INV-1001,"100.00"',
    'Kelvin Obi,,"100.00"',
  ].join('\n'));
  assert.equal(result.errors.length, 2);
});

test('the date convention carries through to the open items', () => {
  const dayFirst = parseOpenItemsCsv('Customer,Invoice,Date,Amount\nA,I1,03/04/2026,100');
  const monthFirst = parseOpenItemsCsv(
    'Customer,Invoice,Date,Amount\nA,I1,03/04/2026,100',
    { dayFirst: false },
  );
  assert.equal(dayFirst.records[0].date, '2026-04-03');
  assert.equal(monthFirst.records[0].date, '2026-03-04');
});

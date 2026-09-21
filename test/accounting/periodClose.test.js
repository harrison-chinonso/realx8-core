const test = require('node:test');
const assert = require('node:assert/strict');

const { yearEndLines } = require('../../shared/src/accounting/periodClose');
const { imbalanceOf } = require('../../shared/src/accounting/rules');
const { TYPE, ROLE } = require('../../shared/src/accounting/chart');

/**
 * The year-end journal (ACC-7.4).
 *
 * ── The property worth asserting ────────────────────────────────────────────
 *
 * That closing a year changes NOTHING on the balance sheet. Retained earnings
 * is computed as the account balance plus income less expense; the close moves
 * the second part into the first. If the entry does anything other than that,
 * the balance sheet either side of a year end would disagree — and a company
 * would have two different answers to what it was worth on 31 December.
 */

const income = (id, balance) => ({
  account_id: id, type: TYPE.INCOME, balance_minor: balance, code: `40${id}`,
});
const expense = (id, balance) => ({
  account_id: id, type: TYPE.EXPENSE, balance_minor: balance, code: `50${id}`,
});

const retained = (lines) => lines.find((line) => line.role === ROLE.RETAINED_EARNINGS);

test('a profitable year credits retained earnings with the profit', () => {
  const { lines, profit_minor: profit } = yearEndLines([
    income(10, 5000000000),
    expense(20, 4000000000),
    expense(21, 600000000),
    // A balance sheet account is not touched by a year end at all.
    { account_id: 30, type: TYPE.ASSET, balance_minor: 123456, code: '1020' },
  ]);

  assert.equal(profit, 400000000);
  assert.equal(retained(lines).credit_minor, 400000000);
  assert.equal(imbalanceOf(lines), 0);
  assert.ok(!lines.some((line) => line.account_id === 30));
});

test('a loss-making year debits it', () => {
  const { lines, profit_minor: profit } = yearEndLines([
    income(10, 1000000),
    expense(20, 3500000),
  ]);

  assert.equal(profit, -2500000);
  assert.equal(retained(lines).debit_minor, 2500000);
  assert.equal(imbalanceOf(lines), 0);
});

test('each account is closed on its own line, so the journal says what it was made of', () => {
  const { lines } = yearEndLines([
    income(10, 3000000000),
    income(11, 2000000000),
    expense(20, 4600000000),
  ]);

  // Three accounts plus the retained earnings leg. A single "close income"
  // line for a company with fourteen revenue accounts is a number nobody can
  // take apart afterwards.
  assert.equal(lines.length, 4);
  assert.equal(lines.filter((line) => line.account_id === 10)[0].debit_minor, 3000000000);
  assert.equal(lines.filter((line) => line.account_id === 20)[0].credit_minor, 4600000000);
});

test('an account with no movement is not closed', () => {
  const { lines } = yearEndLines([
    income(10, 1000000),
    income(11, 0),
    expense(20, 400000),
  ]);
  assert.ok(!lines.some((line) => line.account_id === 11));
});

test('a contra-income account with a debit balance closes the other way', () => {
  /*
   * Discounts given sit in income with a NEGATIVE balance on the income side,
   * because they were debited. Closing them the same way as revenue would
   * credit an account that needs debiting and the entry would not balance.
   */
  const { lines, profit_minor: profit } = yearEndLines([
    income(10, 5000000000),
    income(90, -250000000), // discounts given
    expense(20, 4000000000),
  ]);

  const discounts = lines.find((line) => line.account_id === 90);
  assert.equal(discounts.credit_minor, 250000000);
  assert.equal(profit, 750000000);
  assert.equal(imbalanceOf(lines), 0);
});

test('a year with nothing in it produces no entry at all', () => {
  const { lines, profit_minor: profit } = yearEndLines([
    { account_id: 30, type: TYPE.ASSET, balance_minor: 500, code: '1020' },
  ]);
  assert.equal(lines.length, 0);
  assert.equal(profit, 0);
});

test('a break-even year still closes the accounts it had', () => {
  const { lines, profit_minor: profit } = yearEndLines([
    income(10, 1000000),
    expense(20, 1000000),
  ]);

  assert.equal(profit, 0);
  // Two lines, no retained earnings leg — there is nothing to carry forward,
  // but the income and expense accounts must still be emptied.
  assert.equal(lines.length, 2);
  assert.equal(retained(lines), undefined);
  assert.equal(imbalanceOf(lines), 0);
});

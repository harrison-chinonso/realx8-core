const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CHART, ROLE, ROLES, TYPE, NORMAL_BALANCE, unmappedRoles, parentCodeOf,
} = require('../../shared/src/accounting/chart');
const { SECTION, sectionOf } = require('../../shared/src/accounting/statements');

/**
 * The chart of accounts, and the classification the statements read off it.
 *
 * ── Why a chart is worth unit-testing at all ────────────────────────────────
 *
 * Because the posting rules address accounts by ROLE. A role the default chart
 * does not provide is an account the ledger cannot find, and every posting that
 * wanted it falls silently to suspense — which balances, and is wrong, and is
 * only noticed at a period close weeks later.
 */

test('every role a posting rule can ask for exists in the default chart', () => {
  const missing = unmappedRoles();
  assert.deepEqual(missing, [], `roles with no account: ${missing.join(', ')}`);
});

test('no two accounts share a code', () => {
  const codes = DEFAULT_CHART.map(([code]) => code);
  assert.equal(new Set(codes).size, codes.length);
});

test('no two accounts claim the same role', () => {
  // A second account claiming a role would make "which account is accounts
  // receivable" a question with two answers.
  const roles = DEFAULT_CHART.map(([, , , role]) => role).filter(Boolean);
  assert.equal(new Set(roles).size, roles.length);
});

test('every role used in the chart is in the catalogue', () => {
  DEFAULT_CHART.forEach(([code, name, , role]) => {
    if (!role) return;
    assert.ok(ROLES.includes(role), `${code} ${name} claims an unknown role ${role}`);
  });
});

test('every account has a type the statements understand', () => {
  const types = Object.values(TYPE);
  DEFAULT_CHART.forEach(([code, name, type]) => {
    assert.ok(types.includes(type), `${code} ${name} has type ${type}`);
  });
});

test('a code sits under its hundred', () => {
  assert.equal(parentCodeOf('1110'), '1100');
  assert.equal(parentCodeOf('1100'), null); // already top of its group
});

test('assets and expenses are debit accounts, the rest are credit', () => {
  assert.equal(NORMAL_BALANCE[TYPE.ASSET], 'debit');
  assert.equal(NORMAL_BALANCE[TYPE.EXPENSE], 'debit');
  assert.equal(NORMAL_BALANCE[TYPE.LIABILITY], 'credit');
  assert.equal(NORMAL_BALANCE[TYPE.EQUITY], 'credit');
  assert.equal(NORMAL_BALANCE[TYPE.INCOME], 'credit');
});

test('development work in progress is an ASSET, not an expense', () => {
  // Units under construction are inventory under IAS 2. Getting this wrong
  // would put eighteen months of build cost through the P&L.
  const [, , type] = DEFAULT_CHART.find(([, , , role]) => role === ROLE.DEVELOPMENT_WIP);
  assert.equal(type, TYPE.ASSET);
});

test('contract liability is a LIABILITY', () => {
  // Money invoiced and not yet earned is owed to the buyer in work.
  const [, , type] = DEFAULT_CHART.find(([, , , role]) => role === ROLE.CONTRACT_LIABILITY);
  assert.equal(type, TYPE.LIABILITY);
});

test('discounts given sit in income, as contra-income', () => {
  const [, , type] = DEFAULT_CHART.find(([, , , role]) => role === ROLE.REVENUE_DISCOUNTS);
  assert.equal(type, TYPE.INCOME);
});

// ── The cash flow classifier ───────────────────────────────────────────────

test('bank and cash accounts are the cash section', () => {
  assert.equal(sectionOf({ role: ROLE.BANK, code: '1020' }), SECTION.CASH);
  assert.equal(sectionOf({ role: ROLE.CASH, code: '1010' }), SECTION.CASH);
  // A second bank account with no role still lands in cash by its code.
  assert.equal(sectionOf({ role: null, code: '1030', type: TYPE.ASSET }), SECTION.CASH);
});

test('fixed assets are investing and borrowings are financing', () => {
  assert.equal(sectionOf({ role: null, code: '1420', type: TYPE.ASSET }), SECTION.INVESTING);
  assert.equal(sectionOf({ role: null, code: '2410', type: TYPE.LIABILITY }), SECTION.FINANCING);
});

test('equity is financing whatever it is numbered', () => {
  assert.equal(sectionOf({ role: null, code: '9999', type: TYPE.EQUITY }), SECTION.FINANCING);
});

test('work in progress is operating, not investing', () => {
  // It is inventory. Classifying it as investing would describe building
  // houses to sell as buying assets to keep.
  assert.equal(sectionOf({ role: ROLE.DEVELOPMENT_WIP, code: '1210', type: TYPE.ASSET }), SECTION.OPERATING);
});

test('anything unrecognised falls to operating rather than being dropped', () => {
  /*
   * An unclassified movement in operating makes the section totals look odd
   * enough to ask about; dropping it would balance nothing and say nothing.
   */
  assert.equal(sectionOf({ role: null, code: '1130', type: TYPE.ASSET }), SECTION.OPERATING);
});

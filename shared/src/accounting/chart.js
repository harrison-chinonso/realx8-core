/**
 * The default chart of accounts, and the roles a posting rule addresses.
 *
 * ── Roles, not codes (ACC-1.4) ──────────────────────────────────────────────
 *
 * Every posting rule in the system names a ROLE — `ACCOUNTS_RECEIVABLE`, not
 * `1200`. The role-to-code mapping is per company and editable, so a tenant who
 * renumbers their chart to match the one they already use breaks nothing.
 *
 * The commission engine has been written this way since before there was a
 * ledger to post to: `shared/src/commissionAnalytics.js` names
 * COMMISSION_PAYABLE and BANK rather than numbers. This keeps that vocabulary
 * and gives it somewhere to resolve to.
 *
 * ── Deliberately small (ACC-1.5) ────────────────────────────────────────────
 *
 * Sixty-odd accounts, not four hundred. An over-large default is the commonest
 * reason a tenant abandons the seeded chart and imports their own, which costs
 * the migration the seed exists to avoid. Anything genuinely company-specific
 * — a cost centre per estate, a bank account per branch — is added by the
 * tenant, and the analysis dimensions on a journal line (ACC-2.6) mean most of
 * those never need to be accounts at all.
 */

/** Every account is one of these. Determines which statement it lands on. */
const TYPE = {
  ASSET: 'asset',
  LIABILITY: 'liability',
  EQUITY: 'equity',
  INCOME: 'income',
  EXPENSE: 'expense',
};

/**
 * Which side increases the balance.
 *
 * Kept as data rather than as a branch in every reader: a trial balance, a
 * P&L and a balance sheet all need it, and three copies of "asset and expense
 * are debit-normal" is three places to get it wrong.
 */
const NORMAL_BALANCE = {
  [TYPE.ASSET]: 'debit',
  [TYPE.EXPENSE]: 'debit',
  [TYPE.LIABILITY]: 'credit',
  [TYPE.EQUITY]: 'credit',
  [TYPE.INCOME]: 'credit',
};

/**
 * The roles a posting rule may name.
 *
 * A role that no account claims is a posting rule that cannot fire, so
 * `unmappedRoles` below reports them and the seeder claims every one of these.
 * The same reasoning as the permission catalogue's: defining something nobody
 * holds is worse than not defining it, because it reads as available.
 */
const ROLE = {
  BANK: 'BANK',
  CASH: 'CASH',
  ACCOUNTS_RECEIVABLE: 'ACCOUNTS_RECEIVABLE',
  ACCOUNTS_PAYABLE: 'ACCOUNTS_PAYABLE',
  CUSTOMER_CREDIT_BALANCES: 'CUSTOMER_CREDIT_BALANCES',
  CONTRACT_LIABILITY: 'CONTRACT_LIABILITY',
  VAT_OUTPUT: 'VAT_OUTPUT',
  VAT_INPUT: 'VAT_INPUT',
  WITHHOLDING_PAYABLE: 'WITHHOLDING_PAYABLE',
  COMMISSION_EXPENSE: 'COMMISSION_EXPENSE',
  COMMISSION_ACCRUED: 'COMMISSION_ACCRUED',
  COMMISSION_PAYABLE: 'COMMISSION_PAYABLE',
  COMMISSION_RECEIVABLE: 'COMMISSION_RECEIVABLE',
  COMMISSION_BREAKAGE: 'COMMISSION_BREAKAGE',
  COMMISSION_HELD: 'COMMISSION_HELD',
  COMMISSION_AWARDS: 'COMMISSION_AWARDS',
  DEVELOPMENT_WIP: 'DEVELOPMENT_WIP',
  COST_OF_SALES: 'COST_OF_SALES',
  INVENTORY_WRITE_DOWN: 'INVENTORY_WRITE_DOWN',
  REVENUE_UNIT_SALES: 'REVENUE_UNIT_SALES',
  REVENUE_FEES: 'REVENUE_FEES',
  REVENUE_DISCOUNTS: 'REVENUE_DISCOUNTS',
  SUSPENSE: 'SUSPENSE',
  OPENING_BALANCE_EQUITY: 'OPENING_BALANCE_EQUITY',
  RETAINED_EARNINGS: 'RETAINED_EARNINGS',
};

const ROLES = Object.values(ROLE);

/**
 * The seed. `[code, name, type, role?]`.
 *
 * Codes follow the ordinary 1000/2000/3000/4000/5000 convention because a
 * Nigerian accountant opening this for the first time should recognise it
 * without being taught. They are only a default: ACC-1.1 makes the code
 * editable and every rule addresses the role instead.
 */
const DEFAULT_CHART = [
  // ── 1000 assets ──────────────────────────────────────────────────────────
  ['1000', 'Cash and bank', TYPE.ASSET, null],
  ['1010', 'Cash on hand', TYPE.ASSET, ROLE.CASH],
  ['1020', 'Bank — current account', TYPE.ASSET, ROLE.BANK],
  ['1030', 'Bank — collections account', TYPE.ASSET, null],
  ['1100', 'Receivables', TYPE.ASSET, null],
  ['1110', 'Accounts receivable', TYPE.ASSET, ROLE.ACCOUNTS_RECEIVABLE],
  ['1120', 'Commission recoverable', TYPE.ASSET, ROLE.COMMISSION_RECEIVABLE],
  ['1130', 'Other receivables', TYPE.ASSET, null],
  ['1200', 'Inventory', TYPE.ASSET, null],
  /*
   * Units under construction are inventory under IAS 2, not fixed assets —
   * ACC-10. Seeded now, though nothing posts to it until Phase 4, because
   * adding a control account to a chart a tenant has already edited is the
   * awkward case ACC-1.2 exists to avoid.
   */
  ['1210', 'Development work in progress', TYPE.ASSET, ROLE.DEVELOPMENT_WIP],
  ['1220', 'Completed units held for sale', TYPE.ASSET, null],
  ['1300', 'Prepayments and input tax', TYPE.ASSET, null],
  ['1310', 'VAT input (recoverable)', TYPE.ASSET, ROLE.VAT_INPUT],
  ['1320', 'Prepaid expenses', TYPE.ASSET, null],
  ['1400', 'Property, plant and equipment', TYPE.ASSET, null],
  ['1410', 'Office equipment', TYPE.ASSET, null],
  ['1420', 'Motor vehicles', TYPE.ASSET, null],
  ['1430', 'Furniture and fittings', TYPE.ASSET, null],
  ['1490', 'Accumulated depreciation', TYPE.ASSET, null],

  // ── 2000 liabilities ─────────────────────────────────────────────────────
  ['2000', 'Payables', TYPE.LIABILITY, null],
  ['2010', 'Accounts payable', TYPE.LIABILITY, ROLE.ACCOUNTS_PAYABLE],
  ['2020', 'Accruals', TYPE.LIABILITY, null],
  ['2100', 'Amounts owed to customers', TYPE.LIABILITY, null],
  /*
   * An overpayment is the company holding a buyer's money, which is a
   * liability and not a negative receivable. ACC-0.5's refund discharges it.
   */
  ['2110', 'Customer credit balances', TYPE.LIABILITY, ROLE.CUSTOMER_CREDIT_BALANCES],
  /*
   * Invoiced and collected, not yet recognised as revenue because control has
   * not passed. The other half of ACC-8 — without it, deferring revenue has
   * nowhere to defer it to.
   */
  ['2120', 'Contract liability (deferred revenue)', TYPE.LIABILITY, ROLE.CONTRACT_LIABILITY],
  ['2200', 'Commission owed', TYPE.LIABILITY, null],
  ['2210', 'Commission accrued (not yet due)', TYPE.LIABILITY, ROLE.COMMISSION_ACCRUED],
  ['2220', 'Commission payable', TYPE.LIABILITY, ROLE.COMMISSION_PAYABLE],
  ['2230', 'Commission held pending reinstatement', TYPE.LIABILITY, ROLE.COMMISSION_HELD],
  ['2240', 'Non-cash awards payable', TYPE.LIABILITY, ROLE.COMMISSION_AWARDS],
  ['2300', 'Tax', TYPE.LIABILITY, null],
  ['2310', 'VAT output (payable)', TYPE.LIABILITY, ROLE.VAT_OUTPUT],
  ['2320', 'Withholding tax payable', TYPE.LIABILITY, ROLE.WITHHOLDING_PAYABLE],
  ['2330', 'PAYE payable', TYPE.LIABILITY, null],
  ['2400', 'Borrowings', TYPE.LIABILITY, null],
  ['2410', 'Loans payable', TYPE.LIABILITY, null],

  // ── 3000 equity ──────────────────────────────────────────────────────────
  ['3000', 'Equity', TYPE.EQUITY, null],
  ['3010', 'Share capital', TYPE.EQUITY, null],
  ['3020', 'Retained earnings', TYPE.EQUITY, ROLE.RETAINED_EARNINGS],
  /*
   * Where a migration's opening balances land, so they never masquerade as
   * this year's trading. ACC-9 posts here; nothing else should.
   */
  ['3030', 'Opening balance equity', TYPE.EQUITY, ROLE.OPENING_BALANCE_EQUITY],
  ['3040', 'Current year earnings', TYPE.EQUITY, null],

  // ── 4000 income ──────────────────────────────────────────────────────────
  ['4000', 'Revenue', TYPE.INCOME, null],
  ['4010', 'Unit sales', TYPE.INCOME, ROLE.REVENUE_UNIT_SALES],
  ['4020', 'Land sales', TYPE.INCOME, null],
  /*
   * Where a service-fee invoice lands — verification and level-up fees under
   * ACC-0.1. Separate from unit sales because it is not property revenue and
   * a developer's margin reporting should not be polluted by it.
   */
  ['4030', 'Fee income', TYPE.INCOME, ROLE.REVENUE_FEES],
  ['4040', 'Rental income', TYPE.INCOME, null],
  /*
   * Contra-income, kept as its own account rather than netted off revenue, so
   * that discounting is visible rather than invisible. ACC-3.1.
   */
  ['4090', 'Discounts given', TYPE.INCOME, ROLE.REVENUE_DISCOUNTS],
  ['4100', 'Other income', TYPE.INCOME, null],
  ['4110', 'Interest and penalties received', TYPE.INCOME, null],
  /*
   * Commission that went unpaid — an upline who did not qualify, a share below
   * the floor. Income because the pool was charged and the money never left.
   */
  ['4120', 'Commission breakage', TYPE.INCOME, ROLE.COMMISSION_BREAKAGE],

  // ── 5000 expenses ────────────────────────────────────────────────────────
  ['5000', 'Cost of sales', TYPE.EXPENSE, null],
  ['5010', 'Cost of units sold', TYPE.EXPENSE, ROLE.COST_OF_SALES],
  ['5020', 'Cost of land sold', TYPE.EXPENSE, null],
  /*
   * Kept out of 5010 on purpose (ACC-10.5).
   *
   * A write-down is a loss on a project that cost more than it will now
   * fetch; the cost of units sold is what a sale actually consumed. Folding
   * the first into the second makes a stalled estate look like an expensive
   * one, and IAS 2 asks for the amount of any write-down recognised in the
   * period to be disclosed — which is not possible if it was never a line.
   */
  ['5030', 'Write-down of development inventory', TYPE.EXPENSE, ROLE.INVENTORY_WRITE_DOWN],
  ['5100', 'Selling costs', TYPE.EXPENSE, null],
  ['5110', 'Commission expense', TYPE.EXPENSE, ROLE.COMMISSION_EXPENSE],
  ['5120', 'Marketing and advertising', TYPE.EXPENSE, null],
  ['5200', 'Administrative expenses', TYPE.EXPENSE, null],
  ['5210', 'Salaries and wages', TYPE.EXPENSE, null],
  ['5220', 'Rent and rates', TYPE.EXPENSE, null],
  ['5230', 'Utilities', TYPE.EXPENSE, null],
  ['5240', 'Professional fees', TYPE.EXPENSE, null],
  ['5250', 'Travel and transport', TYPE.EXPENSE, null],
  ['5260', 'Repairs and maintenance', TYPE.EXPENSE, null],
  ['5270', 'Office and general', TYPE.EXPENSE, null],
  ['5280', 'Depreciation', TYPE.EXPENSE, null],
  ['5290', 'Bad debts written off', TYPE.EXPENSE, null],
  ['5300', 'Finance costs', TYPE.EXPENSE, null],
  ['5310', 'Bank charges', TYPE.EXPENSE, null],
  ['5320', 'Interest paid', TYPE.EXPENSE, null],

  // ── 9000 the one account that must always exist ──────────────────────────
  /*
   * Where a posting goes when a rule cannot resolve its account, rather than
   * the posting being dropped. A non-zero suspense balance fails the ACC-7.2
   * close checklist, which is exactly the right consequence: it is visible,
   * it blocks, and it names what it is holding.
   */
  ['9990', 'Suspense', TYPE.ASSET, ROLE.SUSPENSE],
];

/** Roles the default chart does not claim. Empty, and asserted to stay empty. */
const unmappedRoles = (chart = DEFAULT_CHART) => {
  const claimed = new Set(chart.map(([, , , role]) => role).filter(Boolean));
  return ROLES.filter((role) => !claimed.has(role));
};

/** A parent code for `1110` is `1100`; for a top-level account, none. */
const parentCodeOf = (code) => {
  const text = String(code);
  if (text.length !== 4 || text.endsWith('000')) return null;
  const parent = `${text.slice(0, 2)}00`;
  return parent === text ? null : parent;
};

module.exports = {
  TYPE, NORMAL_BALANCE, ROLE, ROLES, DEFAULT_CHART, unmappedRoles, parentCodeOf,
};

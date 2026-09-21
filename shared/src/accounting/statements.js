const { QueryTypes } = require('sequelize');
const { q } = require('../dialect');
const { NORMAL_BALANCE, ROLE, TYPE } = require('./chart');

/**
 * The statements (ACC-5).
 *
 * ── Every one of these is a query over the journal ──────────────────────────
 *
 * Nothing here is stored, accumulated or cached. A profit and loss is the
 * income and expense lines in a window; a balance sheet is every other line up
 * to a date. That is not a simplification — it is the property that makes the
 * statements trustworthy, because there is no second copy of the numbers to
 * drift from the first.
 *
 * It also means they cost nothing until ACC-2 and ACC-3 are right, and are
 * impossible before. The work was in getting the journals correct; this file
 * mostly adds up.
 *
 * ── Three places this deliberately shows its working ────────────────────────
 *
 * Retained earnings is COMPUTED rather than stored, so a balance sheet can
 * never disagree with the profit and loss above it.
 *
 * The cash flow RECONCILES to the movement in cash, and says so on the
 * payload. An indirect cash flow is a classification exercise, and a chart
 * this one has not been taught about would otherwise produce a statement that
 * looks complete and is wrong by exactly the amount it could not classify.
 *
 * And the cash-basis profit and loss is DERIVED from the accrual ledger rather
 * than posted a second way. Accrual is the superset: cash can be recovered
 * from it, receivables cannot be reconstructed from cash.
 */

/** Where an account sits in the cash flow, by the chart's own numbering. */
const SECTION = {
  OPERATING: 'operating',
  INVESTING: 'investing',
  FINANCING: 'financing',
  CASH: 'cash',
};

/**
 * Classify a balance-sheet account for the cash flow.
 *
 * By code range, because the default chart is organised by them and a company
 * that renumbers to match its old system keeps the ranges — 1400s are fixed
 * assets everywhere this has been seen. Roles take precedence where one
 * exists, since a role survives renumbering and a range does not.
 *
 * Anything unrecognised is OPERATING, which is both the commonest answer and
 * the one whose error is visible: an unclassified financing movement lands in
 * operating and the reconciliation still balances, while the section totals
 * look odd enough to ask about. Silently dropping it would balance nothing.
 */
const sectionOf = (account) => {
  if ([ROLE.CASH, ROLE.BANK].includes(account.role)) return SECTION.CASH;
  if (account.role === ROLE.DEVELOPMENT_WIP) return SECTION.OPERATING;
  if (account.type === TYPE.EQUITY) return SECTION.FINANCING;

  const code = String(account.code || '');
  // 1000–1039 is cash and bank however it has been renamed.
  if (/^10[0-3]/.test(code)) return SECTION.CASH;
  // 1400–1499: property, plant and equipment.
  if (/^14/.test(code)) return SECTION.INVESTING;
  // 2400–2499: borrowings.
  if (/^24/.test(code)) return SECTION.FINANCING;
  return SECTION.OPERATING;
};

const bounds = (replacements, { from, to, asAt }) => {
  const clauses = [];
  if (from) { clauses.push('AND e.entry_date >= :from'); replacements.from = from; }
  if (to || asAt) { clauses.push('AND e.entry_date <= :to'); replacements.to = to || asAt; }
  return clauses.join(' ');
};

const dimensionFilter = (replacements, { propertyId, branchId }) => {
  const clauses = [];
  if (propertyId) { clauses.push('AND l.property_id = :propertyId'); replacements.propertyId = propertyId; }
  if (branchId) { clauses.push('AND l.branch_id = :branchId'); replacements.branchId = branchId; }
  return clauses.join(' ');
};

/**
 * Every account with movement in a window, with the balance on its normal side.
 *
 * The date window narrows the LINES through a subquery rather than sitting on
 * a join to the entries — written the obvious way it filters the entry and not
 * the line, and a statement for a future year quietly returns the whole
 * ledger. The trial balance was caught doing exactly that.
 */
const balances = async (sequelize, {
  companyId = null, from = null, to = null, asAt = null,
  propertyId = null, branchId = null,
} = {}) => {
  const replacements = { companyId: companyId ?? null };
  const window = bounds(replacements, { from, to, asAt });
  const dimensions = dimensionFilter(replacements, { propertyId, branchId });

  const rows = await sequelize.query(
    `SELECT a.id, a.code, a.name, a.${q(sequelize, 'type')} AS type, a.role, a.parent_code,
            COALESCE(SUM(m.debit_minor), 0) AS debit_minor,
            COALESCE(SUM(m.credit_minor), 0) AS credit_minor
       FROM ledger_accounts a
       LEFT JOIN (
         SELECT l.account_id, l.debit_minor, l.credit_minor
           FROM journal_lines l
           JOIN journal_entries e ON e.id = l.entry_id
          WHERE 1 = 1 ${window} ${dimensions}
       ) m ON m.account_id = a.id
      WHERE a.company_id ${companyId ? '= :companyId' : 'IS NULL'}
      GROUP BY a.id, a.code, a.name, a.${q(sequelize, 'type')}, a.role, a.parent_code
      ORDER BY a.code`,
    { replacements, type: QueryTypes.SELECT },
  );

  return rows.map((row) => {
    const debit = Number(row.debit_minor) || 0;
    const credit = Number(row.credit_minor) || 0;
    const normal = NORMAL_BALANCE[row.type] || 'debit';
    return {
      account_id: Number(row.id),
      code: row.code,
      name: row.name,
      type: row.type,
      role: row.role,
      parent_code: row.parent_code,
      debit_minor: debit,
      credit_minor: credit,
      normal_balance: normal,
      balance_minor: normal === 'debit' ? debit - credit : credit - debit,
      movement_minor: debit - credit,
    };
  });
};

const sum = (rows, field = 'balance_minor') => rows.reduce((t, row) => t + row[field], 0);
const withMovement = (rows) => rows.filter((row) => row.debit_minor || row.credit_minor);

/**
 * ACC-5.2 — profit and loss, with comparatives.
 *
 * ── The discount line is not netted off ─────────────────────────────────────
 *
 * Revenue is shown at the full price with discounts given as their own
 * negative line beneath it, because that is how it was posted and because a
 * company that discounted a quarter of its book should be able to see that it
 * did. Netting would show lower revenue and no reason for it.
 */
const profitAndLoss = async (sequelize, {
  companyId = null, from = null, to = null,
  compareFrom = null, compareTo = null,
  propertyId = null, branchId = null,
} = {}) => {
  const rows = await balances(sequelize, {
    companyId, from, to, propertyId, branchId,
  });

  const compare = compareFrom || compareTo
    ? await balances(sequelize, {
      companyId, from: compareFrom, to: compareTo, propertyId, branchId,
    })
    : null;
  const previous = new Map((compare || []).map((row) => [row.account_id, row.balance_minor]));

  const lineOf = (row) => ({
    ...row,
    previous_minor: compare ? (previous.get(row.account_id) || 0) : null,
  });

  const income = withMovement(rows.filter((row) => row.type === TYPE.INCOME)).map(lineOf);
  const expense = withMovement(rows.filter((row) => row.type === TYPE.EXPENSE)).map(lineOf);

  /*
   * Cost of sales is separated from the rest so a gross margin exists.
   *
   * By the 5000–5099 range and the cost-of-sales role: for a developer the
   * difference between what a unit sold for and what it cost to build is the
   * number the whole ledger was built to produce, and burying it in "expenses"
   * would leave it uncomputable.
   */
  const isCostOfSales = (row) => row.role === ROLE.COST_OF_SALES
    || row.role === ROLE.INVENTORY_WRITE_DOWN
    || /^50/.test(String(row.code));

  const costOfSales = expense.filter(isCostOfSales);
  const overheads = expense.filter((row) => !isCostOfSales(row));

  const revenueTotal = sum(income);
  const costTotal = sum(costOfSales);
  const overheadTotal = sum(overheads);

  const totalOf = (list, field) => list.reduce((t, row) => t + (row[field] || 0), 0);

  return {
    from,
    to,
    compare_from: compareFrom,
    compare_to: compareTo,
    property_id: propertyId,
    branch_id: branchId,
    income,
    cost_of_sales: costOfSales,
    overheads,
    revenue_minor: revenueTotal,
    cost_of_sales_minor: costTotal,
    gross_profit_minor: revenueTotal - costTotal,
    overheads_minor: overheadTotal,
    net_profit_minor: revenueTotal - costTotal - overheadTotal,
    previous: compare
      ? {
        revenue_minor: totalOf(income, 'previous_minor'),
        cost_of_sales_minor: totalOf(costOfSales, 'previous_minor'),
        overheads_minor: totalOf(overheads, 'previous_minor'),
        net_profit_minor: totalOf(income, 'previous_minor')
          - totalOf(costOfSales, 'previous_minor')
          - totalOf(overheads, 'previous_minor'),
      }
      : null,
  };
};

/**
 * ACC-5.3 — balance sheet, with retained earnings computed.
 *
 * ── Why computed and not stored ─────────────────────────────────────────────
 *
 * A stored retained earnings figure is a second copy of a number the journal
 * already contains, and the day it disagrees with the profit and loss nobody
 * can say which is right. Computed, the balance sheet cannot contradict the
 * statement above it.
 *
 * The arithmetic survives a year-end close (ACC-7.4) without special-casing
 * it. Closing posts a journal debiting income and crediting retained earnings,
 * which zeroes the income and expense accounts for the closed period — so
 * summing income less expense over ALL TIME gives exactly the part that has
 * not been closed, and the retained earnings account holds the part that has.
 * Adding the two is right before any close, after one, and between two.
 */
const balanceSheet = async (sequelize, { companyId = null, asAt = null } = {}) => {
  const rows = await balances(sequelize, { companyId, asAt });

  const assets = withMovement(rows.filter((row) => row.type === TYPE.ASSET));
  const liabilities = withMovement(rows.filter((row) => row.type === TYPE.LIABILITY));
  const equityAccounts = withMovement(rows.filter((row) => row.type === TYPE.EQUITY));

  const income = rows.filter((row) => row.type === TYPE.INCOME);
  const expense = rows.filter((row) => row.type === TYPE.EXPENSE);
  const earnedThisPeriod = sum(income) - sum(expense);

  const assetTotal = sum(assets);
  const liabilityTotal = sum(liabilities);
  const equityTotal = sum(equityAccounts) + earnedThisPeriod;

  return {
    as_at: asAt,
    assets,
    liabilities,
    equity: equityAccounts,
    /*
     * Shown as its own line rather than folded into the equity accounts,
     * because it is the one figure on this statement that is not an account
     * balance and a reader is entitled to know which.
     */
    earnings_not_yet_closed_minor: earnedThisPeriod,
    assets_minor: assetTotal,
    liabilities_minor: liabilityTotal,
    equity_minor: equityTotal,
    difference_minor: assetTotal - (liabilityTotal + equityTotal),
    balanced: assetTotal === liabilityTotal + equityTotal,
  };
};

/**
 * ACC-5.4 — cash flow, indirect.
 *
 * ── The reconciliation is the statement ─────────────────────────────────────
 *
 * Start from profit, add back what did not move cash, add the movement on
 * every other balance-sheet account, and what is left must equal the movement
 * in the bank. If it does not, the classification is incomplete — and saying
 * so is far more useful than presenting three tidy sections that quietly omit
 * something.
 *
 * `reconciles` is on the payload for the same reason the trial balance carries
 * `balanced`: a reader must not have to compare two totals themselves to find
 * out whether what they are reading can be relied on.
 */
const cashFlow = async (sequelize, { companyId = null, from = null, to = null } = {}) => {
  const movements = await balances(sequelize, { companyId, from, to });

  const income = movements.filter((row) => row.type === TYPE.INCOME);
  const expense = movements.filter((row) => row.type === TYPE.EXPENSE);
  const profit = sum(income) - sum(expense);

  const sheet = movements.filter(
    (row) => [TYPE.ASSET, TYPE.LIABILITY, TYPE.EQUITY].includes(row.type),
  );

  const cashAccounts = sheet.filter((row) => sectionOf(row) === SECTION.CASH);
  const cashMovement = sum(cashAccounts);

  /*
   * An asset going UP consumes cash; a liability going up provides it. The
   * signed balance already carries that, because the balance is taken on each
   * account's normal side — so an asset's increase is positive and has to be
   * subtracted, and a liability's increase is positive and added.
   */
  const contribution = (row) => (row.type === TYPE.ASSET ? -row.balance_minor : row.balance_minor);

  const section = (name) => {
    const lines = withMovement(sheet.filter((row) => sectionOf(row) === name));
    return {
      lines: lines.map((row) => ({ ...row, cash_effect_minor: contribution(row) })),
      total_minor: lines.reduce((t, row) => t + contribution(row), 0),
    };
  };

  const operating = section(SECTION.OPERATING);
  const investing = section(SECTION.INVESTING);
  const financing = section(SECTION.FINANCING);

  /*
   * Non-cash charges already sit inside the operating section, as the movement
   * on the account they were charged against — a write-down appears as work in
   * progress falling. Adding them back separately would count them twice. They
   * are named here so a reader can see the statement knows about them.
   */
  const nonCash = withMovement(expense.filter((row) => row.role === ROLE.INVENTORY_WRITE_DOWN));

  const netMovement = profit + operating.total_minor + investing.total_minor + financing.total_minor;

  return {
    from,
    to,
    profit_minor: profit,
    non_cash: nonCash,
    operating,
    investing,
    financing,
    operating_total_minor: profit + operating.total_minor,
    net_movement_minor: netMovement,
    cash_movement_minor: cashMovement,
    difference_minor: netMovement - cashMovement,
    reconciles: netMovement === cashMovement,
    cash_accounts: withMovement(cashAccounts),
  };
};

/**
 * ACC-5.9 — the same trading, on a cash basis.
 *
 * Revenue less the movement in receivables, expenses less the movement in
 * payables. A REPORT, not a posting mode: one posting engine on the accrual
 * basis, with cash derived from it, because accrual is the superset. Two
 * posting modes would be two sets of rules to keep in step and one of them
 * would be wrong within a quarter.
 */
const cashBasisProfitAndLoss = async (sequelize, {
  companyId = null, from = null, to = null,
} = {}) => {
  const accrual = await profitAndLoss(sequelize, { companyId, from, to });
  const movements = await balances(sequelize, { companyId, from, to });

  const movementOn = (role) => movements.find((row) => row.role === role)?.balance_minor || 0;

  const receivables = movementOn(ROLE.ACCOUNTS_RECEIVABLE);
  const payables = movementOn(ROLE.ACCOUNTS_PAYABLE);

  return {
    from,
    to,
    accrual_revenue_minor: accrual.revenue_minor,
    receivables_movement_minor: receivables,
    cash_revenue_minor: accrual.revenue_minor - receivables,
    accrual_costs_minor: accrual.cost_of_sales_minor + accrual.overheads_minor,
    payables_movement_minor: payables,
    cash_costs_minor: accrual.cost_of_sales_minor + accrual.overheads_minor - payables,
    cash_profit_minor: (accrual.revenue_minor - receivables)
      - (accrual.cost_of_sales_minor + accrual.overheads_minor - payables),
    accrual_profit_minor: accrual.net_profit_minor,
  };
};

/** The ageing buckets a company has not configured. */
const DEFAULT_BUCKETS = [30, 60, 90];

/**
 * ACC-5.5 — aged receivables, at a chosen date.
 *
 * ── Aged from the invoice, not from the ledger ──────────────────────────────
 *
 * The AR control account knows a total; it does not know which invoice is
 * three months late, and ageing is entirely a question about individual
 * documents. So this reads the invoices — and the control account is checked
 * against the sum, because the two agreeing is the whole point of a subledger.
 */
const agedReceivables = async (sequelize, {
  companyId = null, asAt = null, buckets = DEFAULT_BUCKETS,
} = {}) => {
  const at = asAt || new Date().toISOString().slice(0, 10);

  const rows = await sequelize.query(
    `SELECT i.id, i.invoice_id AS reference, i.client_id, i.due_date, i.created_at,
            i.amount, i.status, u.name AS client_name,
            COALESCE((
              /*
               * 'completed' is what a settled payment is called here, not
               * 'approved' — the row is created BECAUSE the payment settled.
               * The first version of this filtered on 'approved', matched
               * nothing, and aged every paid invoice as outstanding.
               */
              SELECT SUM(p.amount) FROM invoice_payments p
               WHERE p.invoice_id = i.id AND p.status = 'completed'
                 AND p.created_at <= :at
            ), 0) AS paid
       FROM invoices i
       LEFT JOIN users u ON u.id = i.client_id
      WHERE i.company_id ${companyId ? '= :companyId' : 'IS NULL'}
        AND i.status NOT IN ('draft', 'cancelled')
        AND i.created_at <= :at
      ORDER BY i.due_date, i.id`,
    { replacements: { companyId, at: `${at} 23:59:59` }, type: QueryTypes.SELECT },
  );

  const edges = [...buckets].sort((a, b) => a - b);
  const labels = ['current', ...edges.map((d, i) => (
    i === 0 ? `days_1_${d}` : `days_${edges[i - 1] + 1}_${d}`
  )), `days_over_${edges[edges.length - 1]}`];

  const byClient = new Map();
  let total = 0;

  rows.forEach((invoice) => {
    const outstanding = Math.round((Number(invoice.amount) - Number(invoice.paid)) * 100);
    if (outstanding <= 0) return;

    const due = invoice.due_date ? new Date(invoice.due_date) : new Date(invoice.created_at);
    const days = Math.floor((new Date(at) - due) / 86400000);
    let label = labels[0];
    if (days > 0) {
      label = labels[labels.length - 1];
      for (let i = 0; i < edges.length; i += 1) {
        if (days <= edges[i]) { label = labels[i + 1]; break; }
      }
    }

    const key = Number(invoice.client_id);
    if (!byClient.has(key)) {
      byClient.set(key, {
        client_id: key,
        client_name: invoice.client_name || `#${key}`,
        total_minor: 0,
        invoices: [],
        ...Object.fromEntries(labels.map((l) => [l, 0])),
      });
    }
    const client = byClient.get(key);
    client[label] += outstanding;
    client.total_minor += outstanding;
    client.invoices.push({
      id: invoice.id,
      reference: invoice.reference,
      due_date: invoice.due_date,
      outstanding_minor: outstanding,
      days_overdue: Math.max(days, 0),
      bucket: label,
    });
    total += outstanding;
  });

  /*
   * The control account, read independently.
   *
   * If it disagrees with the sum of the open invoices, the subledger and the
   * ledger have come apart — which is precisely what ACC-9.4's open-item
   * import exists to prevent and what period close refuses on. Reported rather
   * than reconciled away.
   */
  const [control] = await sequelize.query(
    `SELECT COALESCE(SUM(l.debit_minor), 0) - COALESCE(SUM(l.credit_minor), 0) AS balance
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN ledger_accounts a ON a.id = l.account_id
      WHERE a.role = :role
        AND e.entry_date <= :at
        AND e.company_id ${companyId ? '= :companyId' : 'IS NULL'}`,
    {
      replacements: { role: ROLE.ACCOUNTS_RECEIVABLE, companyId, at },
      type: QueryTypes.SELECT,
    },
  );
  const controlBalance = Number(control?.balance || 0);

  return {
    as_at: at,
    buckets: labels,
    clients: [...byClient.values()].sort((a, b) => b.total_minor - a.total_minor),
    total_minor: total,
    control_balance_minor: controlBalance,
    difference_minor: controlBalance - total,
    reconciles: controlBalance === total,
  };
};

/**
 * ACC-5.6 — the VAT return.
 *
 * Output tax from sales, input tax from bills, and the net. Both read from the
 * ledger rather than from the documents, because the tax point is an
 * ACCOUNTING date: an invoice raised in March and entered in April belongs to
 * March's return, and only the journal knows that.
 */
const vatReturn = async (sequelize, { companyId = null, from = null, to = null } = {}) => {
  const replacements = { companyId: companyId ?? null, output: ROLE.VAT_OUTPUT, input: ROLE.VAT_INPUT };
  const window = bounds(replacements, { from, to });

  const lines = await sequelize.query(
    `SELECT a.role AS role, e.entry_date, e.source, e.source_id, e.reference, e.memo,
            l.debit_minor, l.credit_minor
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN ledger_accounts a ON a.id = l.account_id
      WHERE a.role IN (:output, :input)
        AND e.company_id ${companyId ? '= :companyId' : 'IS NULL'}
        ${window}
      ORDER BY e.entry_date, e.id`,
    { replacements, type: QueryTypes.SELECT },
  );

  const outputLines = lines.filter((row) => row.role === ROLE.VAT_OUTPUT);
  const inputLines = lines.filter((row) => row.role === ROLE.VAT_INPUT);

  const outputTax = outputLines.reduce(
    (t, row) => t + (Number(row.credit_minor) - Number(row.debit_minor)), 0,
  );
  const inputTax = inputLines.reduce(
    (t, row) => t + (Number(row.debit_minor) - Number(row.credit_minor)), 0,
  );

  return {
    from,
    to,
    output_tax_minor: outputTax,
    input_tax_minor: inputTax,
    net_payable_minor: outputTax - inputTax,
    output_lines: outputLines,
    input_lines: inputLines,
  };
};

/**
 * ACC-5.7 — what has been withheld and still has to be remitted.
 *
 * Already half-built before this: commission deductions and supplier bills
 * both raise a withholding liability, and nothing reported it. The schedule
 * below is what a company files against — and, more immediately, what tells
 * them the money in the account is not theirs.
 */
const withholdingSchedule = async (sequelize, { companyId = null, from = null, to = null } = {}) => {
  const replacements = { companyId: companyId ?? null, role: ROLE.WITHHOLDING_PAYABLE };
  const window = bounds(replacements, { from, to });

  const lines = await sequelize.query(
    `SELECT e.entry_date, e.source, e.source_id, e.reference, e.memo,
            l.debit_minor, l.credit_minor, l.party_id, l.party_type
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN ledger_accounts a ON a.id = l.account_id
      WHERE a.role = :role
        AND e.company_id ${companyId ? '= :companyId' : 'IS NULL'}
        ${window}
      ORDER BY e.entry_date, e.id`,
    { replacements, type: QueryTypes.SELECT },
  );

  const withheld = lines.reduce((t, row) => t + Number(row.credit_minor), 0);
  const remitted = lines.reduce((t, row) => t + Number(row.debit_minor), 0);

  return {
    from,
    to,
    withheld_minor: withheld,
    remitted_minor: remitted,
    outstanding_minor: withheld - remitted,
    lines,
  };
};

module.exports = {
  SECTION,
  sectionOf,
  balances,
  profitAndLoss,
  balanceSheet,
  cashFlow,
  cashBasisProfitAndLoss,
  agedReceivables,
  vatReturn,
  withholdingSchedule,
  DEFAULT_BUCKETS,
};

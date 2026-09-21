const { QueryTypes } = require('sequelize');
const { ROLE, TYPE } = require('./chart');
const { agedReceivables } = require('./statements');

/**
 * What has to be true before a month can be closed (ACC-7.2).
 *
 * ── A checklist that cannot be overridden is the point ──────────────────────
 *
 * Closing says "these figures are final". If it can be done over a failing
 * check then it says nothing, and the statements behind it are provisional
 * while claiming not to be. So a failure REFUSES, and the only way past it is
 * to fix the thing — which is the correct amount of friction for an assertion
 * this strong.
 *
 * ── Warnings exist, and are different ───────────────────────────────────────
 *
 * Some findings are not errors: a bank account nobody has reconciled yet
 * because bank reconciliation was switched on last week, a period with no
 * transactions at all. Those are reported and do not block, because a rule
 * that refuses on something the company has not adopted teaches people to
 * distrust the checklist rather than to act on it.
 *
 * ── Every check is a reconciliation, not an opinion ─────────────────────────
 *
 * Each one compares two figures that must agree and reports the difference.
 * "AR looks wrong" is not actionable; "the control account says ₦4.2m and the
 * open invoices say ₦3.9m, a difference of ₦300,000" is.
 */

const OK = 'ok';
const FAILED = 'failed';
const WARNING = 'warning';

/** Every journal entry in the window whose own lines do not balance. */
const unbalancedEntries = async (sequelize, { companyId, from, to }) => {
  const rows = await sequelize.query(
    `SELECT e.id, e.reference, e.entry_date,
            COALESCE(SUM(l.debit_minor), 0) AS dr,
            COALESCE(SUM(l.credit_minor), 0) AS cr
       FROM journal_entries e
       JOIN journal_lines l ON l.entry_id = e.id
      WHERE e.entry_date >= :from AND e.entry_date <= :to
        AND e.company_id ${companyId ? '= :companyId' : 'IS NULL'}
      GROUP BY e.id, e.reference, e.entry_date
     HAVING COALESCE(SUM(l.debit_minor), 0) <> COALESCE(SUM(l.credit_minor), 0)`,
    { replacements: { companyId, from, to }, type: QueryTypes.SELECT },
  );

  return {
    key: 'entries_balance',
    label: 'Every journal in the period balances',
    status: rows.length ? FAILED : OK,
    detail: rows.length
      ? `${rows.length} entry(ies) do not balance: ${rows.slice(0, 5).map((r) => r.reference).join(', ')}`
      : 'All of them.',
    /*
     * This one should be impossible — post() refuses an unbalanced entry at
     * the door. It is checked anyway because "impossible" means "impossible
     * through the door", and a database somebody has been in with a client is
     * exactly what a close is supposed to catch.
     */
    rows,
  };
};

/** Anything sitting in suspense, which means the chart could not answer. */
const suspenseIsEmpty = async (sequelize, { companyId, to }) => {
  const [row] = await sequelize.query(
    `SELECT COALESCE(SUM(l.debit_minor), 0) - COALESCE(SUM(l.credit_minor), 0) AS balance
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN ledger_accounts a ON a.id = l.account_id
      WHERE a.role = :role
        AND e.entry_date <= :to
        AND e.company_id ${companyId ? '= :companyId' : 'IS NULL'}`,
    { replacements: { role: ROLE.SUSPENSE, companyId, to }, type: QueryTypes.SELECT },
  );
  const balance = Number(row?.balance || 0);
  return {
    key: 'suspense_empty',
    label: 'Nothing is left in suspense',
    status: balance === 0 ? OK : FAILED,
    detail: balance === 0
      ? 'Empty.'
      : `${balance} minor units are in suspense — a posting rule could not find its account. `
        + 'Correct the chart and reverse the entries that fell back.',
    amount_minor: balance,
  };
};

/** The receivables control account against the invoices behind it. */
const receivablesReconcile = async (sequelize, { companyId, to }) => {
  const aged = await agedReceivables(sequelize, { companyId, asAt: to });
  return {
    key: 'receivables_reconcile',
    label: 'Receivables agree with the invoices behind them',
    status: aged.reconciles ? OK : FAILED,
    detail: aged.reconciles
      ? 'They agree.'
      : `The control account says ${aged.control_balance_minor} and the open invoices say `
        + `${aged.total_minor} — a difference of ${aged.difference_minor} minor units.`,
    amount_minor: aged.difference_minor,
  };
};

/**
 * The bank accounts, against the last reconciliation of each (ACC-6.4).
 *
 * A WARNING rather than a failure where no reconciliation exists at all,
 * because a company that has not adopted bank reconciliation should still be
 * able to close a month. Once one exists and is stale, it fails: the whole
 * value of a reconciliation is that somebody looked, and a close that ignores
 * the last time anybody looked is not a control.
 */
const banksReconciled = async (sequelize, { companyId, to }) => {
  let reconciliations = [];
  try {
    reconciliations = await sequelize.query(
      `SELECT account_id, MAX(statement_date) AS last_reconciled
         FROM bank_reconciliations
        WHERE status = 'locked'
          AND company_id ${companyId ? '= :companyId' : 'IS NULL'}
        GROUP BY account_id`,
      { replacements: { companyId }, type: QueryTypes.SELECT },
    );
  } catch {
    // ACC-6 has not landed on this database yet.
    return {
      key: 'banks_reconciled',
      label: 'The bank accounts are reconciled',
      status: WARNING,
      detail: 'Bank reconciliation is not in use, so nothing was checked.',
    };
  }

  if (!reconciliations.length) {
    return {
      key: 'banks_reconciled',
      label: 'The bank accounts are reconciled',
      status: WARNING,
      detail: 'No bank account has ever been reconciled, so nothing was checked.',
    };
  }

  const stale = reconciliations.filter((row) => String(row.last_reconciled) < String(to));
  return {
    key: 'banks_reconciled',
    label: 'The bank accounts are reconciled to the end of the period',
    status: stale.length ? FAILED : OK,
    detail: stale.length
      ? `${stale.length} account(s) were last reconciled before ${to}.`
      : 'All reconciled.',
    rows: stale,
  };
};

/**
 * Work in progress, against what the projects say they hold (ACC-10.6).
 *
 * The same shape as the receivables check and for the same reason: a control
 * account whose subledger disagrees is a balance sheet nobody can defend. Cost
 * sitting in WIP against no project is the specific failure — it belongs to no
 * unit, so nothing will ever release it.
 */
const developmentWipReconciles = async (sequelize, { companyId, to }) => {
  const [total] = await sequelize.query(
    `SELECT COALESCE(SUM(l.debit_minor), 0) - COALESCE(SUM(l.credit_minor), 0) AS balance,
            COALESCE(SUM(CASE WHEN l.property_id IS NULL
                              THEN l.debit_minor - l.credit_minor ELSE 0 END), 0) AS unassigned
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN ledger_accounts a ON a.id = l.account_id
      WHERE a.role = :role
        AND e.entry_date <= :to
        AND e.company_id ${companyId ? '= :companyId' : 'IS NULL'}`,
    { replacements: { role: ROLE.DEVELOPMENT_WIP, companyId, to }, type: QueryTypes.SELECT },
  );

  const unassigned = Number(total?.unassigned || 0);
  return {
    key: 'wip_assigned',
    label: 'Every development cost belongs to a project',
    status: unassigned === 0 ? OK : FAILED,
    detail: unassigned === 0
      ? 'All of it.'
      : `${unassigned} minor units are in work in progress against no project, `
        + 'so nothing will ever release them to cost of sales.',
    amount_minor: unassigned,
  };
};

/** Any earlier period still open, which would make this close meaningless. */
const earlierPeriodsClosed = async (sequelize, { companyId, from }) => {
  let rows = [];
  try {
    rows = await sequelize.query(
      `SELECT name, ends_on FROM accounting_periods
        WHERE status = 'open' AND ends_on < :from
          AND company_id ${companyId ? '= :companyId' : 'IS NULL'}
        ORDER BY ends_on`,
      { replacements: { companyId, from }, type: QueryTypes.SELECT },
    );
  } catch {
    rows = [];
  }
  return {
    key: 'earlier_closed',
    label: 'Every earlier period is already closed',
    status: rows.length ? FAILED : OK,
    detail: rows.length
      ? `${rows.map((r) => r.name).join(', ')} ${rows.length === 1 ? 'is' : 'are'} still open. `
        + 'Closing out of order leaves a month that can still change behind one that cannot.'
      : 'All of them.',
    rows,
  };
};

/**
 * Run the whole checklist.
 *
 * Returns every check, whether it passed, and one verdict. Nothing is
 * short-circuited: somebody about to close a month wants the full list of what
 * is wrong, not the first thing that is.
 */
const runChecklist = async (sequelize, { companyId = null, from, to } = {}) => {
  const checks = await Promise.all([
    earlierPeriodsClosed(sequelize, { companyId, from }),
    unbalancedEntries(sequelize, { companyId, from, to }),
    suspenseIsEmpty(sequelize, { companyId, to }),
    receivablesReconcile(sequelize, { companyId, to }),
    developmentWipReconciles(sequelize, { companyId, to }),
    banksReconciled(sequelize, { companyId, to }),
  ]);

  const failures = checks.filter((check) => check.status === FAILED);
  const warnings = checks.filter((check) => check.status === WARNING);

  return {
    from,
    to,
    checks,
    failed: failures.length,
    warned: warnings.length,
    can_close: failures.length === 0,
  };
};

/**
 * ACC-7.4 — the year-end journal.
 *
 * ── A dated journal like any other ──────────────────────────────────────────
 *
 * Closing a year moves the profit and loss into retained earnings, and it does
 * so by POSTING — not by a flag, not by a rule the statements apply when they
 * read. Every account this touches can be traced to an entry with a date, a
 * reference and an author, which is the property that makes the whole ledger
 * worth having.
 *
 * ── The balance sheet does not change ───────────────────────────────────────
 *
 * Before the close, retained earnings is computed as the account balance plus
 * income less expense; after it, the income and expense accounts are zero and
 * the account balance has absorbed them. The sum is identical either way,
 * which is exactly what makes the close safe to run and safe not to.
 */
const yearEndLines = (accounts) => {
  const income = accounts.filter((row) => row.type === TYPE.INCOME);
  const expense = accounts.filter((row) => row.type === TYPE.EXPENSE);

  const lines = [];
  /*
   * Each account is closed on its own line rather than as two summary lines,
   * so the journal says what it was made of. A single "close income" line for
   * a company with fourteen revenue accounts is a number nobody can take
   * apart afterwards.
   */
  income.forEach((row) => {
    if (!row.balance_minor) return;
    lines.push(row.balance_minor > 0
      ? { role: null, account_id: row.account_id, debit_minor: row.balance_minor, credit_minor: 0 }
      : { role: null, account_id: row.account_id, debit_minor: 0, credit_minor: -row.balance_minor });
  });
  expense.forEach((row) => {
    if (!row.balance_minor) return;
    lines.push(row.balance_minor > 0
      ? { role: null, account_id: row.account_id, debit_minor: 0, credit_minor: row.balance_minor }
      : { role: null, account_id: row.account_id, debit_minor: -row.balance_minor, credit_minor: 0 });
  });

  const profit = income.reduce((t, row) => t + row.balance_minor, 0)
    - expense.reduce((t, row) => t + row.balance_minor, 0);

  // The residual leg, so the entry balances by construction.
  if (profit > 0) {
    lines.push({ role: ROLE.RETAINED_EARNINGS, debit_minor: 0, credit_minor: profit });
  } else if (profit < 0) {
    lines.push({ role: ROLE.RETAINED_EARNINGS, debit_minor: -profit, credit_minor: 0 });
  }

  return { lines, profit_minor: profit };
};

module.exports = {
  OK,
  FAILED,
  WARNING,
  runChecklist,
  yearEndLines,
  unbalancedEntries,
  suspenseIsEmpty,
  receivablesReconcile,
  developmentWipReconciles,
  banksReconciled,
  earlierPeriodsClosed,
};

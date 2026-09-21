const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize } = require('../models');
const statements = require('../../../../shared/src/accounting/statements');
const { trialBalance } = require('../../../../shared/src/accounting/ledger');

/**
 * The statements a company files from (ACC-5).
 *
 * ── Thin on purpose ─────────────────────────────────────────────────────────
 *
 * Every handler here reads a date window, decides whose books, and calls one
 * function. The arithmetic lives in shared/src/accounting/statements.js, where
 * it can be run against a scratch database and checked line by line — which is
 * the only form in which an accountant can review it.
 *
 * ── The comparative period is offered, not demanded ─────────────────────────
 *
 * A profit and loss without last year beside it is half a statement, so where
 * the caller does not name a comparison one is derived: the same window, a
 * year earlier. Somebody who wants a different comparison passes it.
 */

const companyOf = (req) => (req.user?.isSuperiorAdmin
  ? (req.query.company_id ?? null)
  : (req.user?.company_id ?? null));

const today = () => new Date().toISOString().slice(0, 10);

/** The first and last day of the year a date falls in. */
const yearOf = (date) => {
  const year = new Date(date).getFullYear();
  return { from: `${year}-01-01`, to: `${year}-12-31` };
};

/** The same window, one year earlier. */
const previousYear = (from, to) => {
  const shift = (value) => {
    const d = new Date(value);
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  };
  return { from: shift(from), to: shift(to) };
};

const windowOf = (req) => {
  const to = req.query.to || today();
  const from = req.query.from || yearOf(to).from;
  return { from, to };
};

const profitAndLoss = asyncHandler(async (req, res) => {
  const { from, to } = windowOf(req);

  /*
   * No comparison at all is a deliberate choice somebody can make — `compare=none`
   * — rather than something they fall into by not passing dates.
   */
  const compare = req.query.compare === 'none'
    ? { from: null, to: null }
    : {
      from: req.query.compare_from || previousYear(from, to).from,
      to: req.query.compare_to || previousYear(from, to).to,
    };

  const data = await statements.profitAndLoss(sequelize, {
    companyId: companyOf(req),
    from,
    to,
    compareFrom: compare.from,
    compareTo: compare.to,
    propertyId: req.query.property_id || null,
    branchId: req.query.branch_id || null,
  });
  res.json({ data });
});

const balanceSheet = asyncHandler(async (req, res) => {
  const data = await statements.balanceSheet(sequelize, {
    companyId: companyOf(req),
    asAt: req.query.as_at || today(),
  });
  res.json({ data });
});

const cashFlow = asyncHandler(async (req, res) => {
  const { from, to } = windowOf(req);
  const data = await statements.cashFlow(sequelize, { companyId: companyOf(req), from, to });
  res.json({ data });
});

const cashBasis = asyncHandler(async (req, res) => {
  const { from, to } = windowOf(req);
  const data = await statements.cashBasisProfitAndLoss(sequelize, {
    companyId: companyOf(req), from, to,
  });
  res.json({ data });
});

const agedReceivables = asyncHandler(async (req, res) => {
  const buckets = String(req.query.buckets || '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);

  const data = await statements.agedReceivables(sequelize, {
    companyId: companyOf(req),
    asAt: req.query.as_at || today(),
    buckets: buckets.length ? buckets : undefined,
  });
  res.json({ data });
});

const vatReturn = asyncHandler(async (req, res) => {
  const { from, to } = windowOf(req);
  const data = await statements.vatReturn(sequelize, { companyId: companyOf(req), from, to });
  res.json({ data });
});

const withholdingSchedule = asyncHandler(async (req, res) => {
  const { from, to } = windowOf(req);
  const data = await statements.withholdingSchedule(sequelize, {
    companyId: companyOf(req), from, to,
  });
  res.json({ data });
});

/**
 * ACC-5.8 — the journal, as a CSV that goes back in where it came out.
 *
 * ── Why the export is a first-class feature ─────────────────────────────────
 *
 * It is the exit guarantee. A company is being asked to keep its statutory
 * books here, and the reasonable question — what happens if we leave — has to
 * have a plain answer. It is also the first thing an external auditor asks
 * for.
 *
 * The columns are exactly the ones the import reads (ACC-4.6), so a ledger
 * exported and re-imported reproduces itself. That round trip is worth more
 * than any number of format options: it is a property somebody can check.
 */
const exportJournal = asyncHandler(async (req, res) => {
  const { from, to } = windowOf(req);
  const companyId = companyOf(req);

  const rows = await sequelize.query(
    `SELECT e.entry_date, e.reference, e.source, e.source_id, e.memo,
            a.code AS account_code, a.name AS account_name,
            l.debit_minor, l.credit_minor, l.memo AS line_memo,
            l.property_id, l.branch_id
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN ledger_accounts a ON a.id = l.account_id
      WHERE e.company_id ${companyId ? '= :companyId' : 'IS NULL'}
        AND e.entry_date >= :from AND e.entry_date <= :to
      ORDER BY e.entry_date, e.id, l.position`,
    {
      replacements: { companyId, from, to },
      type: QueryTypes.SELECT,
    },
  );

  const escape = (value) => {
    const text = value == null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const major = (minor) => (Number(minor || 0) / 100).toFixed(2);

  const header = 'date,account,debit,credit,memo,reference,source,property_id,branch_id';
  const body = rows.map((row) => [
    row.entry_date,
    row.account_code,
    Number(row.debit_minor) ? major(row.debit_minor) : '',
    Number(row.credit_minor) ? major(row.credit_minor) : '',
    row.line_memo || row.memo || '',
    row.reference,
    `${row.source}${row.source_id ? ` ${row.source_id}` : ''}`,
    row.property_id || '',
    row.branch_id || '',
  ].map(escape).join(','));

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="journal-${from}-to-${to}.csv"`);
  res.send([header, ...body].join('\n'));
});

/**
 * Everything at once, for a date range.
 *
 * ── Why one endpoint rather than four calls ─────────────────────────────────
 *
 * The statements have to be consistent with each other to be worth anything,
 * and four separate requests can straddle a posting: a balance sheet fetched
 * a second after a profit and loss can include a journal the profit and loss
 * did not. One read answers all of them from the same moment.
 *
 * It is also what ACC-5.10's audit pack is built from.
 */
const statementPack = asyncHandler(async (req, res) => {
  const { from, to } = windowOf(req);
  const companyId = companyOf(req);

  /*
   * The dimension filter reaches the PROFIT AND LOSS only, which is what
   * ACC-5.2 asks for and all that is meaningful.
   *
   * A balance sheet per project would be a fiction: work in progress divides
   * by project, the bank account does not, and an "assets" total that included
   * one and not the other would balance against nothing. The cash flow has the
   * same problem for the same reason. The screen says which statements the
   * filter reached rather than leaving a reader to assume it reached all of
   * them.
   */
  const propertyId = req.query.property_id || null;
  const branchId = req.query.branch_id || null;

  const [pl, bs, cf, tb, vat, wht, aged] = await Promise.all([
    statements.profitAndLoss(sequelize, {
      companyId,
      from,
      to,
      propertyId,
      branchId,
      compareFrom: previousYear(from, to).from,
      compareTo: previousYear(from, to).to,
    }),
    statements.balanceSheet(sequelize, { companyId, asAt: to }),
    statements.cashFlow(sequelize, { companyId, from, to }),
    trialBalance(sequelize, { companyId, from, to }),
    statements.vatReturn(sequelize, { companyId, from, to }),
    statements.withholdingSchedule(sequelize, { companyId, from, to }),
    statements.agedReceivables(sequelize, { companyId, asAt: to }),
  ]);

  res.json({
    data: {
      from,
      to,
      property_id: propertyId,
      branch_id: branchId,
      profit_and_loss: pl,
      balance_sheet: bs,
      cash_flow: cf,
      trial_balance: tb,
      vat_return: vat,
      withholding: wht,
      aged_receivables: aged,
      /*
       * The three checks that decide whether any of the above can be relied
       * on, gathered where a reader sees them before the numbers rather than
       * after.
       */
      checks: {
        trial_balance_balanced: tb.balanced,
        balance_sheet_balanced: bs.balanced,
        cash_flow_reconciles: cf.reconciles,
        receivables_reconcile: aged.reconciles,
      },
    },
  });
});

module.exports = {
  profitAndLoss,
  balanceSheet,
  cashFlow,
  cashBasis,
  agedReceivables,
  vatReturn,
  withholdingSchedule,
  exportJournal,
  statementPack,
};

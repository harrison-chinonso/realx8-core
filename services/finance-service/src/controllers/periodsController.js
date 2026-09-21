const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize, AccountingPeriod } = require('../models');
const { buildCompanyScope } = require('../utils/crudFactory');
const { runChecklist, yearEndLines } = require('../../../../shared/src/accounting/periodClose');
const { balances } = require('../../../../shared/src/accounting/statements');
const { post } = require('../../../../shared/src/accounting/ledger');

/**
 * Closing the books (ACC-7).
 *
 * ── What closing actually asserts ───────────────────────────────────────────
 *
 * That the figures for a month are final. Everything else here follows from
 * taking that seriously: the checklist cannot be overridden, because a close
 * that can be forced asserts nothing; the posting door refuses a closed month
 * rather than silently redating; and reopening is allowed but permissioned and
 * recorded, because a close nobody dares undo is a close nobody dares make.
 *
 * ── Periods are created, not implied ────────────────────────────────────────
 *
 * A month exists here because somebody made it. Deriving them from the
 * calendar would be tidier and wrong in the one case that matters — a
 * financial year ending in June, a first period that runs fourteen months from
 * incorporation. Both are ordinary, and neither survives an assumption.
 */

const scope = (req) => buildCompanyScope(req);

const companyOf = (req) => (req.user?.isSuperiorAdmin
  ? (req.body?.company_id ?? req.query?.company_id ?? null)
  : (req.user?.company_id ?? null));

const listPeriods = asyncHandler(async (req, res) => {
  const rows = await AccountingPeriod.findAll({
    where: scope(req),
    order: [['starts_on', 'DESC']],
  });
  res.json({ data: rows });
});

/**
 * Create the next twelve months, or one named period.
 *
 * Generating a year at a time is the common case and saves twelve identical
 * acts of typing; a company whose year is not twelve calendar months names its
 * own periods instead.
 */
const createPeriods = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);

  if (req.body.name && req.body.starts_on && req.body.ends_on) {
    if (String(req.body.ends_on) < String(req.body.starts_on)) {
      return res.status(400).json({ message: 'A period cannot end before it starts.' });
    }
    const period = await AccountingPeriod.create({
      company_id: companyId,
      name: String(req.body.name).trim(),
      starts_on: req.body.starts_on,
      ends_on: req.body.ends_on,
      is_year_end: Boolean(req.body.is_year_end),
      status: 'open',
      created_by: req.user?.id ?? null,
    });
    return res.status(201).json({ data: period });
  }

  const startYear = Number(req.body.year);
  if (!startYear) {
    return res.status(400).json({ message: 'Give a year to generate, or a name with its own dates.' });
  }
  /*
   * The month the financial year ENDS in, 1–12. December unless told
   * otherwise, and asked for rather than assumed because a June year end is
   * ordinary and generating twelve wrong months is worse than asking.
   */
  const yearEndMonth = Number(req.body.year_end_month) || 12;

  const existing = await AccountingPeriod.findAll({
    where: { ...scope(req) },
    attributes: ['starts_on'],
  });
  const have = new Set(existing.map((row) => String(row.starts_on)));

  const made = [];
  for (let i = 0; i < 12; i += 1) {
    const start = new Date(Date.UTC(startYear, i, 1));
    const end = new Date(Date.UTC(startYear, i + 1, 0));
    const startsOn = start.toISOString().slice(0, 10);
    if (have.has(startsOn)) continue;
    made.push({
      company_id: companyId,
      name: start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      starts_on: startsOn,
      ends_on: end.toISOString().slice(0, 10),
      is_year_end: i + 1 === yearEndMonth,
      status: 'open',
      created_by: req.user?.id ?? null,
    });
  }

  if (!made.length) {
    return res.status(409).json({ message: `Every month of ${startYear} already exists.` });
  }
  const periods = await AccountingPeriod.bulkCreate(made);
  return res.status(201).json({
    data: periods,
    message: `${periods.length} period(s) created.`,
  });
});

/** Run the checklist without closing anything. */
const checkPeriod = asyncHandler(async (req, res) => {
  const period = await AccountingPeriod.findOne({ where: { id: req.params.id, ...scope(req) } });
  if (!period) return res.status(404).json({ message: 'Period not found' });

  const result = await runChecklist(sequelize, {
    companyId: period.company_id,
    from: period.starts_on,
    to: period.ends_on,
  });
  res.json({ data: { period, ...result } });
});

/**
 * ACC-7.2 — close it.
 *
 * The checklist runs again here rather than trusting whatever a screen last
 * showed: the ledger may have moved between somebody reading a green
 * checklist and pressing the button, and the check that matters is the one
 * made at the moment of the assertion.
 */
const closePeriod = asyncHandler(async (req, res) => {
  const period = await AccountingPeriod.findOne({ where: { id: req.params.id, ...scope(req) } });
  if (!period) return res.status(404).json({ message: 'Period not found' });
  if (period.status === 'closed') {
    return res.status(409).json({ message: `${period.name} is already closed.` });
  }

  const result = await runChecklist(sequelize, {
    companyId: period.company_id,
    from: period.starts_on,
    to: period.ends_on,
  });

  if (!result.can_close) {
    return res.status(422).json({
      message: `${period.name} cannot be closed yet — ${result.failed} check(s) failed.`,
      data: { period, ...result },
    });
  }

  /*
   * The year-end journal is posted BEFORE the period closes, because it is
   * dated inside the period it closes and the posting door would refuse it a
   * moment later. That ordering is the whole reason this is one endpoint
   * rather than two.
   */
  let yearEnd = null;
  if (period.is_year_end) {
    yearEnd = await postYearEnd(req, period);
    if (yearEnd?.error) {
      return res.status(422).json({ message: yearEnd.error, data: { period, ...result } });
    }
  }

  await period.update({
    status: 'closed',
    closed_by: req.user?.id ?? null,
    closed_at: new Date(),
    checklist: result.checks,
  });

  res.json({
    data: { period, ...result },
    message: yearEnd?.reference
      ? `${period.name} closed. ${yearEnd.reference} moved the year's result to retained earnings.`
      : `${period.name} closed. Nothing can be posted into it until it is reopened.`,
  });
});

/**
 * ACC-7.4 — move the year's result to retained earnings.
 *
 * Posted as an ordinary dated journal, so every account it touches can be
 * traced to an entry with a reference and an author. The balance sheet does
 * not change: retained earnings is computed as the account balance plus income
 * less expense, and this entry simply moves the second part into the first.
 */
const postYearEnd = async (req, period) => {
  const companyId = period.company_id;

  /*
   * From the start of the ledger to the end of this period, not just this
   * period, so the entry closes everything the previous year end left — and
   * on a first year end there is no previous one to have left anything.
   *
   * A prior year end already zeroed its own accounts, so those contribute
   * nothing here. Summing from the beginning is therefore both correct and
   * self-correcting.
   */
  const accounts = await balances(sequelize, { companyId, asAt: period.ends_on });
  const { lines, profit_minor: profit } = yearEndLines(accounts);

  if (!lines.length) {
    return { reference: null, profit_minor: 0, skipped: 'nothing_to_close' };
  }
  if (lines.length < 2) {
    return { error: 'The year-end entry would have a single line. Nothing was closed.' };
  }

  try {
    const entry = await post(sequelize, {
      companyId,
      entryDate: period.ends_on,
      source: 'year_end',
      sourceId: String(period.id),
      memo: `Year end — ${period.name}`,
      createdBy: req.user?.id ?? null,
      lines,
    });
    return { reference: entry.reference, profit_minor: profit };
  } catch (error) {
    return { error: `The year-end entry could not be posted: ${error.message}` };
  }
};

/**
 * ACC-7.3 — reopen.
 *
 * Permissioned separately from closing and refused without a reason. The
 * reason is not bureaucracy: a reopened month means figures somebody may have
 * already reported are going to change, and the only defence against that is a
 * record of who decided it and why.
 */
const reopenPeriod = asyncHandler(async (req, res) => {
  const period = await AccountingPeriod.findOne({ where: { id: req.params.id, ...scope(req) } });
  if (!period) return res.status(404).json({ message: 'Period not found' });
  if (period.status !== 'closed') {
    return res.status(409).json({ message: `${period.name} is already open.` });
  }

  const reason = String(req.body.reason || '').trim();
  if (!reason) {
    return res.status(400).json({
      message: 'Say why. Figures somebody may already have reported are about to change.',
    });
  }

  /*
   * A later closed period would be left resting on a month that can move
   * again, which is the state this whole epic exists to prevent. Reopen from
   * the most recent backwards.
   */
  const [later] = await sequelize.query(
    `SELECT name FROM accounting_periods
      WHERE status = 'closed' AND starts_on > :start
        AND company_id ${period.company_id ? '= :companyId' : 'IS NULL'}
      ORDER BY starts_on LIMIT 1`,
    {
      replacements: { start: period.starts_on, companyId: period.company_id },
      type: QueryTypes.SELECT,
    },
  );
  if (later) {
    return res.status(409).json({
      message: `${later.name} is closed and sits after this one. Reopen that first — `
        + 'otherwise a closed month would be resting on one that can still change.',
    });
  }

  await period.update({
    status: 'open',
    reopened_by: req.user?.id ?? null,
    reopened_at: new Date(),
    reopen_reason: reason,
  });

  res.json({
    data: period,
    message: `${period.name} is open again. Anything posted into it changes figures that were final.`,
  });
});

/**
 * ACC-5.10 — the audit pack for a closed period.
 *
 * ── Why this is a requirement rather than a nicety ──────────────────────────
 *
 * Book of record. A company keeping its statutory books here has to be able to
 * hand an auditor one thing: the statements, the journals behind them, the
 * reconciliations that were run, and a fixed as-at date. Assembling that from
 * six screens is how figures get transcribed wrongly.
 *
 * ── Only for a closed period, and that is the point ─────────────────────────
 *
 * A pack for an open month would be a snapshot of something still moving, and
 * the auditor would have no way to tell. The checklist stored on the period is
 * included as it was recorded at the close rather than re-run now — re-running
 * it would answer about today's ledger, which is not what was signed off.
 */
const auditPack = asyncHandler(async (req, res) => {
  const period = await AccountingPeriod.findOne({ where: { id: req.params.id, ...scope(req) } });
  if (!period) return res.status(404).json({ message: 'Period not found' });
  if (period.status !== 'closed') {
    return res.status(409).json({
      message: `${period.name} is still open, so a pack for it would be a snapshot of figures that can still move.`,
    });
  }

  // eslint-disable-next-line global-require
  const statements = require('../../../../shared/src/accounting/statements');
  // eslint-disable-next-line global-require
  const { trialBalance } = require('../../../../shared/src/accounting/ledger');

  const companyId = period.company_id;
  const { starts_on: from, ends_on: to } = period;

  const [pl, bs, cf, tb, vat, wht, aged, entries] = await Promise.all([
    statements.profitAndLoss(sequelize, { companyId, from, to }),
    statements.balanceSheet(sequelize, { companyId, asAt: to }),
    statements.cashFlow(sequelize, { companyId, from, to }),
    trialBalance(sequelize, { companyId, from, to }),
    statements.vatReturn(sequelize, { companyId, from, to }),
    statements.withholdingSchedule(sequelize, { companyId, from, to }),
    statements.agedReceivables(sequelize, { companyId, asAt: to }),
    sequelize.query(
      `SELECT e.id, e.reference, e.entry_date, e.source, e.source_id, e.memo,
              e.debit_minor, e.credit_minor, e.created_by, e.created_at
         FROM journal_entries e
        WHERE e.entry_date >= :from AND e.entry_date <= :to
          AND e.company_id ${companyId ? '= :companyId' : 'IS NULL'}
        ORDER BY e.entry_date, e.id`,
      { replacements: { companyId, from, to }, type: QueryTypes.SELECT },
    ),
  ]);

  res.json({
    data: {
      period,
      closed_at: period.closed_at,
      closed_by: period.closed_by,
      /* As recorded at the close, not re-run now. */
      checklist_at_close: period.checklist,
      profit_and_loss: pl,
      balance_sheet: bs,
      cash_flow: cf,
      trial_balance: tb,
      vat_return: vat,
      withholding: wht,
      aged_receivables: aged,
      journals: entries,
    },
  });
});

module.exports = {
  listPeriods,
  createPeriods,
  checkPeriod,
  closePeriod,
  reopenPeriod,
  auditPack,
};

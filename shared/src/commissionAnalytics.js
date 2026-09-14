const { QueryTypes } = require('sequelize');
const { asMinor } = require('./money');
const { calculate } = require('./commission');
const { computeForDeal } = require('./commissionStore');

/**
 * What the commission engine cost, what it still owes, and what a different
 * plan would have cost instead (§8, FR-ANL-*).
 *
 * ── Everything here reads; nothing writes ───────────────────────────────────
 *
 * That is a deliberate constraint rather than a description. A reporting
 * function that corrected a figure it found wrong would make the report the
 * source of truth for the number it was reporting on, and the two would drift
 * the moment anybody looked at a different date range. Where a figure here
 * disagrees with the ledger, the LEDGER is right and the disagreement is the
 * finding.
 *
 * ── Why the aggregates run in SQL and the backtest does not ─────────────────
 *
 * The totals are sums over an indexed column and belong in the database. The
 * backtest re-runs the ACTUAL engine over historical deals, because the only
 * useful answer to "what would this plan have cost" is the one produced by the
 * code that would have produced it — reimplementing the arithmetic in a query
 * would answer a question about the query.
 */

/** Restrict every figure to one company and one window. */
const scopeOf = ({ companyId = null, from = null, to = null }, column = 'attribution_date') => {
  const clauses = [];
  const replacements = {};
  if (companyId) { clauses.push('company_id = :companyId'); replacements.companyId = companyId; }
  if (from) { clauses.push(`${column} >= :from`); replacements.from = from; }
  if (to) { clauses.push(`${column} <= :to`); replacements.to = to; }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', replacements };
};

/**
 * The headline figures (FR-ANL-001).
 *
 * Read from the entitlements rather than the ledger because these are questions
 * about POSITIONS — what is owed, what is outstanding — and the ledger records
 * movements. Summing movements to get a position is the same arithmetic with
 * more chances to miss an entry type.
 */
const summaryFor = async (sequelize, options = {}) => {
  const { where, replacements } = scopeOf(options);
  const [row] = await sequelize.query(
    `SELECT
       COUNT(*)                                           AS line_count,
       COUNT(DISTINCT deal_ref)                           AS deals,
       COUNT(DISTINCT realtor_id)                         AS earners,
       COALESCE(SUM(gross_minor), 0)                      AS gross,
       COALESCE(SUM(constrained_minor), 0)                AS entitled,
       COALESCE(SUM(released_minor), 0)                   AS released,
       COALESCE(SUM(paid_minor), 0)                       AS paid,
       COALESCE(SUM(held_minor), 0)                       AS held,
       COALESCE(SUM(forfeited_minor), 0)                  AS forfeited,
       COALESCE(SUM(clawed_back_minor), 0)                AS clawed_back,
       /**
        * The liability figures exclude what is no longer owed.
        *
        * A forfeited or reversed line still has an entitlement and a release on
        * it — that is the record of what happened — so deriving liability from
        * entitled minus released across every row reports money the company
        * does not owe as an outstanding obligation. It has to match what
        * liabilityFor ages, or the same quantity has two answers depending on
        * which report you opened.
        */
       COALESCE(SUM(CASE WHEN status NOT IN ('REVERSED', 'FORFEITED')
                          AND constrained_minor > paid_minor
                         THEN constrained_minor - released_minor ELSE 0 END), 0) AS owing,
       COALESCE(SUM(CASE WHEN status NOT IN ('REVERSED', 'FORFEITED')
                          AND constrained_minor > paid_minor
                         THEN released_minor - paid_minor ELSE 0 END), 0)        AS due
     FROM commission_entitlements ${where}`,
    { replacements, type: QueryTypes.SELECT },
  );

  const entitled = asMinor(row.entitled);
  const released = asMinor(row.released);
  const paid = asMinor(row.paid);

  return {
    lines: Number(row.line_count) || 0,
    deals: Number(row.deals) || 0,
    earners: Number(row.earners) || 0,
    gross_minor: asMinor(row.gross),
    entitled_minor: entitled,
    released_minor: released,
    paid_minor: paid,
    held_minor: asMinor(row.held),
    forfeited_minor: asMinor(row.forfeited),
    clawed_back_minor: asMinor(row.clawed_back),
    /**
     * The two numbers a finance officer actually asks for.
     *
     * `accrued_liability` is recognised and not yet vested — an obligation that
     * exists but is not payable. `payable` is vested and not yet transferred,
     * which is the cheque that has to be written. Reporting one total for both
     * overstates what is due this month and understates the exposure.
     */
    accrued_liability_minor: Math.max(asMinor(row.owing), 0),
    payable_minor: Math.max(asMinor(row.due), 0),
  };
};

/**
 * Where money went that nobody was paid (FR-ANL-004).
 *
 * BY CAUSE, because "forty million went unallocated" is not something a company
 * can act on, and "sixty percent of it was Gen 2 uplines who never met the
 * qualification bar" is — the second says to look at the bar.
 */
const breakageFor = async (sequelize, options = {}) => {
  const { where, replacements } = scopeOf(options);
  const rows = await sequelize.query(
    `SELECT eligibility_check, forfeited_minor, rule_type, role
       FROM commission_entitlements
       ${where}${where ? ' AND' : 'WHERE'} forfeited_minor > 0`,
    { replacements, type: QueryTypes.SELECT },
  );

  const byCause = new Map();
  let total = 0;

  for (const row of rows) {
    const amount = asMinor(row.forfeited_minor);
    total += amount;

    let cause = 'unknown';
    try {
      const check = JSON.parse(row.eligibility_check || '{}');
      cause = check.reason || check.status || 'unknown';
    } catch { /* an unreadable check is itself a cause worth counting */ }

    const key = `${cause}:${row.role}`;
    const existing = byCause.get(key) || {
      cause, role: row.role, amount_minor: 0, lines: 0,
    };
    existing.amount_minor += amount;
    existing.lines += 1;
    byCause.set(key, existing);
  }

  return {
    total_minor: total,
    causes: [...byCause.values()].sort((a, b) => b.amount_minor - a.amount_minor),
  };
};

/**
 * What a deal actually cost in commission, against what it sold for
 * (FR-ANL-002).
 *
 * The ratio, not just the total. A company with a rising commission bill wants
 * to know whether it is selling more or paying more per sale, and only the
 * ratio separates the two.
 */
const costOfSaleFor = async (sequelize, options = {}) => {
  const { where, replacements } = scopeOf(options);
  const rows = await sequelize.query(
    `SELECT deal_ref, property_id,
            COALESCE(SUM(constrained_minor), 0) AS commission,
            MIN(trace) AS sample_trace,
            MIN(attribution_date) AS attributed
       FROM commission_entitlements ${where}
      GROUP BY deal_ref, property_id`,
    { replacements, type: QueryTypes.SELECT },
  );

  const deals = rows.map((row) => {
    let base = 0;
    try {
      const trace = JSON.parse(row.sample_trace || '{}');
      base = asMinor(trace.commissionable_base_minor ?? trace.basis_amount_minor);
    } catch { /* a deal whose trace will not parse still has a commission */ }
    const commission = asMinor(row.commission);
    return {
      deal_ref: row.deal_ref,
      property_id: row.property_id,
      attributed: row.attributed,
      base_minor: base,
      commission_minor: commission,
      // Null rather than zero: "we do not know the base" and "the commission was
      // 0% of the sale" are different findings and must not look alike.
      rate: base > 0 ? Number(((commission / base) * 100).toFixed(4)) : null,
    };
  });

  const known = deals.filter((deal) => deal.rate !== null);
  const totalBase = known.reduce((total, deal) => total + deal.base_minor, 0);
  const totalCommission = known.reduce((total, deal) => total + deal.commission_minor, 0);

  return {
    deals,
    blended_rate: totalBase > 0 ? Number(((totalCommission / totalBase) * 100).toFixed(4)) : null,
    total_base_minor: totalBase,
    total_commission_minor: totalCommission,
  };
};

/** Who earned what, most first (FR-ANL-003). */
const leaderboardFor = async (sequelize, options = {}) => {
  const { where, replacements } = scopeOf(options);
  return sequelize.query(
    `SELECT e.realtor_id,
            COUNT(DISTINCT e.deal_ref)             AS deals,
            COALESCE(SUM(e.constrained_minor), 0)  AS earned,
            COALESCE(SUM(e.paid_minor), 0)         AS paid
       FROM commission_entitlements e ${where}
      GROUP BY e.realtor_id
      ORDER BY earned DESC`,
    { replacements, type: QueryTypes.SELECT },
  );
};

/**
 * Outstanding obligation, aged (FR-ANL-005).
 *
 * Aged from the ATTRIBUTION date rather than from accrual, because the question
 * is how long an obligation has been outstanding, and a deal accrued late was
 * still incurred when it was sold.
 */
const liabilityFor = async (sequelize, options = {}) => {
  const { where, replacements } = scopeOf(options);
  const rows = await sequelize.query(
    `SELECT realtor_id, deal_ref, attribution_date,
            constrained_minor, released_minor, paid_minor, held_minor, status
       FROM commission_entitlements
       ${where}${where ? ' AND' : 'WHERE'} constrained_minor > paid_minor
         AND status NOT IN ('REVERSED', 'FORFEITED')`,
    { replacements, type: QueryTypes.SELECT },
  );

  const now = options.at ? new Date(options.at) : new Date();
  const buckets = [
    { label: '0-30', from: 0, to: 30, amount_minor: 0, lines: 0 },
    { label: '31-60', from: 31, to: 60, amount_minor: 0, lines: 0 },
    { label: '61-90', from: 61, to: 90, amount_minor: 0, lines: 0 },
    { label: '90+', from: 91, to: Infinity, amount_minor: 0, lines: 0 },
  ];

  let accrued = 0;
  let payable = 0;

  for (const row of rows) {
    const outstanding = asMinor(row.constrained_minor) - asMinor(row.paid_minor);
    const vested = Math.max(asMinor(row.released_minor) - asMinor(row.paid_minor), 0);
    payable += vested;
    accrued += Math.max(outstanding - vested, 0);

    const age = Math.max(
      Math.floor((now.getTime() - new Date(row.attribution_date).getTime()) / 86400000), 0,
    );
    const bucket = buckets.find((candidate) => age >= candidate.from && age <= candidate.to);
    if (bucket) { bucket.amount_minor += outstanding; bucket.lines += 1; }
  }

  return {
    accrued_liability_minor: accrued,
    payable_minor: payable,
    total_minor: accrued + payable,
    aged: buckets,
  };
};

/**
 * Journal lines for the general ledger (FR-ANL-009).
 *
 * Derived from the LEDGER, not from the entitlements, because this is the one
 * report whose job is to agree with the books — and the ledger is the record of
 * account. Every line balances by construction: each entry type maps to exactly
 * one debit and one credit, so an export that does not sum to zero means an
 * entry type has been added without deciding where it posts, which is a finding
 * rather than a rounding difference.
 */
const ACCOUNTS = {
  ACCRUAL: { debit: 'COMMISSION_EXPENSE', credit: 'COMMISSION_ACCRUED' },
  RELEASE: { debit: 'COMMISSION_ACCRUED', credit: 'COMMISSION_PAYABLE' },
  PAYOUT: { debit: 'COMMISSION_PAYABLE', credit: 'BANK' },
  FORFEIT: { debit: 'COMMISSION_ACCRUED', credit: 'COMMISSION_BREAKAGE' },
  HOLD: { debit: 'COMMISSION_ACCRUED', credit: 'COMMISSION_HELD' },
  REVERSAL: { debit: 'COMMISSION_ACCRUED', credit: 'COMMISSION_EXPENSE' },
  ADJUSTMENT: { debit: 'COMMISSION_EXPENSE', credit: 'COMMISSION_ACCRUED' },
  RECOVERY: { debit: 'COMMISSION_PAYABLE', credit: 'COMMISSION_RECEIVABLE' },
  /**
   * A non-cash award is a real expense settled in kind, so it debits the same
   * expense account and credits awards rather than the cash payable — it must
   * never flow into a payable somebody could later transfer.
   */
  AWARD: { debit: 'COMMISSION_EXPENSE', credit: 'COMMISSION_AWARDS' },
};

const glExportFor = async (sequelize, options = {}) => {
  const { where, replacements } = scopeOf(options, 'created_at');
  const rows = await sequelize.query(
    `SELECT id, entry_type, amount_minor, realtor_id, deal_ref, created_at, company_id
       FROM commission_ledger_entries ${where}
      ORDER BY created_at, id`,
    { replacements, type: QueryTypes.SELECT },
  );

  const journal = [];
  const unmapped = new Set();

  for (const row of rows) {
    const mapping = ACCOUNTS[row.entry_type];
    if (!mapping) { unmapped.add(row.entry_type); continue; }
    const amount = asMinor(row.amount_minor);
    if (amount === 0) continue;

    const common = {
      ledger_entry_id: row.id,
      date: row.created_at,
      deal_ref: row.deal_ref,
      realtor_id: row.realtor_id,
      company_id: row.company_id,
      memo: `${row.entry_type} ${row.deal_ref || ''}`.trim(),
    };
    journal.push({ ...common, account: mapping.debit, debit_minor: amount, credit_minor: 0 });
    journal.push({ ...common, account: mapping.credit, debit_minor: 0, credit_minor: amount });
  }

  const debits = journal.reduce((total, line) => total + line.debit_minor, 0);
  const credits = journal.reduce((total, line) => total + line.credit_minor, 0);

  return {
    journal,
    debits_minor: debits,
    credits_minor: credits,
    balanced: debits === credits,
    /**
     * Named rather than silently dropped. An entry type with no mapping is a
     * gap in this table, and a GL export that quietly omits a class of
     * movements is worse than one that refuses.
     */
    unmapped_entry_types: [...unmapped],
  };
};

/**
 * What a candidate plan WOULD have cost over deals already closed (FR-SIM-001).
 *
 * Runs the real engine over the real deals, changing only the plan. That is the
 * point: a company considering a change wants the number its own history would
 * have produced, and any reimplementation of the arithmetic here would be
 * answering a question about the reimplementation.
 *
 * Writes nothing (FR-SIM-005). The store's own `computeForDeal` is used to
 * gather each deal's participants, so a backtest and a live calculation cannot
 * diverge on who was involved.
 */
const backtest = async (sequelize, { companyId = null, from = null, to = null, plan }) => {
  if (!plan) throw new Error('backtest requires a candidate plan');

  const { where, replacements } = scopeOf({ companyId, from, to });
  const deals = await sequelize.query(
    `SELECT deal_ref,
            MIN(property_id)                      AS property_id,
            MIN(invoice_id)                       AS invoice_id,
            MIN(company_id)                       AS company_id,
            MIN(attribution_date)                 AS attribution_date,
            COALESCE(SUM(constrained_minor), 0)   AS actual_minor,
            MIN(trace)                            AS sample_trace,
            /**
             * The seller, read off the DIRECT line rather than from the
             * invoice. The engine attributes a deal once, at accrual; asking
             * the invoice again would let a buyer reassigned since then be
             * backtested against a realtor who never earned on it.
             */
            MIN(CASE WHEN role = 'DIRECT' THEN realtor_id END) AS selling_realtor_id
       FROM commission_entitlements ${where}
      GROUP BY deal_ref`,
    { replacements, type: QueryTypes.SELECT },
  );

  const compared = [];
  let actualTotal = 0;
  let candidateTotal = 0;

  for (const row of deals) {
    let base = 0;
    try {
      const trace = JSON.parse(row.sample_trace || '{}');
      base = asMinor(trace.commissionable_base_minor ?? trace.basis_amount_minor);
    } catch { /* handled below */ }

    /**
     * A deal whose base cannot be recovered is REPORTED, not skipped.
     *
     * Silently dropping it would make the candidate plan look cheaper by
     * exactly the deals the comparison could not price — the error and the
     * conclusion point the same way, which is the worst arrangement.
     */
    if (base <= 0) {
      compared.push({ deal_ref: row.deal_ref, skipped: 'base_unknown', actual_minor: asMinor(row.actual_minor) });
      actualTotal += asMinor(row.actual_minor);
      continue;
    }

    /**
     * `computeForDeal` assembles the participants — seller, uplines, status
     * histories — and returns the engine input it built. The candidate plan is
     * then applied to THAT input, so the comparison differs from the live
     * calculation in the plan and in nothing else.
     */
    // eslint-disable-next-line no-await-in-loop
    const { input } = await computeForDeal(sequelize, {
      deal_ref: row.deal_ref,
      company_id: row.company_id,
      property_id: row.property_id,
      invoice_id: row.invoice_id,
      selling_realtor_id: row.selling_realtor_id,
      gross_price_minor: base,
      discount_minor: 0,
      unit_count: 1,
      attribution_date: row.attribution_date,
    }).catch(() => ({ input: null }));

    const candidate = input ? calculate({ ...input, plan }) : null;

    const actual = asMinor(row.actual_minor);
    const would = candidate ? candidate.allocated_minor : null;
    actualTotal += actual;
    if (would !== null) candidateTotal += would;

    compared.push({
      deal_ref: row.deal_ref,
      base_minor: base,
      actual_minor: actual,
      candidate_minor: would,
      difference_minor: would === null ? null : would - actual,
      ...(would === null ? { skipped: 'participants_unavailable' } : {}),
    });
  }

  const priced = compared.filter((deal) => deal.candidate_minor !== null && !deal.skipped);

  return {
    deals: compared,
    priced: priced.length,
    unpriced: compared.length - priced.length,
    actual_minor: actualTotal,
    candidate_minor: candidateTotal,
    difference_minor: candidateTotal - priced.reduce((total, deal) => total + deal.actual_minor, 0),
  };
};

module.exports = {
  summaryFor, breakageFor, costOfSaleFor, leaderboardFor, liabilityFor,
  glExportFor, backtest, ACCOUNTS,
};

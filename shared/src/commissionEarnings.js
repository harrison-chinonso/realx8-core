const { QueryTypes } = require('sequelize');
const { asMinor, toMajor } = require('./money');
const { q } = require('./dialect');

/**
 * What one person has earned in commission, from BOTH systems at once.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * There are two: the older flat-rate `commissions` table, and the engine that
 * writes `commission_entitlements`. Exactly one of them pays for a given sale —
 * the engine where a plan is in force, the flat rate otherwise — so they never
 * double-count. But every screen used to read only one, and which one was an
 * accident of when that screen was written.
 *
 * The result was a realtor who had genuinely been paid a million naira looking
 * at a dashboard that said zero, on a company running the engine. Nothing was
 * wrong with the money; the screens were reading the wrong table. A person
 * cannot tell those two apart, and the second thing they do is stop trusting
 * every other number on the page.
 *
 * ── Why the totals are computed here rather than per caller ─────────────────
 *
 * Four callers wanted the same six figures and each would have had to know
 * which statuses of which table mean "earned but not yet paid" — a question
 * whose answer differs between the two systems. One place to be wrong is much
 * better than four, and it is the place a fix reaches all of them.
 *
 * Never throws. A missing table on an older database, or a company that has
 * only ever used one system, returns zeroes for the side that is absent rather
 * than failing the whole dashboard.
 */

/** The engine's statuses, grouped by what they mean to a person. */
const ENGINE_UNPAID_STATUSES = "('ACCRUED', 'PARTIALLY_RELEASED', 'RELEASED')";

/**
 * @param {object} sequelize
 * @param {object} args  { realtorId, companyId }
 * @returns {Promise<{ total, paid, unpaid, sources, engine, legacy }>} major units
 */
const earningsFor = async (sequelize, { realtorId, companyId = null, transaction = null } = {}) => {
  const empty = { total_minor: 0, paid_minor: 0, unpaid_minor: 0, count: 0 };

  /**
   * The engine side.
   *
   * `constrained_minor` is what they are entitled to after the plan's cap;
   * `paid_minor` is what has actually gone out. Forfeited and clawed-back
   * amounts are subtracted rather than ignored — a realtor whose commission was
   * reversed should not go on seeing it in their total, which is the reading
   * that generates the angriest support call of all.
   */
  const engine = await sequelize.query(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(e.constrained_minor - e.forfeited_minor - e.clawed_back_minor), 0) AS total_minor,
            COALESCE(SUM(e.paid_minor), 0) AS paid_minor,
            COALESCE(SUM(
              CASE WHEN e.status IN ${ENGINE_UNPAID_STATUSES}
                   THEN e.constrained_minor - e.forfeited_minor - e.clawed_back_minor - e.paid_minor
                   ELSE 0 END
            ), 0) AS unpaid_minor
       FROM ${q(sequelize, 'commission_entitlements')} e
      WHERE e.realtor_id = :realtorId
        ${companyId ? 'AND e.company_id = :companyId' : ''}`,
    {
      replacements: { realtorId, ...(companyId ? { companyId } : {}) },
      type: QueryTypes.SELECT,
      transaction,
    },
  ).then((rows) => rows[0] || empty).catch(() => empty);

  /**
   * The legacy side. Its amounts are DECIMAL major units, so they are converted
   * on the way in — mixing the two representations is how a figure ends up a
   * hundred times too large, and only on the companies that used both.
   */
  const legacy = await sequelize.query(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(c.amount), 0) AS total,
            COALESCE(SUM(CASE WHEN c.status = 'paid' THEN c.amount ELSE 0 END), 0) AS paid,
            COALESCE(SUM(CASE WHEN c.status IN ('created', 'payment_requested', 'approved')
                              THEN c.amount ELSE 0 END), 0) AS unpaid
       FROM ${q(sequelize, 'commissions')} c
      WHERE c.employee_id = :realtorId
        ${companyId ? 'AND c.company_id = :companyId' : ''}`,
    {
      replacements: { realtorId, ...(companyId ? { companyId } : {}) },
      type: QueryTypes.SELECT,
      transaction,
    },
  ).then((rows) => {
    const row = rows[0];
    if (!row) return empty;
    return {
      count: Number(row.count) || 0,
      total_minor: Math.round((Number(row.total) || 0) * 100),
      paid_minor: Math.round((Number(row.paid) || 0) * 100),
      unpaid_minor: Math.round((Number(row.unpaid) || 0) * 100),
    };
  }).catch(() => empty);

  const totalMinor = asMinor(engine.total_minor) + asMinor(legacy.total_minor);
  const paidMinor = asMinor(engine.paid_minor) + asMinor(legacy.paid_minor);
  const unpaidMinor = asMinor(engine.unpaid_minor) + asMinor(legacy.unpaid_minor);

  return {
    total: toMajor(totalMinor),
    paid: toMajor(paidMinor),
    unpaid: toMajor(Math.max(unpaidMinor, 0)),
    total_minor: totalMinor,
    paid_minor: paidMinor,
    unpaid_minor: Math.max(unpaidMinor, 0),
    /**
     * Which systems actually contributed. A company seeing figures from both is
     * usually mid-migration, and somebody eventually asks why — this is the
     * answer, without them having to go and count rows.
     */
    sources: [
      ...(Number(engine.count) > 0 ? ['engine'] : []),
      ...(Number(legacy.count) > 0 ? ['flat_rate'] : []),
    ],
    engine: {
      count: Number(engine.count) || 0,
      total: toMajor(asMinor(engine.total_minor)),
      paid: toMajor(asMinor(engine.paid_minor)),
      unpaid: toMajor(asMinor(engine.unpaid_minor)),
    },
    legacy: {
      count: legacy.count,
      total: toMajor(asMinor(legacy.total_minor)),
      paid: toMajor(asMinor(legacy.paid_minor)),
      unpaid: toMajor(asMinor(legacy.unpaid_minor)),
    },
  };
};

/**
 * The same, for a whole company — what it owes and has paid in commission.
 *
 * Used by the finance reports, where the question is the company's cost of
 * sale rather than one person's earnings.
 */
const companyEarnings = async (sequelize, { companyId, from = null, to = null } = {}) => {
  const empty = { total_minor: 0, paid_minor: 0, unpaid_minor: 0, count: 0, earners: 0 };

  const engine = await sequelize.query(
    `SELECT COUNT(*) AS count,
            COUNT(DISTINCT e.realtor_id) AS earners,
            COALESCE(SUM(e.constrained_minor - e.forfeited_minor - e.clawed_back_minor), 0) AS total_minor,
            COALESCE(SUM(e.paid_minor), 0) AS paid_minor
       FROM ${q(sequelize, 'commission_entitlements')} e
      WHERE 1 = 1
        ${companyId ? 'AND e.company_id = :companyId' : ''}
        ${from ? 'AND e.attribution_date >= :from' : ''}
        ${to ? 'AND e.attribution_date <= :to' : ''}`,
    {
      replacements: {
        ...(companyId ? { companyId } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}),
      },
      type: QueryTypes.SELECT,
    },
  ).then((rows) => rows[0] || empty).catch(() => empty);

  const legacy = await sequelize.query(
    `SELECT COUNT(*) AS count,
            COUNT(DISTINCT c.employee_id) AS earners,
            COALESCE(SUM(c.amount), 0) AS total,
            COALESCE(SUM(CASE WHEN c.status = 'paid' THEN c.amount ELSE 0 END), 0) AS paid
       FROM ${q(sequelize, 'commissions')} c
      WHERE 1 = 1
        ${companyId ? 'AND c.company_id = :companyId' : ''}
        ${from ? 'AND c.created_at >= :from' : ''}
        ${to ? 'AND c.created_at <= :to' : ''}`,
    {
      replacements: {
        ...(companyId ? { companyId } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}),
      },
      type: QueryTypes.SELECT,
    },
  ).then((rows) => {
    const row = rows[0];
    if (!row) return empty;
    return {
      count: Number(row.count) || 0,
      earners: Number(row.earners) || 0,
      total_minor: Math.round((Number(row.total) || 0) * 100),
      paid_minor: Math.round((Number(row.paid) || 0) * 100),
    };
  }).catch(() => empty);

  const totalMinor = asMinor(engine.total_minor) + asMinor(legacy.total_minor);
  const paidMinor = asMinor(engine.paid_minor) + asMinor(legacy.paid_minor);

  return {
    total: toMajor(totalMinor),
    paid: toMajor(paidMinor),
    outstanding: toMajor(Math.max(totalMinor - paidMinor, 0)),
    count: (Number(engine.count) || 0) + legacy.count,
    /**
     * Earners are summed rather than counted distinctly across both systems.
     * Somebody earning under each would be counted twice — accepted, because
     * the alternative is a UNION per report and the overlap is a company
     * mid-migration rather than a steady state.
     */
    earners: (Number(engine.earners) || 0) + legacy.earners,
    sources: [
      ...(Number(engine.count) > 0 ? ['engine'] : []),
      ...(legacy.count > 0 ? ['flat_rate'] : []),
    ],
  };
};

module.exports = { earningsFor, companyEarnings };

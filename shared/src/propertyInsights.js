const { QueryTypes } = require('sequelize');
const { q } = require('./dialect');
const { quote } = require('./installmentPricing');
const { toMinor, toMajor } = require('./money');
const { cache, KEYS, TTL } = require('./cache');

/**
 * The extra figures the redesigned property pages show, read cheaply.
 *
 * ── The cost rule ───────────────────────────────────────────────────────────
 *
 * Every function here is ONE set-based query for a whole page — never one per
 * property or per unit — read-only, on indexed columns, and best effort: a
 * failure is logged and costs that figure, never the page. Nothing here
 * writes, so nothing here keeps a serverless database awake on its own.
 *
 * ── The portability rule ────────────────────────────────────────────────────
 *
 * Plain ANSI SQL only: no backticks, no DATE_ADD or NOW() arithmetic, no
 * GROUP_CONCAT, no LIMIT inside subqueries. Identifiers that are reserved words
 * on one engine (`status`, `type`) go through q(), dates and booleans are bound
 * as replacements, and anything dialect-shaped is done in JavaScript instead.
 *
 * ── The cache rule ──────────────────────────────────────────────────────────
 *
 * The figures that are the same for everyone in a company read through the
 * shared cache (Redis, or in-process without it), keyed under `prop:<company>:`
 * and evicted by evictPropertyCaches on every write that moves them. A figure
 * computed while one of its queries FAILED is served but never cached — a
 * database blip must not be remembered as "0 units" for two minutes.
 */

const safe = async (label, run, fallback, failures = null) => {
  try {
    return await run();
  } catch (error) {
    console.error(`[property-insights] ${label}: ${error.message}`);
    if (failures) failures.push(label);
    return fallback;
  }
};

/**
 * Read-through for a best-effort figure: the cached value, or compute it and
 * cache it only when every query behind it succeeded.
 */
const cachedFigure = async (key, ttl, compute) => {
  const hit = await cache.get(key);
  if (hit !== null && hit !== undefined) return hit;
  const failures = [];
  const value = await compute(failures);
  if (!failures.length) await cache.set(key, value, ttl);
  return value;
};

const PLAN_COLUMNS = `ipu.property_unit_id AS unit_id, ip.duration_months, ip.surcharge_type,
            ip.surcharge_value, ip.rounding_rule`;

/**
 * Past this many assignments a company's plan map is not worth caching whole:
 * parsing it on every page would cost more than the indexed query it saves.
 */
const PLAN_MAP_LIMIT = 3000;

/**
 * Every active plan assignment for one company's units, cached. Null when the
 * map is too large to cache or could not be read — the caller then queries
 * just the units it needs.
 */
const companyPlanRows = async (sequelize, companyId) => {
  const key = KEYS.companyPlanMap(companyId);
  const hit = await cache.get(key);
  if (Array.isArray(hit)) return hit;
  const rows = await safe('plan-map', () => sequelize.query(
    `SELECT ${PLAN_COLUMNS}
       FROM installment_plan_units ipu
       JOIN installment_plans ip ON ip.id = ipu.installment_plan_id
       JOIN property_units pu ON pu.id = ipu.property_unit_id
       JOIN properties p ON p.id = pu.property_id
      WHERE p.company_id = :companyId AND ip.is_active = :yes`,
    { replacements: { companyId, yes: true }, type: QueryTypes.SELECT },
  ), null);
  if (!rows || rows.length > PLAN_MAP_LIMIT) return null;
  await cache.set(key, rows, TTL.reference);
  return rows;
};

/**
 * The payment plans on offer for a set of units, and what the cheapest monthly
 * installment works out to.
 *
 * The monthly figure is quoted with the same `quote()` the purchase screen
 * uses — surcharge, rounding and all — for one unit, so "from ₦690K / month"
 * is a price somebody can actually be charged, not an estimate.
 *
 * With `companyIds` (the companies that own these units) the assignments come
 * from each company's cached plan map, so a page of cards usually costs no
 * query at all. The price is always the unit's live one: only the plan rows
 * are cached, never the money.
 *
 * @param units [{ id, price }]
 * @returns Map unitId → { plans, maxMonths, minMonthly }
 */
const planSummaryForUnits = async (sequelize, units = [], { companyIds = [] } = {}) => {
  const byUnit = new Map();
  const priceOf = new Map(units.map((unit) => [Number(unit.id), Number(unit.price) || 0]));
  const ids = [...priceOf.keys()].filter(Number.isInteger);
  if (!ids.length) return byUnit;

  const companies = [...new Set(companyIds.filter((id) => id != null).map(Number))];
  let rows = null;
  if (companies.length && companies.length <= 5) {
    const maps = await Promise.all(companies.map((id) => companyPlanRows(sequelize, id)));
    if (maps.every(Array.isArray)) {
      const wanted = new Set(ids);
      rows = maps.flat().filter((row) => wanted.has(Number(row.unit_id)));
    }
  }
  if (!rows) {
    rows = await safe('plans', () => sequelize.query(
      `SELECT ${PLAN_COLUMNS}
         FROM installment_plan_units ipu
         JOIN installment_plans ip ON ip.id = ipu.installment_plan_id
        WHERE ipu.property_unit_id IN (:ids) AND ip.is_active = :yes`,
      { replacements: { ids, yes: true }, type: QueryTypes.SELECT },
    ), []);
  }

  rows.forEach((row) => {
    const unitId = Number(row.unit_id);
    const price = priceOf.get(unitId) || 0;
    const monthly = price > 0
      ? toMajor(quote({ unitPriceMinor: toMinor(price), quantity: 1, paymentType: 'installment', plan: row }).perMonthMinor)
      : null;
    const entry = byUnit.get(unitId) || { plans: 0, maxMonths: 0, minMonthly: null };
    entry.plans += 1;
    entry.maxMonths = Math.max(entry.maxMonths, Number(row.duration_months) || 0);
    if (monthly && (entry.minMonthly === null || monthly < entry.minMonthly)) entry.minMonthly = monthly;
    byUnit.set(unitId, entry);
  });
  return byUnit;
};

/** One property's roll-up of its units' plans, for a card or a header. */
const rollUpPlans = (units = [], byUnit = new Map()) => units.reduce((acc, unit) => {
  const entry = byUnit.get(Number(unit.id));
  if (!entry) return acc;
  acc.units_with_plans += 1;
  acc.plans = Math.max(acc.plans, entry.plans);
  acc.max_months = Math.max(acc.max_months, entry.maxMonths);
  if (entry.minMonthly !== null && (acc.min_monthly === null || entry.minMonthly < acc.min_monthly)) {
    acc.min_monthly = entry.minMonthly;
  }
  return acc;
}, { plans: 0, units_with_plans: 0, max_months: 0, min_monthly: null });

/**
 * The staff listing's summary strip, across the whole company rather than the
 * page on screen: how many properties in each status and approval state, the
 * unit stock, and this month's purchase requests. Four aggregates.
 */
const listingSummary = (sequelize, companyId) => cachedFigure(
  KEYS.propertySummary(companyId), TTL.propertyInsights, (failures) => computeListingSummary(sequelize, companyId, failures),
);

const computeListingSummary = async (sequelize, companyId, failures) => {
  const scope = companyId == null ? '' : 'AND p.company_id = :companyId';
  const replacements = { companyId };
  const status = q(sequelize, 'status');

  const [byStatus, byApproval, stock, requests] = await Promise.all([
    safe('status', () => sequelize.query(
      `SELECT p.${status} AS k, COUNT(*) AS n FROM properties p WHERE 1 = 1 ${scope} GROUP BY p.${status}`,
      { replacements, type: QueryTypes.SELECT },
    ), [], failures),
    safe('approval', () => sequelize.query(
      `SELECT p.approval_status AS k, COUNT(*) AS n FROM properties p WHERE 1 = 1 ${scope} GROUP BY p.approval_status`,
      { replacements, type: QueryTypes.SELECT },
    ), [], failures),
    safe('stock', () => sequelize.query(
      `SELECT COALESCE(SUM(pu.quantity), 0) AS total,
              (SELECT COALESCE(SUM(h.quantity), 0)
                 FROM property_unit_holds h JOIN properties hp ON hp.id = h.property_id
                WHERE h.released_at IS NULL ${companyId == null ? '' : 'AND hp.company_id = :companyId'}) AS held
         FROM property_units pu JOIN properties p ON p.id = pu.property_id
        WHERE 1 = 1 ${scope}`,
      { replacements, type: QueryTypes.SELECT },
    ), [{}], failures),
    safe('requests', () => {
      const now = new Date();
      return sequelize.query(
        `SELECT COUNT(*) AS n FROM property_purchase_requests pr JOIN properties p ON p.id = pr.property_id
          WHERE pr.created_at >= :since ${scope}`,
        { replacements: { ...replacements, since: new Date(now.getFullYear(), now.getMonth(), 1) }, type: QueryTypes.SELECT },
      );
    }, [{}], failures),
  ]);

  const tally = (rows) => Object.fromEntries(rows.map((row) => [row.k ?? 'unknown', Number(row.n) || 0]));
  const total = Number(stock[0]?.total) || 0;
  const held = Number(stock[0]?.held) || 0;
  const statuses = tally(byStatus);
  return {
    properties: Object.values(statuses).reduce((t, n) => t + n, 0),
    by_status: statuses,
    by_approval: tally(byApproval),
    units: { total, held, available: Math.max(total - held, 0) },
    purchase_requests_this_month: Number(requests[0]?.n) || 0,
  };
};

/** Money actually received against one property's invoices. One aggregate. */
const moneyReceived = (sequelize, propertyId, companyId) => cachedFigure(
  KEYS.propertyReceived(companyId, propertyId), TTL.propertyInsights,
  (failures) => computeMoneyReceived(sequelize, propertyId, companyId, failures),
);

const computeMoneyReceived = async (sequelize, propertyId, companyId, failures) => {
  const rows = await safe('received', () => sequelize.query(
    `SELECT COALESCE(SUM(ip.amount), 0) AS total, COUNT(DISTINCT i.id) AS invoices
       FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id
      WHERE i.property_id = :propertyId AND ip.status = 'completed'
        ${companyId == null ? '' : 'AND i.company_id = :companyId'}`,
    { replacements: { propertyId, companyId }, type: QueryTypes.SELECT },
  ), [{}], failures);
  return { total: Number(rows[0]?.total) || 0, invoices: Number(rows[0]?.invoices) || 0 };
};

/**
 * How often one property's share links have been opened, and by whose link.
 * Two small reads on referral_links (company-scoped, so the unique index's
 * leading column applies). Not cached: staff-only, and the counts move every
 * minute anyway.
 */
const shareViewStats = async (sequelize, propertyId, companyId) => {
  const scope = companyId == null ? '' : 'AND rl.company_id = :companyId';
  const replacements = { propertyId, companyId };
  const [totals, top] = await Promise.all([
    safe('share-views', () => sequelize.query(
      `SELECT COALESCE(SUM(rl.view_count), 0) AS views, COUNT(*) AS links, MAX(rl.last_viewed_at) AS last_viewed_at
         FROM referral_links rl
        WHERE rl.property_id = :propertyId AND rl.revoked_at IS NULL ${scope}`,
      { replacements, type: QueryTypes.SELECT },
    ), [{}]),
    safe('share-views-top', () => sequelize.query(
      `SELECT rl.realtor_code, rl.view_count AS views, rl.last_viewed_at, u.name
         FROM referral_links rl
         LEFT JOIN users u ON u.realtor_code = rl.realtor_code AND u.company_id = rl.company_id
        WHERE rl.property_id = :propertyId AND rl.revoked_at IS NULL AND rl.view_count > 0 ${scope}
        ORDER BY rl.view_count DESC`,
      { replacements, type: QueryTypes.SELECT },
    ), []),
  ]);
  const seen = new Set();
  return {
    views: Number(totals[0]?.views) || 0,
    links: Number(totals[0]?.links) || 0,
    last_viewed_at: totals[0]?.last_viewed_at || null,
    // One row per link; a realtor code can match more than one user only on
    // bad data, so the first name wins rather than doubling the row.
    top: top.filter((row) => {
      const key = row.realtor_code || '(company)';
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 5).map((row) => ({
      realtor_code: row.realtor_code || null,
      name: row.realtor_code ? (row.name || row.realtor_code) : 'Company link',
      views: Number(row.views) || 0,
      last_viewed_at: row.last_viewed_at || null,
    })),
  };
};

/**
 * One realtor's own share-link opens, for a page of properties. One query.
 * @returns Map propertyId → { views, last_viewed_at }
 */
const myShareViews = async (sequelize, userId, propertyIds = []) => {
  const map = new Map();
  const ids = propertyIds.map(Number).filter(Number.isInteger);
  if (!userId || !ids.length) return map;
  const rows = await safe('my-share-views', () => sequelize.query(
    `SELECT rl.property_id, rl.view_count AS views, rl.last_viewed_at
       FROM referral_links rl
       JOIN users u ON u.realtor_code = rl.realtor_code AND u.company_id = rl.company_id
      WHERE u.id = :userId AND rl.property_id IN (:ids) AND rl.revoked_at IS NULL`,
    { replacements: { userId, ids }, type: QueryTypes.SELECT },
  ), []);
  rows.forEach((row) => map.set(Number(row.property_id), {
    views: Number(row.views) || 0,
    last_viewed_at: row.last_viewed_at || null,
  }));
  return map;
};

/**
 * Display names for a set of user ids — who submitted, who approved. One
 * query per page. Users belong to user-service; this is a raw read, as
 * everywhere else in property-service.
 * @returns Map userId → name
 */
const namesByUserIds = async (sequelize, userIds = []) => {
  const ids = [...new Set(userIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return new Map();
  const rows = await safe('names', () => sequelize.query(
    'SELECT id, name, email FROM users WHERE id IN (:ids)',
    { replacements: { ids }, type: QueryTypes.SELECT },
  ), []);
  return new Map(rows.map((row) => [Number(row.id), row.name || row.email || `User #${row.id}`]));
};

module.exports = {
  planSummaryForUnits, rollUpPlans, listingSummary, moneyReceived,
  shareViewStats, myShareViews, namesByUserIds,
};

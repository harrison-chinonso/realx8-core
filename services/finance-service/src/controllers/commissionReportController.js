const asyncHandler = require('../utils/asyncHandler');
const { sequelize } = require('../models');
const { buildCompanyScope } = require('../utils/crudFactory');
const analytics = require('../../../../shared/src/commissionAnalytics');
const store = require('../../../../shared/src/commissionStore');

/**
 * What the engine has cost, what it still owes, and what it would pay a
 * realtor — plus the payout run itself (§8, FR-ANL-*, FR-PAY-*).
 *
 * ── Company scope is applied HERE and not left to the caller ────────────────
 *
 * Every function in commissionAnalytics takes a companyId and will happily
 * report across all of them when given none — which is correct for a platform
 * admin and a data leak for anybody else. The scope comes from
 * `buildCompanyScope`, the same helper the rest of finance uses, so a company
 * admin cannot widen it by passing a query parameter: a caller who HAS a
 * company gets theirs, and only a caller with none may ask for another.
 */

const companyOf = (req) => {
  const scope = buildCompanyScope(req);
  if (Object.prototype.hasOwnProperty.call(scope, 'company_id')) return scope.company_id;
  return req.query?.company_id ?? req.body?.company_id ?? null;
};

/** The window every report shares. */
const windowOf = (req) => ({
  companyId: companyOf(req),
  from: req.query.from || null,
  to: req.query.to || null,
});

const summary = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await analytics.summaryFor(sequelize, windowOf(req)) });
});

const breakage = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await analytics.breakageFor(sequelize, windowOf(req)) });
});

const costOfSale = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await analytics.costOfSaleFor(sequelize, windowOf(req)) });
});

const leaderboard = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await analytics.leaderboardFor(sequelize, windowOf(req)) });
});

const liability = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await analytics.liabilityFor(sequelize, windowOf(req)) });
});

const glExport = asyncHandler(async (req, res) => {
  const data = await analytics.glExportFor(sequelize, windowOf(req));
  /**
   * An unbalanced export is returned WITH its imbalance rather than refused.
   *
   * The accountant asking for it needs to see the figures to find out what is
   * wrong; a 500 would tell them only that something is. `balanced` is on the
   * payload precisely so a consumer cannot mistake one for the other.
   */
  res.json({ success: true, data });
});

/**
 * What a candidate plan would have cost over deals already closed (FR-SIM-001).
 *
 * A POST because the plan is a document in the body, not because anything is
 * written — the backtest writes nothing at all (FR-SIM-005).
 */
const backtest = asyncHandler(async (req, res) => {
  const plan = req.body?.plan || req.body?.config;
  if (!plan) {
    return res.status(400).json({ success: false, message: 'A candidate plan is required.' });
  }
  const data = await analytics.backtest(sequelize, { ...windowOf(req), plan });
  return res.json({ success: true, data });
});

// ── Payout runs ─────────────────────────────────────────────────────────────

const listPayouts = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const where = [];
  const replacements = {};
  if (companyId) { where.push('company_id = :companyId'); replacements.companyId = companyId; }
  if (req.query.status) { where.push('status = :status'); replacements.status = req.query.status; }
  if (req.query.realtor_id) { where.push('realtor_id = :realtorId'); replacements.realtorId = req.query.realtor_id; }

  const rows = await sequelize.query(
    `SELECT id, batch_ref, realtor_id, gross_minor, deductions_minor, recovered_minor,
            net_minor, status, approved_at, paid_at, payment_reference, created_at
       FROM commission_payouts
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC`,
    { replacements, type: require('sequelize').QueryTypes.SELECT },
  );
  res.json({ success: true, data: rows });
});

const buildPayouts = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const result = await store.buildPayoutsFor(sequelize, {
    companyId,
    batchRef: req.body?.batch_ref || null,
    periodStart: req.body?.period_start || null,
    periodEnd: req.body?.period_end || null,
    realtorIds: req.body?.realtor_ids || null,
    createdBy: req.user?.id ?? null,
  });
  res.json({ success: true, data: result });
});

const approve = asyncHandler(async (req, res) => {
  const result = await store.approvePayout(sequelize, req.params.id, { userId: req.user?.id ?? null });
  if (!result.approved) {
    return res.status(409).json({ success: false, message: 'Only a draft payout can be approved.' });
  }
  return res.json({ success: true, data: result });
});

const pay = asyncHandler(async (req, res) => {
  const result = await store.markPayoutPaid(sequelize, req.params.id, {
    reference: req.body?.reference || null,
    userId: req.user?.id ?? null,
  });
  if (result.skipped) {
    return res.status(409).json({ success: false, message: `Cannot pay: ${result.skipped}` });
  }
  return res.json({ success: true, data: result });
});

/**
 * A realtor's own statement (FR-PAY-008).
 *
 * Always the CALLER's own. A realtor asking for somebody else's earnings is not
 * a case this endpoint serves, and taking the id from the path would make the
 * authorisation a matter of remembering to check it.
 */
const myStatement = asyncHandler(async (req, res) => {
  const realtorId = req.user?.realtor_id ?? req.user?.id ?? null;
  if (!realtorId) {
    return res.status(400).json({ success: false, message: 'No realtor is attached to this account.' });
  }
  const data = await store.statementFor(sequelize, realtorId, {
    from: req.query.from || null,
    to: req.query.to || null,
  });
  return res.json({ success: true, data });
});

const statementFor = asyncHandler(async (req, res) => {
  const data = await store.statementFor(sequelize, req.params.realtorId, {
    from: req.query.from || null,
    to: req.query.to || null,
  });
  res.json({ success: true, data });
});

module.exports = {
  summary, breakage, costOfSale, leaderboard, liability, glExport, backtest,
  listPayouts, buildPayouts, approve, pay, myStatement, statementFor,
};

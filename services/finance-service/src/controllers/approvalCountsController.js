const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const { columnsOf, q } = require('../../../../shared/src/dialect');
const { buildCompanyScope } = require('../utils/crudFactory');
const asyncHandler = require('../utils/asyncHandler');

/**
 * How much is waiting on this person to approve, per queue, for the sidebar.
 *
 * ── One request, not one per queue ──────────────────────────────────────────
 *
 * The badges poll every minute from every open tab. Eight queues across three
 * services as eight list calls would be eight requests a minute per admin, most
 * of them 403s for anybody without every permission. The tables share one
 * database, and finance already reads property and user tables through raw SQL
 * (see commissionBridge), so the counts are read here in one pass.
 *
 * ── Each count is gated exactly as its APPROVE action is ────────────────────
 *
 * A badge means "this is waiting on you". So a count is returned only to
 * someone who could act on it — the permission or role the approve endpoint
 * itself checks — and is 0 otherwise. Someone who can view bills but not
 * approve them is not told bills are waiting on them. The "pending" definition
 * is the one the page and the approve endpoint use, so clicking the badge
 * lands on exactly those rows.
 *
 * ── Scoped to the caller's company ──────────────────────────────────────────
 *
 * buildCompanyScope, as everywhere else in finance: a company admin sees their
 * company's queues; a platform admin with no company sees every company's.
 * A company user with no company sees nothing rather than everybody's.
 *
 * Every count is independent and best effort. A table that does not exist yet
 * on an older database is a zero, not a failed sidebar.
 */

const holds = (req, permission) => {
  if (req.user?.isSuperiorAdmin || req.user?.type === 'superior_admin') return true;
  const held = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
  return held.includes('*') || held.includes(permission);
};

const actingType = (req) => req.user?.effectiveType || req.user?.type;

/** The realtor-review screens (KYC, level upgrades) are company-admin only. */
const isCompanyAdmin = (req) => !req.user?.isSuperiorAdmin
  && !!req.user?.company_id
  && ['admin', 'super_admin'].includes(actingType(req));

/** media approve/reject/publish are role-gated in user-service. */
const canApproveMedia = (req) => req.user?.isSuperiorAdmin
  || ['super_admin', 'admin', 'product_manager'].includes(actingType(req));

const softDeleted = async (table) => {
  const columns = await columnsOf(sequelize, table).catch(() => null);
  return columns?.has('deleted_at') ? ' AND deleted_at IS NULL' : '';
};

const count = async (sql, replacements) => {
  try {
    const [row] = await sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
    return Number(row?.n) || 0;
  } catch (error) {
    console.error(`[approval-counts] ${error.message}`);
    return 0;
  }
};

const getApprovalCounts = asyncHandler(async (req, res) => {
  const scope = buildCompanyScope(req);
  const scoped = Object.prototype.hasOwnProperty.call(scope, 'company_id');
  const companyId = scoped ? scope.company_id : null;

  // A company user whose company cannot be resolved sees nothing.
  const platform = req.user?.isSuperiorAdmin && !scoped;
  if (!platform && companyId == null) return res.json({ data: {} });

  const where = (alias = '') => (platform ? '' : ` AND ${alias}company_id = :companyId`);
  const replacements = { companyId };
  const tasks = {};

  if (holds(req, 'finance.commissions.manage')) {
    tasks.commissionPayouts = (async () => {
      // Realtors who asked to be paid on the engine and are not in a run yet —
      // the same test as pendingPayoutRequests.
      const requests = await count(
        `SELECT COUNT(DISTINCT e.realtor_id) AS n
           FROM commission_entitlements e
          WHERE e.payout_requested_at IS NOT NULL
            AND e.released_minor > e.paid_minor${where('e.')}
            AND NOT EXISTS (
              SELECT 1 FROM commission_payout_lines pl
                JOIN commission_payouts po ON po.id = pl.payout_id
               WHERE pl.entitlement_id = e.id AND po.status IN ('DRAFT', 'APPROVED')
            )`,
        replacements,
      );
      // Runs built and waiting for someone to approve them.
      const drafts = await count(
        `SELECT COUNT(*) AS n FROM commission_payouts WHERE status = 'DRAFT'${where()}`,
        replacements,
      );
      // Flat-rate commissions whose earner has asked to be paid.
      const flat = await count(
        `SELECT COUNT(*) AS n FROM commissions WHERE status = 'payment_requested'${where()}`,
        replacements,
      );
      return { total: requests + drafts + flat, requests, drafts, flat };
    })();
  }

  if (holds(req, 'finance.bills.approve')) {
    tasks.bills = count(
      `SELECT COUNT(*) AS n FROM bills WHERE status = 'pending_approval'${where()}`,
      replacements,
    );
  }

  // Refund approval rides on the note-approval permission (see the routes).
  if (holds(req, 'finance.notes.approve')) {
    tasks.refunds = count(
      `SELECT COUNT(*) AS n FROM refunds WHERE status = 'pending_approval'${where()}`,
      replacements,
    );
  }

  if (isCompanyAdmin(req)) {
    tasks.realtorVerifications = count(
      `SELECT COUNT(*) AS n FROM realtor_kyc WHERE ${q(sequelize, 'status')} = 'pending' AND company_id = :companyId`,
      { companyId: req.user.company_id },
    );
    tasks.levelRequests = count(
      `SELECT COUNT(*) AS n FROM realtor_level_requests WHERE status = 'pending' AND company_id = :companyId`,
      { companyId: req.user.company_id },
    );
  }

  if (holds(req, 'properties.inspections.manage')) {
    tasks.inspections = (async () => count(
      `SELECT COUNT(*) AS n FROM inspections
        WHERE approval_status = 'pending_approval'${where()}${await softDeleted('inspections')}`,
      replacements,
    ))();
  }

  if (holds(req, 'properties.approve')) {
    tasks.properties = (async () => count(
      `SELECT COUNT(*) AS n FROM properties
        WHERE approval_status = 'pending_review'${where()}${await softDeleted('properties')}`,
      replacements,
    ))();
  }

  if (canApproveMedia(req)) {
    tasks.mediaPosts = count(
      `SELECT COUNT(*) AS n FROM media_posts WHERE ${q(sequelize, 'status')} = 'review'${where()}`,
      replacements,
    );
  }

  const keys = Object.keys(tasks);
  const values = await Promise.all(keys.map((key) => tasks[key]));
  const data = {};
  keys.forEach((key, index) => {
    const value = values[index];
    if (typeof value === 'object') {
      data[key] = value.total;
      data[`${key}Detail`] = value;
    } else {
      data[key] = value;
    }
  });
  return res.json({ data });
});

module.exports = { getApprovalCounts };

const { QueryTypes } = require('sequelize');

const MAX_HOPS = 10;

/**
 * Who may look at another user's business and payment records.
 *
 * Lives in shared/ because two services answer this question — user-service for
 * the business summary, finance-service for invoices and payments — and they
 * must not drift apart. One rule, enforced server-side in both.
 *
 *   superior admin : anyone
 *   admin / staff  : users in their own company
 *   realtor        : anyone in their downline, at any depth
 *   everyone else  : nobody
 */

const one = async (sequelize, sql, replacements) => {
  const rows = await sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  return rows[0] || null;
};

/**
 * Walks up the referral chain from `targetId` looking for `rootId`.
 * The hop cap matches the referral tree's depth limit and doubles as a guard
 * against a corrupted realtor_id cycle spinning forever.
 */
const isInDownlineOf = async (sequelize, targetId, rootId) => {
  let current = Number(targetId);
  const seen = new Set([current]);
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const row = await one(sequelize, 'SELECT realtor_id FROM users WHERE id = :id AND deleted_at IS NULL', { id: current });
    const parent = row?.realtor_id ? Number(row.realtor_id) : null;
    if (!parent) return false;
    if (parent === Number(rootId)) return true;
    if (seen.has(parent)) return false;
    seen.add(parent);
    current = parent;
  }
  return false;
};

/** The target user, or null. Callers need company_id and type to decide. */
const loadTarget = (sequelize, targetId) => one(
  sequelize,
  `SELECT id, name, email, phone, type, company_id, realtor_id, created_at
     FROM users WHERE id = :id AND deleted_at IS NULL`,
  { id: targetId },
);

/**
 * Resolves whether `req.user` may view `targetId`.
 * Returns { ok, status, message, target } — never throws.
 */
const resolveViewableUser = async (sequelize, req, targetId) => {
  const viewerId = req?.user?.id;
  if (!viewerId) return { ok: false, status: 401, message: 'Unauthenticated' };

  const id = Number(targetId);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, status: 400, message: 'Invalid user id.' };
  }

  const target = await loadTarget(sequelize, id);
  if (!target) return { ok: false, status: 404, message: 'User not found.' };

  const role = req.user.effectiveType || req.user.type;
  const isSuperior = Boolean(req.user.isSuperiorAdmin);
  const isStaff = ['super_admin', 'admin'].includes(role);

  let allowed = false;
  // Everyone may look at their own records. This is what lets a client use the
  // same endpoint for "my invoices" that an admin uses to inspect theirs.
  if (Number(id) === Number(viewerId)) {
    allowed = true;
  } else if (isSuperior) {
    allowed = true;
  } else if (isStaff) {
    // A staff account with no company must not match every company: compare
    // explicitly rather than letting two nulls pass for each other.
    allowed = req.user.company_id != null && Number(target.company_id) === Number(req.user.company_id);
  } else if (role === 'realtor') {
    allowed = await isInDownlineOf(sequelize, id, viewerId);
  }

  if (!allowed) return { ok: false, status: 403, message: 'You cannot view this user.' };
  return { ok: true, target };
};

module.exports = { resolveViewableUser, isInDownlineOf };

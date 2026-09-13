const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize } = require('../models');
const { resolveViewableUser } = require('../../../../shared/src/viewerAccess');

/**
 * Referral relationships, built on users.realtor_id (the referrer).
 *
 * A person's account TYPE is users.type, but a user may hold several profiles
 * (see the dual realtor/client feature), so the profiles they can actually
 * operate under come from user_roles — that is what surfaces "this downline is
 * both a client and a realtor".
 */

const PROFILE_ROLES = ['client', 'realtor'];

/** Maps user id -> the realtor/client profiles they hold. */
const profilesFor = async (userIds) => {
  if (!userIds.length) return new Map();
  const rows = await sequelize.query(
    `SELECT ur.user_id, r.name
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id IN (:ids) AND r.name IN (:roles)`,
    { replacements: { ids: userIds, roles: PROFILE_ROLES }, type: QueryTypes.SELECT },
  );
  const map = new Map();
  rows.forEach((row) => {
    if (!map.has(row.user_id)) map.set(row.user_id, new Set());
    map.get(row.user_id).add(row.name);
  });
  return map;
};

const decorate = (rows, profileMap) => rows.map((row) => {
  const held = profileMap.get(row.id);
  // Fall back to the account type for users with no role rows.
  const profiles = held && held.size
    ? PROFILE_ROLES.filter((p) => held.has(p))
    : (PROFILE_ROLES.includes(row.type) ? [row.type] : []);
  return {
    ...row,
    profiles,
    has_both: profiles.includes('client') && profiles.includes('realtor'),
    level_name: row.type === 'realtor' ? row.level_name : null,
    kyc_status: row.type === 'realtor' ? (row.kyc_status || 'not_submitted') : null,
  };
});

const REFERRAL_FIELDS = `u.id, u.name, u.email, u.phone, u.type, u.is_active,
  u.created_at, u.realtor_code, u.realtor_id, l.name AS level_name, k.status AS kyc_status`;

// Joined everywhere REFERRAL_FIELDS is used, so level and verification appear
// consistently in every referral view.
const REFERRAL_JOINS = `LEFT JOIN realtor_levels l ON l.id = u.realtor_level_id
       LEFT JOIN realtor_kyc k ON k.user_id = u.id`;

/**
 * The full downline tree beneath a referrer, as nested `children`.
 *
 * Fetched one LEVEL at a time (not one query per node), so cost is O(depth)
 * rather than O(nodes). Both a depth and a total-node cap apply: realtor_id is
 * admin-editable so the graph can contain a cycle, and a large network could
 * otherwise return an unbounded payload. `truncated` says when a cap was hit,
 * so the UI can say so rather than silently showing a partial tree.
 */
const MAX_DEPTH = 10;
const MAX_NODES = 500;

const downlineTreeOf = async (rootId) => {
  const seen = new Set([Number(rootId)]);
  const collected = [];
  let frontier = [Number(rootId)];
  let truncated = false;

  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth += 1) {
    const rows = await sequelize.query(
      `SELECT ${REFERRAL_FIELDS}
         FROM users u
         ${REFERRAL_JOINS}
        WHERE u.realtor_id IN (:parents) AND u.deleted_at IS NULL
        ORDER BY u.created_at DESC`,
      { replacements: { parents: frontier }, type: QueryTypes.SELECT },
    );

    const fresh = rows.filter((row) => !seen.has(row.id));
    fresh.forEach((row) => seen.add(row.id));

    if (collected.length + fresh.length > MAX_NODES) {
      collected.push(...fresh.slice(0, MAX_NODES - collected.length));
      truncated = true;
      break;
    }

    collected.push(...fresh);
    frontier = fresh.map((row) => row.id);
    if (depth === MAX_DEPTH - 1 && frontier.length) truncated = true;
  }

  const decorated = decorate(collected, await profilesFor(collected.map((r) => r.id)));

  // Assemble the nesting from the flat set.
  const byId = new Map(decorated.map((person) => [person.id, { ...person, children: [] }]));
  const roots = [];
  byId.forEach((person) => {
    const parent = byId.get(person.realtor_id);
    if (parent) parent.children.push(person);
    else roots.push(person);        // direct child of the root
  });

  const countDescendants = (node) =>
    node.children.reduce((total, child) => total + 1 + countDescendants(child), 0);
  byId.forEach((node) => { node.downline_count = countDescendants(node); });

  return { tree: roots, total: decorated.length, truncated };
};

/**
 * The chain of referrers above a user, nearest first.
 * Depth-capped and cycle-guarded: realtor_id is editable, so a loop is possible.
 */
const uplineOf = async (userId, maxDepth = 10) => {
  const chain = [];
  const seen = new Set([Number(userId)]);
  let currentId = userId;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const rows = await sequelize.query(
      `SELECT ${REFERRAL_FIELDS}
         FROM users child
         JOIN users u ON u.id = child.realtor_id AND u.deleted_at IS NULL
         ${REFERRAL_JOINS}
        WHERE child.id = :currentId
        LIMIT 1`,
      { replacements: { currentId }, type: QueryTypes.SELECT },
    );
    const parent = rows[0];
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    chain.push(parent);
    currentId = parent.id;
  }

  return decorate(chain, await profilesFor(chain.map((r) => r.id)));
};

/** A realtor's own downline. */
const listMyReferrals = asyncHandler(async (req, res) => {
  const role = req.user?.effectiveType || req.user?.type;
  if (role !== 'realtor') {
    return res.status(403).json({ message: 'Only realtors have a referral list.' });
  }
  const { tree, total, truncated } = await downlineTreeOf(req.user.id);

  // Everything needed to build the realtor's share link. Registration requires
  // the company code, so both travel together.
  const [me] = await sequelize.query(
    `SELECT u.realtor_code, c.referral_code AS company_code
       FROM users u
       LEFT JOIN companies c ON c.id = u.company_id
      WHERE u.id = :id LIMIT 1`,
    { replacements: { id: req.user.id }, type: QueryTypes.SELECT },
  );

  res.json({
    data: tree,
    meta: {
      total,
      truncated,
      realtor_code: me?.realtor_code || null,
      company_code: me?.company_code || null,
    },
  });
});

/** Admin view of one realtor's referrals, both directions. */
const getRealtorReferrals = asyncHandler(async (req, res) => {
  const isStaff = req.user?.isSuperiorAdmin === true
    || ['admin', 'super_admin'].includes(req.user?.effectiveType || req.user?.type);
  if (!isStaff) {
    return res.status(403).json({ message: "Only an administrator can view a realtor's referrals." });
  }

  // Company-scoped unless the caller is a platform admin.
  const companyId = req.user?.isSuperiorAdmin ? null : (req.user?.company_id ?? null);
  if (!req.user?.isSuperiorAdmin && !companyId) {
    return res.status(400).json({ message: 'Your account is not linked to a company.' });
  }

  const rows = await sequelize.query(
    `SELECT ${REFERRAL_FIELDS}
       FROM users u
       ${REFERRAL_JOINS}
      WHERE u.id = :id AND u.type = 'realtor' AND u.deleted_at IS NULL
        ${companyId ? 'AND u.company_id = :companyId' : ''}
      LIMIT 1`,
    { replacements: { id: req.params.id, companyId }, type: QueryTypes.SELECT },
  );
  if (!rows.length) return res.status(404).json({ message: 'Realtor not found' });

  const [realtor] = decorate(rows, await profilesFor([rows[0].id]));
  const [upline, downline] = await Promise.all([uplineOf(realtor.id), downlineTreeOf(realtor.id)]);

  res.json({
    data: {
      realtor,
      upline,
      downline: downline.tree,
      downlineTotal: downline.total,
      truncated: downline.truncated,
    },
  });
});

/**
 * The clients a realtor is responsible for.
 *
 * Both "referred" (registered through the realtor's code) and "assigned" (an
 * admin linked them) write users.realtor_id, so that single column is the whole
 * relationship.
 *
 * Deliberately NOT widened to clients matched through CRM leads: realtors hold
 * crm.leads.create, so a lead's email is attacker-controlled. Matching on it
 * would let a realtor create a lead for any address and then read that client's
 * business and payment records. This list therefore shows exactly the clients
 * the drill-down endpoints will actually authorise.
 */
const listMyClients = asyncHandler(async (req, res) => {
  const acting = req.user?.effectiveType || req.user?.type;
  if (acting !== 'realtor') {
    return res.status(403).json({ message: 'Only realtors have a client list.' });
  }

  const realtorId = req.user.id;
  const companyId = req.user.company_id ?? null;

  const rows = await sequelize.query(
    `SELECT u.id, u.name, u.email, u.phone, u.is_active, u.created_at
       FROM users u
      WHERE u.type = 'client'
        AND u.deleted_at IS NULL
        AND u.realtor_id = :realtorId
        ${companyId ? 'AND u.company_id = :companyId' : ''}
      ORDER BY u.name`,
    { replacements: { realtorId, companyId }, type: QueryTypes.SELECT },
  );

  res.json({ data: rows });
});

/**
 * What one referral has earned this realtor, and what they bought.
 *
 * Commissions come from referral_transactions, the only table that records WHO
 * a commission was earned from — the generic `commissions` table the dashboard
 * totals from has no referral link, so it cannot answer "from this person".
 * Purchases come from the referral's own purchase requests.
 *
 * Authorised with the shared viewer rule, so a realtor reaches their downline
 * and nobody else. Commissions are additionally filtered to the caller as
 * referrer: seeing someone in your downline never shows another realtor's
 * earnings from them.
 */
const getReferralEarnings = asyncHandler(async (req, res) => {
  const access = await resolveViewableUser(sequelize, req, req.params.id);
  if (!access.ok) return res.status(access.status).json({ message: access.message });
  const { target } = access;

  const commissions = await sequelize.query(
    `SELECT id, amount, status, payment_date, created_at
       FROM referral_transactions
      WHERE referrer_id = :referrerId AND referred_id = :referredId
      ORDER BY id DESC`,
    { replacements: { referrerId: req.user.id, referredId: target.id }, type: QueryTypes.SELECT },
  );

  /**
   * The invoice is joined so the table can say whether the money arrived.
   *
   * `pr.status` is the SALES pipeline — pending / contacted / completed /
   * cancelled — which staff move by hand as they follow a buyer up. It says
   * nothing about payment, so a referral who had paid in full still showed as
   * "pending" next to the realtor's commission, and read as though nothing had
   * been collected.
   *
   * The paid figure is a correlated subquery rather than a JOIN with GROUP BY.
   * Grouping would mean naming every selected column in the GROUP BY to satisfy
   * Postgres, and getting that wrong is exactly the failure the client invoice
   * page hit.
   */
  const purchases = await sequelize.query(
    `SELECT pr.id, pr.property_id, p.name AS property_name, pr.unit_label, pr.unit_price,
            pr.quantity, pr.amount, pr.payment_mode, pr.status, pr.invoice_ref, pr.created_at,
            i.id AS invoice_id, i.amount AS invoice_amount, i.due_date, i.status AS invoice_status,
            COALESCE((SELECT SUM(ip.amount) FROM invoice_payments ip
                       WHERE ip.invoice_id = i.id AND ip.status = 'completed'), 0) AS paid
       FROM property_purchase_requests pr
       LEFT JOIN properties p ON p.id = pr.property_id
       LEFT JOIN invoices i ON i.id = pr.invoice_id
      WHERE pr.user_id = :referredId
      ORDER BY pr.id DESC`,
    { replacements: { referredId: target.id }, type: QueryTypes.SELECT },
  );

  /**
   * What the buyer actually owes on this purchase, in the same vocabulary the
   * client's own invoice views use — so "in progress" means the same thing to a
   * realtor as it does to the buyer.
   *
   * `unbilled` is its own answer rather than being folded into `pending`: a
   * purchase with no invoice behind it has not been billed at all, which is a
   * different thing from one that has been billed and not paid, and only one of
   * them is the buyer's move.
   */
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const paymentStateOf = (row) => {
    if (String(row.status) === 'cancelled') return 'cancelled';
    if (!row.invoice_id) return 'unbilled';
    const billed = Number(row.invoice_amount) || 0;
    const paid = Number(row.paid) || 0;
    if (paid >= billed && billed > 0) return 'paid';
    const dueDate = row.due_date ? new Date(row.due_date) : null;
    if (dueDate && dueDate < startOfToday) return 'due';
    return paid > 0 ? 'in_progress' : 'pending';
  };

  const sum = (rows, predicate = () => true) => rows
    .filter(predicate)
    .reduce((total, row) => total + (Number(row.amount) || 0), 0);

  res.json({
    data: {
      referral: { id: target.id, name: target.name, email: target.email, type: target.type },
      totals: {
        commission: {
          total: sum(commissions),
          paid: sum(commissions, (r) => r.status === 'paid'),
          /**
           * Anything not yet paid and not written off is still owed.
           *
           * This compared against 'pending', which the commission vocabulary
           * has not used since 'created' replaced it — so it silently summed
           * to zero and every referral reported nothing outstanding. Filtering
           * by what is NOT settled keeps this correct if the vocabulary grows
           * again.
           */
          unpaid: sum(commissions, (r) => !['paid', 'cancelled'].includes(String(r.status))),
          count: commissions.length,
        },
        purchases: {
          count: purchases.filter((r) => r.status !== 'cancelled').length,
          value: sum(purchases, (r) => r.status !== 'cancelled'),
        },
      },
      commissions: commissions.map((row) => ({ ...row, amount: Number(row.amount) || 0 })),
      purchases: purchases.map((row) => ({
        ...row,
        amount: Number(row.amount) || 0,
        unit_price: Number(row.unit_price) || 0,
        quantity: Number(row.quantity) || 0,
        // The pipeline status stays on the row as `status`; these are about money.
        invoice_amount: Number(row.invoice_amount) || 0,
        paid: Number(row.paid) || 0,
        balance: Math.max((Number(row.invoice_amount) || 0) - (Number(row.paid) || 0), 0),
        payment_state: paymentStateOf(row),
      })),
    },
  });
});

module.exports = {
  getReferralEarnings,
  listMyClients, listMyReferrals, getRealtorReferrals };

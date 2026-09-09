const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize } = require('../models');
const { resolveViewableUser } = require('../../../../shared/src/viewerAccess');

/**
 * Role-scoped dashboard summaries for realtors and clients.
 *
 * Deliberately one endpoint doing read-only aggregation across the shared
 * database rather than a client-side fan-out: the admin dashboard's approach
 * calls a dozen list endpoints, most of which a realtor or client is not
 * permitted to hit. Every query below is bound to the caller's own id.
 */

const one = async (sql, replacements) => {
  const rows = await sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  return rows[0] || {};
};

const many = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

const num = (value) => Number(value || 0);

/** Commission/transaction status in the vocabulary the dashboard uses. */
const displayStatus = (status) => {
  const s = String(status || '').toLowerCase();
  if (s === 'cancelled' || s === 'rejected' || s === 'failed') return 'declined';
  if (s === 'paid' || s === 'approved' || s === 'completed') return 'approved';
  return s || 'pending';
};

const realtorSummary = async (userId, companyId) => {
  // Everyone this realtor brought in — clients and realtors alike.
  const referrals = await one(
    `SELECT
        COUNT(*) AS n,
        COUNT(CASE WHEN type = 'client' THEN 1 END) AS clients,
        COUNT(CASE WHEN type = 'realtor' THEN 1 END) AS realtors
       FROM users WHERE realtor_id = :userId AND deleted_at IS NULL`,
    { userId },
  );

  const leads = await one(
    'SELECT COUNT(*) AS n FROM leads WHERE assigned_to = :userId OR created_by = :userId',
    { userId },
  );

  const deals = await one(
    'SELECT COUNT(*) AS n FROM deals WHERE assigned_to = :userId OR created_by = :userId',
    { userId },
  );

  const inspectionRows = await many(
    'SELECT status, COUNT(*) AS n FROM inspections WHERE realtor_id = :userId GROUP BY status',
    { userId },
  );
  const inspections = inspectionRows.reduce(
    (acc, row) => { acc.byStatus[row.status] = num(row.n); acc.total += num(row.n); return acc; },
    { total: 0, byStatus: {} },
  );

  const tickets = await one(
    `SELECT COUNT(*) AS n FROM support_tickets
      WHERE (user_id = :userId OR assigned_to = :userId) AND status IN ('open', 'in_progress')`,
    { userId },
  );

  // Purchases made by this realtor's referred clients.
  const purchases = await one(
    `SELECT COUNT(*) AS n, COALESCE(SUM(pr.amount), 0) AS total
       FROM property_purchase_requests pr
       JOIN users u ON u.id = pr.user_id AND u.realtor_id = :userId
      WHERE pr.status <> 'cancelled'`,
    { userId },
  );

  const commission = await one(
    `SELECT
        COALESCE(SUM(amount), 0) AS total,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) AS paid,
        COALESCE(SUM(CASE WHEN status IN ('pending', 'approved') THEN amount ELSE 0 END), 0) AS unpaid
       FROM commissions WHERE employee_id = :userId`,
    { userId },
  );

  const history = await many(
    `SELECT id, created_at AS date, amount, status, title
       FROM commissions WHERE employee_id = :userId
      ORDER BY id DESC LIMIT 10`,
    { userId },
  );

  // The level ladder is owned by user-service, so this reads its own tables.
  const level = await one(
    `SELECT l.id, l.name, l.commission_percentage
       FROM users u
       JOIN realtor_levels l ON l.id = u.realtor_level_id
      WHERE u.id = :userId`,
    { userId },
  );

  return {
    role: 'realtor',
    level: level?.id ? { id: level.id, name: level.name, commission_percentage: level.commission_percentage } : null,
    referrals: {
      total: num(referrals.n),
      clients: num(referrals.clients),
      realtors: num(referrals.realtors),
    },
    leads: num(leads.n),
    deals: num(deals.n),
    inspections,
    activeTickets: num(tickets.n),
    clientPurchases: { count: num(purchases.n), value: num(purchases.total) },
    commission: {
      total: num(commission.total),
      paid: num(commission.paid),
      unpaid: num(commission.unpaid),
    },
    transactions: history.map((row) => ({
      id: row.id,
      date: row.date,
      amount: num(row.amount),
      title: row.title || 'Commission',
      status: displayStatus(row.status),
    })),
  };
};

const clientSummary = async (userId) => {
  const invoices = await one(
    `SELECT
        COUNT(*) AS n,
        COALESCE(SUM(amount), 0) AS total,
        COUNT(CASE WHEN status = 'paid' THEN 1 END) AS paid_count,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) AS paid_total,
        COUNT(CASE WHEN status <> 'paid' AND status <> 'cancelled' THEN 1 END) AS unpaid_count,
        COALESCE(SUM(CASE WHEN status <> 'paid' AND status <> 'cancelled' THEN amount ELSE 0 END), 0) AS unpaid_total
       FROM invoices WHERE client_id = :userId`,
    { userId },
  );

  // Soonest upcoming due date on anything still owing.
  const nextDue = await one(
    `SELECT MIN(due_date) AS next_due FROM invoices
      WHERE client_id = :userId AND status NOT IN ('paid', 'cancelled') AND due_date IS NOT NULL`,
    { userId },
  );

  const tickets = await one(
    `SELECT COUNT(*) AS n FROM support_tickets
      WHERE user_id = :userId AND status IN ('open', 'in_progress')`,
    { userId },
  );

  const purchases = await one(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total
       FROM property_purchase_requests
      WHERE user_id = :userId AND status <> 'cancelled'`,
    { userId },
  );

  const history = await many(
    `SELECT id, created_at AS date, amount, status, description
       FROM transactions WHERE user_id = :userId
      ORDER BY id DESC LIMIT 10`,
    { userId },
  );

  return {
    role: 'client',
    invoices: {
      count: num(invoices.n),
      value: num(invoices.total),
      nextDueDate: nextDue.next_due || null,
      paid: { count: num(invoices.paid_count), value: num(invoices.paid_total) },
      unpaid: { count: num(invoices.unpaid_count), value: num(invoices.unpaid_total) },
    },
    activeTickets: num(tickets.n),
    purchases: { count: num(purchases.n), value: num(purchases.total) },
    transactions: history.map((row) => ({
      id: row.id,
      date: row.date,
      amount: num(row.amount),
      title: row.description || 'Transaction',
      status: displayStatus(row.status),
    })),
  };
};


/**
 * The same business summary the owner sees, for a user someone else selected.
 *
 * Authorisation comes from shared/src/viewerAccess so this and the finance
 * payment analysis can never disagree about who may look at whom.
 */
const getUserSummary = asyncHandler(async (req, res) => {
  const access = await resolveViewableUser(sequelize, req, req.params.id);
  if (!access.ok) return res.status(access.status).json({ message: access.message });

  const { target } = access;
  const extra = await one(
    `SELECT l.name AS level_name, l.commission_percentage, k.status AS kyc_status
       FROM users u
       LEFT JOIN realtor_levels l ON l.id = u.realtor_level_id
       LEFT JOIN realtor_kyc k ON k.user_id = u.id
      WHERE u.id = :id`,
    { id: target.id },
  );

  const summary = target.type === 'realtor'
    ? await realtorSummary(target.id, target.company_id ?? null)
    : target.type === 'client'
      ? await clientSummary(target.id)
      : null;

  if (!summary) {
    return res.status(400).json({ message: 'Business summaries exist only for realtors and clients.' });
  }

  return res.json({
    data: {
      user: {
        id: target.id,
        name: target.name,
        email: target.email,
        phone: target.phone,
        type: target.type,
        created_at: target.created_at,
        level_name: extra?.level_name || null,
        commission_percentage: extra?.commission_percentage ?? null,
        // Clients have no verification; null keeps the badge from rendering.
        kyc_status: target.type === 'realtor' ? (extra?.kyc_status || 'not_submitted') : null,
      },
      summary,
    },
  });
});

const getSummary = asyncHandler(async (req, res) => {
  // Follows the ACTIVE profile, so a realtor switched to their client profile
  // gets the client dashboard.
  const role = req.user?.effectiveType || req.user?.type;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthenticated' });

  if (role === 'realtor') return res.json({ data: await realtorSummary(userId, req.user?.company_id ?? null) });
  if (role === 'client') return res.json({ data: await clientSummary(userId) });

  // Staff keep the existing admin dashboard.
  return res.json({ data: { role: role || null } });
});

module.exports = { getSummary, getUserSummary };

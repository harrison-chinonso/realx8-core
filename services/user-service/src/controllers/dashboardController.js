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
  if (s === 'paid' || s === 'approved' || s === 'completed' || s === 'verified') return 'approved';
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
        COALESCE(SUM(CASE WHEN status IN ('created', 'payment_requested', 'approved')
                         THEN amount ELSE 0 END), 0) AS unpaid
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

/**
 * A draft invoice does not exist as far as the buyer is concerned.
 *
 * Draft means "raised but not yet issued", and every other client-facing
 * surface already hides them — invoiceScope drops them for a self-scoped
 * caller, and so does the payment-analysis endpoint. This summary did not, so a
 * client was shown a count and a total that included invoices they could not
 * open, and a "Pay Now" built on that count could offer to settle something the
 * picker was never going to list.
 */
const ISSUED_ONLY = "status <> 'draft'";

const clientSummary = async (userId) => {
  const invoices = await one(
    `SELECT
        COUNT(*) AS n,
        COALESCE(SUM(amount), 0) AS total,
        COUNT(CASE WHEN status = 'paid' THEN 1 END) AS paid_count,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) AS paid_total,
        COUNT(CASE WHEN status <> 'paid' AND status <> 'cancelled' THEN 1 END) AS unpaid_count,
        COALESCE(SUM(CASE WHEN status <> 'paid' AND status <> 'cancelled' THEN amount ELSE 0 END), 0) AS unpaid_total
       FROM invoices WHERE client_id = :userId AND ${ISSUED_ONLY}`,
    { userId },
  );

  // Soonest upcoming due date on anything still owing.
  const nextDue = await one(
    `SELECT MIN(due_date) AS next_due FROM invoices
      WHERE client_id = :userId AND status NOT IN ('paid', 'cancelled')
        AND ${ISSUED_ONLY} AND due_date IS NOT NULL`,
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

  /**
   * The buyer's own payments — read from `receipts`, not `transactions`.
   *
   * A `transactions` row is only written when a payment is APPROVED. So a buyer
   * who submitted proof of payment an hour ago saw an empty dashboard and no
   * evidence the platform had received anything, which reads as "my payment did
   * not go through" at exactly the moment reassurance matters most. They then
   * pay again, or call support.
   *
   * `receipts` is the buyer's side of the same event and exists from the moment
   * they submit: pending while an admin decides, verified once approved,
   * rejected with a reason, cancelled if they withdrew it. Every status is
   * returned — the point is that the payment is visible BEFORE it is approved,
   * so filtering to approved ones would reintroduce the whole problem.
   *
   * `description` is built here rather than stored: a receipt has no
   * description column, and what a buyer wants to see is which invoice it was
   * against and how they paid.
   */
  const history = await many(
    `SELECT r.id,
            r.created_at AS date,
            r.amount,
            r.status,
            r.payment_method,
            r.receipt_number,
            r.rejection_reason,
            i.invoice_id AS invoice_ref,
            p.name AS property_name,
            pu.name AS unit_name
       FROM receipts r
       LEFT JOIN invoices i ON i.id = r.invoice_id
       LEFT JOIN properties p ON p.id = i.property_id
       /*
        * The unit comes through the invoice's payment plan, which is where a
        * purchase records WHICH configuration was bought. There is no unit on
        * the invoice itself — an invoice is for an amount, and the thing it
        * bought is one join further out.
        */
       LEFT JOIN invoice_payment_plans ipp ON ipp.invoice_id = i.id
       LEFT JOIN property_units pu ON pu.id = ipp.property_unit_id
      WHERE r.client_id = :userId
      ORDER BY r.id DESC LIMIT 10`,
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
    /**
     * Still called `transactions` on the wire.
     *
     * Renaming the field would break every client that has not been redeployed
     * alongside this — and the dashboard is the first screen a buyer sees, so a
     * blank panel there is the most visible possible failure. `payments` is
     * sent alongside under its accurate name; the old key is an alias of it and
     * can be dropped once nothing reads it.
     */
    transactions: history.map(toPaymentRow),
    payments: history.map(toPaymentRow),
  };
};

/**
 * One submitted payment, as the dashboard shows it.
 *
 * A rejected payment carries its reason into the title: being told a payment
 * was declined without being told why is worse than not being told at all,
 * because there is no action the buyer can take from it.
 */
const toPaymentRow = (row) => {
  /**
   * What the payment was FOR, in the buyer's own terms.
   *
   * "INV-0012" is the company's reference for its own paperwork; a buyer knows
   * what they bought by the estate and the plot. Naming the invoice made them
   * match a code they had never memorised against a list of codes. The property
   * and unit are what they recognise, and the reference is still carried on the
   * row for anyone quoting it to support.
   */
  const unit = [row.property_name, row.unit_name].filter(Boolean).join(' · ');
  const against = unit || (row.invoice_ref ? `Invoice ${row.invoice_ref}` : 'Payment');

  const method = row.payment_method ? ` · ${row.payment_method}` : '';
  const declined = String(row.status) === 'rejected' && row.rejection_reason
    ? ` — ${row.rejection_reason}`
    : '';

  return {
    id: row.id,
    date: row.date,
    amount: num(row.amount),
    title: `${against}${method}${declined}`,
    property_name: row.property_name || null,
    unit_name: row.unit_name || null,
    reference: row.receipt_number || null,
    invoice_ref: row.invoice_ref || null,
    // `verified` is the stored value; `approved` is the word a buyer uses.
    status: displayStatus(row.status),
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

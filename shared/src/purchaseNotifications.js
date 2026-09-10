const { QueryTypes } = require('sequelize');
const { createNotifier } = require('./notifier');
const { resolveNotificationConfig } = require('./notificationConfig');
const { asMinor, toMajor } = require('./money');

/**
 * Dispatching the purchase-journey notifications (FRD 12).
 *
 * Sits on top of notifier.js — which already knows how to write an in-app row,
 * send the mail and resolve a client's realtor — and adds the two things FRD 12
 * asks for that notifier.js has no opinion about: whether an event fires for a
 * given company at all, and the content every payment notification must carry
 * (FRD 12.3).
 *
 * Every function here is BEST EFFORT and never throws, for the same reason
 * notifier.js is not: a notification failure must not roll back a payment. The
 * callers dispatch after their transaction has committed.
 */
const createPurchaseNotifier = (sequelize) => {
  const { notifyUser, findRealtorForClient } = createNotifier(sequelize);

  /** The company's admins — the review queue and the FRD 12.2 admin column. */
  const findAdmins = async (companyId) => {
    try {
      return await sequelize.query(
        `SELECT id FROM users
          WHERE type IN ('admin', 'super_admin')
            AND is_active = 1 AND deleted_at IS NULL
            AND company_id ${companyId ? '= :companyId' : 'IS NULL'}
          LIMIT 20`,
        { replacements: { companyId }, type: QueryTypes.SELECT },
      );
    } catch (error) {
      console.error('[notify] admin lookup failed:', error.message);
      return [];
    }
  };

  /**
   * Everything FRD 12.3 requires a payment notification to be able to state:
   * property and unit, invoice reference, amount due and due date.
   *
   * One query, because the alternative is every event assembling its own and
   * some of them forgetting the unit — which is the field a client most needs
   * when they hold invoices on two plots of the same estate.
   */
  const contextFor = async (invoiceId) => {
    try {
      const rows = await sequelize.query(
        `SELECT i.id, i.invoice_id, i.client_id, i.company_id, i.status, i.due_date, i.amount,
                p.name AS property_name,
                pu.name AS unit_name,
                ipp.quantity, ipp.total_minor, ipp.payment_type, ipp.snapshot_plan_name,
                u.name AS client_name, u.email AS client_email
           FROM invoices i
           LEFT JOIN invoice_payment_plans ipp ON ipp.invoice_id = i.id
           LEFT JOIN property_units pu ON pu.id = ipp.property_unit_id
           LEFT JOIN properties p ON p.id = i.property_id
           LEFT JOIN users u ON u.id = i.client_id
          WHERE i.id = :invoiceId LIMIT 1`,
        { replacements: { invoiceId }, type: QueryTypes.SELECT },
      );
      return rows[0] || null;
    } catch (error) {
      console.error('[notify] invoice context lookup failed:', error.message);
      return null;
    }
  };

  /** "GPT, Lekki — Half plot x 2", or as much of it as is known. */
  const describeSubject = (context) => [
    context?.property_name,
    context?.unit_name && `${context.unit_name}${context.quantity > 1 ? ` x ${context.quantity}` : ''}`,
  ].filter(Boolean).join(' — ') || 'your purchase';

  /**
   * Sends one event to whoever the company's configuration says should hear it.
   *
   * `body` is a function of recipient role, not a string: the same event reads
   * differently to the three audiences. "Your payment was approved" is wrong in
   * a realtor's inbox, and FRD 12.2's intent for the realtor — engage the
   * client and drive collection — needs the client named.
   */
  const dispatch = async ({
    eventKey, invoiceId, context = null, title, body, type, data = null,
    actionLabel = null, actionUrl = null,
  }) => {
    try {
      const ctx = context || (invoiceId ? await contextFor(invoiceId) : null);
      const companyId = ctx?.company_id ?? null;
      const config = (await resolveNotificationConfig(sequelize, companyId))(eventKey);
      if (!config.enabled) return { skipped: 'disabled' };

      const send = (userId, role) => notifyUser({
        userId,
        title: typeof title === 'function' ? title(role, ctx) : title,
        body: typeof body === 'function' ? body(role, ctx) : body,
        type,
        data: { event: eventKey, invoice_id: ctx?.id ?? invoiceId ?? null, ...(data || {}) },
        companyId,
        actionLabel,
        actionUrl,
      });

      const sends = [];
      if (config.client && ctx?.client_id) sends.push(send(ctx.client_id, 'client'));

      if (config.realtor && ctx?.client_email) {
        // Resolved through the existing rule, which returns nobody rather than
        // risk telling an unrelated realtor about a client's purchase. Where no
        // realtor is assigned the notification simply omits that recipient
        // (FRD 12.2) — it is not an error.
        const realtorId = await findRealtorForClient({
          email: ctx.client_email, companyId, userId: ctx.client_id,
        });
        if (realtorId) sends.push(send(realtorId, 'realtor'));
      }

      if (config.admin) {
        const admins = await findAdmins(companyId);
        admins.forEach((admin) => sends.push(send(admin.id, 'admin')));
      }

      await Promise.all(sends);
      return { sent: sends.length };
    } catch (error) {
      console.error(`[notify] ${eventKey} dispatch failed:`, error.message);
      return { failed: error.message };
    }
  };

  const money = (minor) => Number(toMajor(asMinor(minor))).toLocaleString('en-NG');
  const onDate = (value) => (value ? new Date(value).toDateString() : null);

  return {
    dispatch,
    contextFor,
    describeSubject,
    findAdmins,
    findRealtorForClient,
    money,
    onDate,
  };
};

module.exports = { createPurchaseNotifier };

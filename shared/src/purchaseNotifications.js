const { QueryTypes } = require('sequelize');
const { createDispatcher } = require('./notificationDispatcher');
const { asMinor, toMajor } = require('./money');

/**
 * The finance-facing face of the notification dispatcher.
 *
 * Adds the two things the purchase journey needs and the general dispatcher has
 * no business knowing: how to load an invoice's context in one query, and the
 * money/date formatting its messages are written in.
 *
 * It also presents the recipient roles under finance's own names. The general
 * dispatcher speaks of 'subject' and 'permission' because it serves every
 * module — a media post's subject is its author, a KYC submission's is the
 * applicant. In finance the subject IS the buyer, so the callers here read
 * `role === 'client'`, which is clearer than a generic word would be at those
 * call sites.
 */
const ROLE_NAMES = { subject: 'client', realtor: 'realtor', permission: 'admin' };

const createPurchaseNotifier = (sequelize) => {
  const dispatcher = createDispatcher(sequelize);

  /**
   * Everything a payment notification has to be able to state: property and
   * unit, invoice reference, amount due and due date.
   *
   * One query, because the alternative is every event assembling its own and
   * some of them forgetting the unit — the field a client most needs when they
   * hold invoices on two plots of the same estate.
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
   * Dispatches an invoice-scoped event.
   *
   * Takes `invoiceId` and derives the subject and company from it, so callers
   * do not repeat that. Recipients themselves come from configuration — this
   * function decides nothing about who is told.
   */
  const dispatch = async ({
    eventKey, invoiceId, context = null, title, body, type, data = null,
    actionLabel = null, actionUrl = null,
  }) => {
    const ctx = context || (invoiceId ? await contextFor(invoiceId) : null);

    // The invoice context is flattened into the top level of what the callers'
    // title/body functions receive, because they were written against it
    // directly (ctx.invoice_id, ctx.client_name).
    const withRoleName = (fn) => (fn === undefined ? undefined
      : (role, general) => (typeof fn === 'function'
        ? fn(ROLE_NAMES[role] || role, { ...(general?.subject || {}), ...(ctx || {}) })
        : fn));

    return dispatcher.dispatch({
      eventKey,
      subjectUserId: ctx?.client_id ?? null,
      companyId: ctx?.company_id ?? null,
      context: ctx || {},
      title: withRoleName(title),
      body: withRoleName(body),
      type,
      data: { invoice_id: ctx?.id ?? invoiceId ?? null, ...(data || {}) },
      actionLabel,
      actionUrl,
    });
  };

  const money = (minor) => Number(toMajor(asMinor(minor))).toLocaleString('en-NG');
  const onDate = (value) => (value ? new Date(value).toDateString() : null);

  return {
    dispatch,
    contextFor,
    describeSubject,
    money,
    onDate,
    findRealtorForClient: dispatcher.findRealtorForClient,
    notifyUser: dispatcher.notifyUser,
  };
};

module.exports = { createPurchaseNotifier };

const asyncHandler = require('../utils/asyncHandler');
const { buildCrudController, buildCompanyScope, withCompanyAudit } = require('../utils/crudFactory');
const {
  Support,
  SupportReply,
  Visitor,
  Attendance,
  VipClient,
  CommunicationLog,
  CareAlert,
} = require('../models');

const companyScope = (req) => buildCompanyScope(req);

/**
 * A ticket belongs to the person who raised it.
 *
 * ── Why this is not just company scope ─────────────────────────────────────
 *
 * Every role that can open Support Centre holds `support.view`, clients and
 * realtors included — so scoping the list by COMPANY alone showed a customer
 * every other customer's ticket: their subject line, their complaint and the
 * whole reply thread. Permission was never going to fix that, because the
 * permission is exactly the one they are supposed to have.
 *
 * Staff still see the company's queue; that is what the queue is for. The same
 * split invoiceScope makes in finance, for the same reason.
 */
const isSelfScoped = (req) => {
  const acting = req.user?.effectiveType || req.user?.type;
  return !req.user?.isSuperiorAdmin && ['client', 'realtor'].includes(acting);
};

const ticketScope = (req) => {
  const base = companyScope(req);
  // Plain key, deliberately: crudFactory spreads the search filter over this
  // object, so an Op.or here would be silently overwritten.
  return isSelfScoped(req) ? { ...base, user_id: req.user.id } : base;
};

/**
 * Whose ticket this is.
 *
 * A client or realtor raising a ticket IS the customer, so the `user_id` they
 * were made to supply is only ever their own id. Requiring it in the body meant
 * self-service tickets died on `422 Validation failed` with every visible field
 * filled in — because the missing field was not on the form.
 *
 * Self-scoped callers are pinned to their own id rather than trusted with the
 * body value. ticketScope reads user_id to decide who may see a ticket, so
 * honouring a client-supplied one would let a customer file a ticket in another
 * customer's name and then lose sight of it. Staff raising one on somebody's
 * behalf may still name the user; they hold the whole queue either way.
 */
const ticketOwnerId = (req) => (
  isSelfScoped(req)
    ? req.user.id
    : (Number(req.body?.user_id) || req.user?.id || null)
);

const { sequelize } = require('../config/database');
const { createDispatcher } = require('../../../../shared/src/notificationDispatcher');
const { appUrl } = require('../../../../shared/src/appOrigin');
// Recipients come from configuration, not from these call sites.
const notify = createDispatcher(sequelize);

/**
 * Next reference in a prefixed sequence, e.g. INV-0007.
 *
 * Derived from the HIGHEST number in use, not from the newest row. Reading only
 * the newest row reissued a number that already existed whenever the last row
 * was deleted, or whenever any reference did not end in digits — and these
 * columns are uniquely indexed, so the insert then failed.
 */
const buildSequence = async (Model, field, prefix) => {
  const rows = await Model.findAll({ attributes: [field], raw: true });
  const highest = rows.reduce((max, row) => {
    const value = String(row?.[field] ?? '');
    if (!value.startsWith(prefix)) return max;
    const suffix = Number(value.slice(prefix.length));
    return Number.isInteger(suffix) && suffix > max ? suffix : max;
  }, 0);
  return `${prefix}${String(highest + 1).padStart(4, '0')}`;
};

const toAttendanceStatus = ({ status, date, check_in }) => {
  if (status === 'absent') return 'absent';
  if (check_in && date) {
    const checkInDate = new Date(check_in);
    const lateThreshold = new Date(`${date}T09:00:00`);
    if (!Number.isNaN(checkInDate.getTime()) && checkInDate.getTime() > lateThreshold.getTime()) {
      return 'late';
    }
  }
  return status === 'late' ? 'late' : 'present';
};

const toVipTier = (totalAmount) => (Number(totalAmount || 0) >= 10000000 ? 'platinum' : 'gold');

const supportCrud = buildCrudController(Support, {
  include: ['replies'], searchFields: ['subject', 'status', 'priority'],
  defaultWhere: ticketScope, scopeWhere: ticketScope,
  beforeCreate: (req) => withCompanyAudit(req, { ...req.body, user_id: ticketOwnerId(req) }),
  /**
   * Was silent — a ticket could be raised with nobody told, so it was found
   * only by someone opening the queue. Reaches whoever holds support.manage.
   */
  afterCreate: async (ticket, req) => {
    notify.dispatch({
      eventKey: 'support_ticket_created',
      subjectUserId: ticket.created_by ?? null,
      companyId: ticket.company_id ?? null,
      context: { ticket },
      title: () => `Support ticket raised — ${ticket.subject || `#${ticket.id}`}`,
      body: (role, ctx) => (role === 'subject'
        ? `Your ticket "${ticket.subject || ticket.id}" has been logged. Someone will pick it up shortly.`
        : `${ctx.subject?.name || 'Someone'} raised a ${ticket.priority || 'normal'}-priority ticket: `
          + `"${ticket.subject || ticket.id}".`),
      data: { support_id: ticket.id },
      actionLabel: 'View ticket',
      actionUrl: appUrl('support', req),
    }).catch(() => {});
    return ticket;
  },
});

const visitorCrud = buildCrudController(Visitor, {
  searchFields: ['pass_number', 'full_name', 'phone', 'purpose', 'host_name', 'status'],
  defaultWhere: companyScope, scopeWhere: companyScope,
  beforeCreate: async (req) => withCompanyAudit(req, {
    pass_number: await buildSequence(Visitor, 'pass_number', 'VISIT-'),
    full_name: req.body.full_name,
    phone: req.body.phone,
    email: req.body.email || null,
    purpose: req.body.purpose,
    host_name: req.body.host_name,
    note: req.body.note || null,
    check_in: new Date(),
    status: 'in',
  }),
});

const attendanceCrud = buildCrudController(Attendance, {
  searchFields: ['employee_name', 'employee_role', 'status', 'date'],
  defaultWhere: companyScope, scopeWhere: companyScope,
  beforeCreate: async (req) => withCompanyAudit(req, {
    employee_name: req.body.employee_name,
    employee_role: req.body.employee_role || null,
    check_in: req.body.check_in || null,
    check_out: req.body.check_out || null,
    date: req.body.date,
    status: toAttendanceStatus(req.body),
  }),
});

const vipCrud = buildCrudController(VipClient, {
  searchFields: ['client_name', 'email', 'phone', 'tier', 'status'],
  defaultWhere: companyScope, scopeWhere: companyScope,
  beforeCreate: async (req) => withCompanyAudit(req, {
    client_id: req.body.client_id || null,
    client_name: req.body.client_name,
    email: req.body.email || null,
    phone: req.body.phone || null,
    total_amount: req.body.total_amount || 0,
    investment_count: req.body.investment_count || 0,
    tier: toVipTier(req.body.total_amount),
    status: req.body.status || 'active',
    notes: req.body.notes || null,
  }),
  beforeUpdate: async (req) => ({
    client_id: req.body.client_id || null,
    client_name: req.body.client_name,
    email: req.body.email || null,
    phone: req.body.phone || null,
    total_amount: req.body.total_amount || 0,
    investment_count: req.body.investment_count || 0,
    tier: toVipTier(req.body.total_amount),
    status: req.body.status || 'active',
    notes: req.body.notes || null,
  }),
});

const communicationCrud = buildCrudController(CommunicationLog, {
  searchFields: ['client_name', 'type', 'message', 'delivery_status'],
  defaultWhere: companyScope, scopeWhere: companyScope,
  beforeCreate: async (req) => {
    const sendNow = Boolean(req.body.send_now);
    return withCompanyAudit(req, {
      client_name: req.body.client_name,
      type: req.body.type || 'custom',
      message: req.body.message,
      sent_at: sendNow ? new Date() : null,
      delivery_status: sendNow ? 'sent' : (req.body.delivery_status || 'pending'),
      scheduled_at: sendNow ? null : (req.body.scheduled_at || null),
    });
  },
});

const alertCrud = buildCrudController(CareAlert, {
  searchFields: ['client_name', 'alert_type', 'message', 'status'],
  defaultWhere: companyScope, scopeWhere: companyScope,
  beforeCreate: async (req) => withCompanyAudit(req, {
    client_name: req.body.client_name,
    alert_type: req.body.alert_type,
    trigger_date: req.body.trigger_date,
    message: req.body.message,
    status: req.body.status || 'pending',
  }),
  afterCreate: async (alert, req) => {
    notify.dispatch({
      eventKey: 'care_alert_raised',
      companyId: alert.company_id ?? null,
      context: { alert },
      title: () => 'Customer care alert',
      body: () => `A ${alert.severity || 'new'} care alert has been raised`
        + `${alert.title ? `: "${alert.title}"` : ''}.`,
      data: { care_alert_id: alert.id },
      actionLabel: 'View care alerts',
      actionUrl: appUrl('care/alerts', req),
    }).catch(() => {});
    return alert;
  },
});

const getReplies = asyncHandler(async (req, res) => {
  // ticketScope, not companyScope: hiding a ticket from the list and then
  // serving its whole conversation by id would be no protection at all.
  const ticket = await Support.findOne({ where: { id: req.params.id, ...ticketScope(req) } });
  if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
  const replies = await SupportReply.findAll({ where: { support_id: req.params.id, company_id: ticket.company_id }, order: [['id', 'ASC']] });
  res.json({ data: replies });
});

const addReply = asyncHandler(async (req, res) => {
  const ticket = await Support.findOne({ where: { id: req.params.id, ...ticketScope(req) } });
  if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
  // The author of a reply is whoever sent it — there is no posting on another
  // person's behalf here. Taking it from the body made the caller state a fact
  // the request already carries, and a customer replying to their own ticket
  // had no field to state it with.
  const reply = await SupportReply.create({
    support_id: ticket.id,
    ...req.body,
    user_id: req.user?.id ?? null,
    company_id: ticket.company_id,
  });

  notify.dispatch({
    eventKey: 'support_ticket_replied',
    subjectUserId: ticket.created_by ?? null,
    companyId: ticket.company_id ?? null,
    context: { ticket, reply },
    title: () => `Reply on your ticket — ${ticket.subject || `#${ticket.id}`}`,
    body: (role) => (role === 'subject'
      ? `There is a new reply on your ticket "${ticket.subject || ticket.id}".`
      : `A reply was added to ticket "${ticket.subject || ticket.id}".`),
    data: { support_id: ticket.id, reply_id: reply.id },
    actionLabel: 'View ticket',
    actionUrl: appUrl('support', req),
  }).catch(() => {});

  res.status(201).json({ data: reply });
});

const updateStatus = asyncHandler(async (req, res) => {
  const ticket = await Support.findOne({ where: { id: req.params.id, ...companyScope(req) } });
  if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
  const previous = ticket.status;
  await ticket.update({ status: req.body.status });

  // Only on the transition into a resolved state, so re-saving an already
  // closed ticket does not tell the reporter twice.
  const resolved = ['resolved', 'closed'];
  if (resolved.includes(ticket.status) && !resolved.includes(previous)) {
    notify.dispatch({
      eventKey: 'support_ticket_resolved',
      subjectUserId: ticket.created_by ?? null,
      companyId: ticket.company_id ?? null,
      context: { ticket },
      title: () => `Ticket resolved — ${ticket.subject || `#${ticket.id}`}`,
      body: (role) => (role === 'subject'
        ? `Your ticket "${ticket.subject || ticket.id}" has been marked ${ticket.status}.`
        : `Ticket "${ticket.subject || ticket.id}" was marked ${ticket.status}.`),
      data: { support_id: ticket.id, status: ticket.status },
      actionLabel: 'View ticket',
      actionUrl: appUrl('support', req),
    }).catch(() => {});
  }

  res.json({ data: ticket });
});

const checkoutVisitor = asyncHandler(async (req, res) => {
  const visitor = await Visitor.findOne({ where: { id: req.params.id, ...companyScope(req) } });
  if (!visitor) return res.status(404).json({ message: 'Visitor not found' });
  await visitor.update({ check_out: new Date(), status: 'out' });
  res.json({ data: visitor });
});

module.exports = {
  supportCrud,
  visitorCrud,
  attendanceCrud,
  vipCrud,
  communicationCrud,
  alertCrud,
  getReplies,
  addReply,
  updateStatus,
  checkoutVisitor,
};

/**
 * Every event in the system that someone might need telling about.
 *
 * The catalogue an administrator configures against. Adding an entry here is
 * all that is needed for an event to appear in the settings UI, be seedable as
 * a platform default, and be dispatchable — there is no second list to keep in
 * step.
 *
 * ── Recipients ──────────────────────────────────────────────────────────────
 *
 * Two kinds, and the distinction is the point of this design:
 *
 *   RELATIONAL   `subject` is the user the event is about — the buyer on an
 *                invoice, the author of a post, the applicant on a KYC
 *                submission. `realtor` is the realtor assigned to that user.
 *                Both are resolved from the event's own data, so they are one
 *                specific person, not a group.
 *
 *   PERMISSION   a list of permission names. Everyone in the company holding
 *                ANY of them is notified. This replaces what used to be a
 *                blunt "notify all admins": "invoice created" now reaches
 *                whoever holds finance.invoices.view, which is the group that
 *                can actually act on it, and which a company can redefine
 *                through the Roles screen without touching this catalogue.
 *
 * `subjectLabel` exists because "subject" reads differently per event. The UI
 * shows it, so an admin configuring `media_post_submitted` sees "Author"
 * rather than a generic word that would make them guess.
 *
 * `permissions` in the defaults are names from user-service's permissionCatalog.
 * A name that does not exist there is dropped at dispatch rather than
 * notifying nobody silently — see the validation in notificationConfig.js.
 */

/** The channels a configured event can go out on. */
const CHANNELS = ['in_app', 'email', 'both'];

/** Modules, in the order the settings screen groups them. */
const MODULES = [
  'finance', 'properties', 'crm', 'investments',
  'realtors', 'training', 'media', 'support', 'platform',
];

/**
 * Shorthand for an entry. `subject` and `realtor` default to false so an event
 * only carries the relational recipients that are genuinely meaningful for it —
 * offering "Realtor" on `company_created` would be noise.
 */
const event = (key, module, label, {
  description = null, subjectLabel = 'Subject', realtor = false, subject = false,
  permissions = [], enabled = true, channel = 'both',
}) => ({
  key, module, label, description, subjectLabel,
  recipients: {
    // Which relational recipients this event HAS. The UI hides the rest.
    subject: subject !== null,
    realtor,
  },
  defaults: { enabled, subject, realtor, permissions, channel },
});

const EVENTS = [
  // ── Finance: the purchase and payment journey ─────────────────────────────
  event('invoice_created', 'finance', 'Invoice created', {
    description: 'A purchase invoice has been raised.',
    subjectLabel: 'Buyer', subject: true, realtor: true,
    permissions: ['finance.invoices.view'],
  }),
  event('invoice_sent', 'finance', 'Invoice issued to the buyer', {
    subjectLabel: 'Buyer', subject: true, realtor: true,
    permissions: ['finance.invoices.view'],
  }),
  event('invoice_document_attached', 'finance', 'Document attached to an invoice', {
    description: 'Staff have attached an agreement, receipt or title to a buyer\'s invoice.',
    // The buyer is the point of the event — a document nobody mentions is a
    // document nobody reads. No permission list: the staff member who attached
    // it already knows, and telling the rest of finance is noise.
    subjectLabel: 'Buyer', subject: true, realtor: true,
    permissions: [],
  }),
  event('payment_receipt_submitted', 'finance', 'Payment receipt submitted', {
    description: 'A buyer has uploaded proof of payment and it needs reviewing.',
    subjectLabel: 'Buyer', subject: true,
    // The review queue — whoever can approve a payment.
    permissions: ['finance.invoices.manage'],
  }),
  event('payment_approved', 'finance', 'Payment approved', {
    subjectLabel: 'Buyer', subject: true, realtor: true,
    permissions: ['finance.invoices.view'],
  }),
  event('payment_rejected', 'finance', 'Payment rejected', {
    description: 'Proof of payment was not accepted. The buyer may resubmit.',
    subjectLabel: 'Buyer', subject: true, realtor: true,
    permissions: [],
  }),
  event('invoice_fully_paid', 'finance', 'Invoice fully paid', {
    subjectLabel: 'Buyer', subject: true, realtor: true,
    permissions: ['finance.invoices.view'],
  }),
  event('invoice_cancelled', 'finance', 'Invoice cancelled', {
    subjectLabel: 'Buyer', subject: true, realtor: true,
    permissions: ['finance.invoices.view'],
  }),
  event('invoice_expired', 'finance', 'Invoice expired unpaid', {
    subjectLabel: 'Buyer', subject: true, realtor: true,
    permissions: ['finance.invoices.view'],
  }),
  event('invoice_credit_balance', 'finance', 'Overpayment held as credit', {
    description: 'More was paid than the invoice owed. It needs allocating or refunding.',
    subjectLabel: 'Buyer',
    permissions: ['finance.payment-schedules.view'],
  }),
  event('schedule_reminder_first', 'finance', 'Installment reminder — 14 days before due', {
    subjectLabel: 'Buyer', subject: true, realtor: true, permissions: [],
  }),
  event('schedule_reminder_second', 'finance', 'Installment reminder — 3 days before due', {
    subjectLabel: 'Buyer', subject: true, realtor: true, permissions: [],
  }),
  event('schedule_due', 'finance', 'Installment due', {
    subjectLabel: 'Buyer', subject: true, realtor: true, permissions: [],
  }),
  event('schedule_in_grace', 'finance', 'Installment overdue, within grace', {
    subjectLabel: 'Buyer', subject: true, realtor: true, permissions: [],
  }),
  event('schedule_overdue', 'finance', 'Installment overdue, late fee applied', {
    description: 'The grace period elapsed and a default fee was charged.',
    subjectLabel: 'Buyer', subject: true, realtor: true,
    permissions: ['finance.payment-schedules.view'],
  }),
  event('payment_plan_completed', 'finance', 'Payment plan completed', {
    subjectLabel: 'Buyer', subject: true, realtor: true,
    permissions: ['finance.invoices.view'],
  }),
  event('availability_reduced', 'finance', 'Availability reduced below an invoiced quantity', {
    description: 'Another buyer paid, and this invoice can no longer be fulfilled in full.',
    subjectLabel: 'Buyer', subject: true, realtor: true,
    permissions: ['finance.invoices.manage'],
  }),
  event('commission_approved', 'finance', 'Commission approved', {
    subjectLabel: 'Earner', subject: true,
    permissions: ['finance.commissions.view'],
  }),
  event('commission_paid', 'finance', 'Commission paid', {
    subjectLabel: 'Earner', subject: true,
    permissions: ['finance.commissions.view'],
  }),

  // ── Properties ────────────────────────────────────────────────────────────
  event('purchase_request_created', 'properties', 'Purchase started on a property', {
    subjectLabel: 'Buyer', subject: true, realtor: true,
    permissions: ['properties.view'],
  }),
  event('property_submitted', 'properties', 'Property submitted for approval', {
    description: 'Someone with approval rights needs to review it.',
    subjectLabel: 'Submitter', subject: true,
    permissions: ['properties.approve'],
  }),
  event('property_approved', 'properties', 'Property approved', {
    subjectLabel: 'Submitter', subject: true,
    permissions: ['properties.view'],
  }),
  event('property_rejected', 'properties', 'Property rejected', {
    subjectLabel: 'Submitter', subject: true,
    permissions: ['properties.approve'],
  }),
  event('property_revision_requested', 'properties', 'Property revision requested', {
    subjectLabel: 'Submitter', subject: true,
    permissions: [],
  }),
  event('inspection_assigned', 'properties', 'Inspection assigned to a realtor', {
    subjectLabel: 'Realtor', subject: true,
    permissions: ['properties.inspections.view'],
  }),
  event('inspection_approved', 'properties', 'Inspection approved', {
    subjectLabel: 'Realtor', subject: true, permissions: [],
  }),
  event('inspection_rejected', 'properties', 'Inspection rejected', {
    subjectLabel: 'Realtor', subject: true, permissions: [],
  }),
  event('inspection_confirmed', 'properties', 'Inspection confirmed', {
    subjectLabel: 'Realtor', subject: true,
    permissions: ['properties.inspections.view'],
  }),
  event('inspection_completed', 'properties', 'Inspection completed', {
    subjectLabel: 'Realtor', subject: true,
    permissions: ['properties.inspections.view'],
  }),
  event('inspection_cancelled', 'properties', 'Inspection cancelled', {
    subjectLabel: 'Realtor', subject: true,
    permissions: ['properties.inspections.view'],
  }),

  // ── CRM ───────────────────────────────────────────────────────────────────
  event('lead_created', 'crm', 'Lead created', {
    subjectLabel: 'Owner', permissions: ['crm.leads.view'],
  }),
  event('lead_assigned', 'crm', 'Lead assigned', {
    description: 'The assignee is the one who has to act on it.',
    subjectLabel: 'Assignee', subject: true,
    permissions: [],
  }),
  event('deal_created', 'crm', 'Deal created', {
    subjectLabel: 'Owner', subject: true, permissions: ['crm.deals.view'],
  }),
  event('deal_stage_changed', 'crm', 'Deal moved stage', {
    subjectLabel: 'Owner', subject: true, permissions: [],
  }),
  event('task_assigned', 'crm', 'Task assigned', {
    subjectLabel: 'Assignee', subject: true, permissions: [],
  }),
  event('task_completed', 'crm', 'Task completed', {
    subjectLabel: 'Assignee', permissions: ['crm.tasks.view'],
  }),
  event('objection_raised', 'crm', 'Objection logged', {
    subjectLabel: 'Realtor', permissions: ['crm.objections.view'],
  }),

  // ── Investments ───────────────────────────────────────────────────────────
  event('investment_subscribed', 'investments', 'Investment subscribed', {
    subjectLabel: 'Investor', subject: true, realtor: true,
    permissions: ['investments.view'],
  }),
  event('investment_activated', 'investments', 'Investment activated', {
    subjectLabel: 'Investor', subject: true,
    permissions: ['investments.view'],
  }),
  event('cashout_requested', 'investments', 'Cash-out requested', {
    subjectLabel: 'Investor', subject: true,
    permissions: ['investments.manage'],
  }),
  event('cashout_approved', 'investments', 'Cash-out approved', {
    subjectLabel: 'Investor', subject: true,
    permissions: ['investments.view'],
  }),
  event('cashout_rejected', 'investments', 'Cash-out rejected', {
    subjectLabel: 'Investor', subject: true,
    permissions: ['investments.manage'],
  }),
  event('payout_created', 'investments', 'Payout recorded', {
    subjectLabel: 'Investor', subject: true,
    permissions: ['investments.view'],
  }),
  event('reinvestment_opportunity', 'investments', 'Reinvestment opportunity', {
    subjectLabel: 'Investor', subject: true, realtor: true, permissions: [],
  }),

  // ── Realtors ──────────────────────────────────────────────────────────────
  event('realtor_kyc_submitted', 'realtors', 'Realtor KYC submitted', {
    subjectLabel: 'Realtor', subject: true,
    permissions: ['users.manage'],
  }),
  event('realtor_kyc_approved', 'realtors', 'Realtor KYC approved', {
    subjectLabel: 'Realtor', subject: true, permissions: [],
  }),
  event('realtor_kyc_rejected', 'realtors', 'Realtor KYC rejected', {
    subjectLabel: 'Realtor', subject: true, permissions: [],
  }),
  event('realtor_level_changed', 'realtors', 'Realtor level changed', {
    subjectLabel: 'Realtor', subject: true,
    permissions: ['realtors.leaderboard.view'],
  }),
  event('realtor_level_request_submitted', 'realtors', 'Level upgrade requested', {
    description: 'A realtor has asked to move up a level and it needs reviewing.',
    subjectLabel: 'Realtor', subject: true,
    permissions: ['users.manage'],
  }),
  event('realtor_level_request_approved', 'realtors', 'Level upgrade approved', {
    subjectLabel: 'Realtor', subject: true,
    permissions: ['realtors.leaderboard.view'],
  }),
  event('realtor_level_request_rejected', 'realtors', 'Level upgrade declined', {
    subjectLabel: 'Realtor', subject: true, permissions: [],
  }),
  event('realtor_downline_joined', 'realtors', 'Downline realtor joined', {
    subjectLabel: 'Upline realtor', subject: true, permissions: [],
  }),
  event('realtor_inactive', 'realtors', 'Realtor inactive', {
    description: 'Escalating reminders at 30, 60 and 90 days without activity.',
    subjectLabel: 'Realtor', subject: true,
    permissions: ['users.view'],
  }),
  event('recruitment_application_received', 'realtors', 'Recruitment application received', {
    subjectLabel: 'Applicant',
    permissions: ['realtors.recruitment.view'],
  }),
  event('recruitment_status_changed', 'realtors', 'Recruitment application updated', {
    subjectLabel: 'Applicant', subject: true, permissions: [],
  }),

  // ── Training ──────────────────────────────────────────────────────────────
  event('training_module_published', 'training', 'Training module published', {
    subjectLabel: 'Author', permissions: ['realtors.training.view'],
  }),
  event('training_enrolled', 'training', 'Enrolled on a training module', {
    subjectLabel: 'Trainee', subject: true, permissions: [],
  }),
  event('training_completed', 'training', 'Training module completed', {
    subjectLabel: 'Trainee', subject: true,
    permissions: ['realtors.training.manage'],
  }),

  // ── Media ─────────────────────────────────────────────────────────────────
  event('media_post_submitted', 'media', 'Media post submitted for approval', {
    subjectLabel: 'Author', subject: true,
    permissions: ['media.approve'],
  }),
  event('media_post_approved', 'media', 'Media post approved', {
    subjectLabel: 'Author', subject: true, permissions: [],
  }),
  event('media_post_rejected', 'media', 'Media post rejected', {
    subjectLabel: 'Author', subject: true, permissions: [],
  }),
  event('media_post_published', 'media', 'Media post published', {
    subjectLabel: 'Author', subject: true,
    permissions: ['media.view'],
  }),

  // ── Support ───────────────────────────────────────────────────────────────
  event('support_ticket_created', 'support', 'Support ticket raised', {
    subjectLabel: 'Reporter', subject: true,
    permissions: ['support.manage'],
  }),
  event('support_ticket_replied', 'support', 'Support ticket replied to', {
    subjectLabel: 'Reporter', subject: true,
    permissions: ['support.view'],
  }),
  event('support_ticket_resolved', 'support', 'Support ticket resolved', {
    subjectLabel: 'Reporter', subject: true,
    permissions: ['support.view'],
  }),
  event('care_alert_raised', 'support', 'Customer care alert raised', {
    subjectLabel: 'Client',
    permissions: ['care.manage'],
  }),

  // ── Platform ──────────────────────────────────────────────────────────────
  event('company_created', 'platform', 'Company created', {
    subjectLabel: 'Owner', subject: true,
    permissions: ['companies.view'],
  }),
  event('role_assigned', 'platform', 'Role assigned to a user', {
    subjectLabel: 'User', subject: true,
    permissions: ['roles.view'],
  }),
];

const EVENT_KEYS = EVENTS.map((e) => e.key);
const EVENTS_BY_KEY = new Map(EVENTS.map((e) => [e.key, e]));

/** Every permission name any default refers to — used to validate the catalogue. */
const DEFAULT_PERMISSIONS = [...new Set(EVENTS.flatMap((e) => e.defaults.permissions))];

module.exports = {
  CHANNELS, MODULES, EVENTS, EVENT_KEYS, EVENTS_BY_KEY, DEFAULT_PERMISSIONS,
};

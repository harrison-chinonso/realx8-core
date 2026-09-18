const { Op } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize, CreditNote, DebitNote } = require('../models');
const { createDispatcher } = require('../../../../shared/src/notificationDispatcher');
const { appUrl } = require('../../../../shared/src/appOrigin');
const { paymentChoicesFor } = require('./financeController');
const { safeUploadUrl, UPLOAD_URL_MESSAGE } = require('../../../../shared/src/safeUrl');

const notify = createDispatcher(sequelize);

/**
 * The notes a realtor or client can see about themselves.
 *
 * ── Why this exists at all ─────────────────────────────────────────────────
 *
 * Every /credit-notes and /debit-notes route is staffOnly, which is right for
 * the staff screens: those list every note in the company. But the two people
 * a note is actually ABOUT could not see it. A realtor billed for verification
 * had no way to learn what they owed or where to pay it, and a client owed a
 * refund had no way to see that one had been raised — the document existed and
 * the only person with a stake in it was the one person who could not read it.
 *
 * ── Scoped by ownership, not by company ────────────────────────────────────
 *
 * client_id is the party the note is raised against, whatever their type.
 * Company scope alone would show a client every other client's refunds, which
 * is the same mistake invoiceScope exists to prevent.
 *
 * Drafts are never shown. A draft is a note somebody is still writing.
 */

/** Only the party's own notes, and only ones that have been issued. */
const mineWhere = (req) => ({
  client_id: req.user.id,
  ...(req.user.company_id ? { company_id: req.user.company_id } : {}),
  status: { [Op.ne]: 'draft' },
});

/** What the party is shown. Internal approval trail stays internal. */
const present = (note, kind) => ({
  id: note.id,
  kind,
  reference: kind === 'credit' ? note.credit_note_id : note.debit_note_id,
  amount: Number(note.amount) || 0,
  status: note.status,
  reason: note.reason || null,
  rejection_reason: note.rejection_reason || null,
  source_type: note.source_type || null,
  /*
   * `createdAt`, not `created_at`.
   *
   * The config sets `underscored: true`, which maps the COLUMN to created_at
   * while leaving the ATTRIBUTE camelCase — so `note.created_at` is undefined
   * and the date silently renders as a dash. The staff page carries the same
   * fallback for the same reason.
   */
  created_at: note.createdAt ?? note.created_at ?? null,
  ...(kind === 'credit' ? {
    payment_proof_url: note.payment_proof_url || null,
    payment_reference: note.payment_reference || null,
    payment_submitted_at: note.payment_submitted_at || null,
  } : {
    reminder_sent_at: note.reminder_sent_at || null,
  }),
});

/** A credit note is settled when it has been used; a debit note when paid. */
const SETTLED = { credit: 'used', debit: 'paid' };
const CLOSED = ['cancelled', 'rejected'];

const listMine = asyncHandler(async (req, res) => {
  const where = mineWhere(req);
  const [credit, debit] = await Promise.all([
    CreditNote.findAll({ where, order: [['id', 'DESC']] }),
    DebitNote.findAll({ where, order: [['id', 'DESC']] }),
  ]);

  /*
   * The account details come back with the list, not from a second call.
   *
   * Every credit note here is a bill, and a bill with no way to pay it is the
   * thing this screen exists to fix. Same helper the invoice payment page
   * uses, so the accounts shown cannot drift between the two.
   */
  const payment = await paymentChoicesFor(req.user.company_id ?? null);

  res.json({
    data: {
      // What they owe the company.
      credit: credit.map((note) => present(note, 'credit')),
      // What the company owes them.
      debit: debit.map((note) => present(note, 'debit')),
      payment,
    },
  });
});

/**
 * "I have paid this — here is the proof."
 *
 * Does not settle anything. It records that the party says they paid, and
 * tells whoever approves notes to look; settlement stays where it was, behind
 * the existing approval, because a screenshot is a claim rather than a payment.
 */
const submitProof = asyncHandler(async (req, res) => {
  const note = await CreditNote.findOne({ where: { id: req.params.id, ...mineWhere(req) } });
  if (!note) return res.status(404).json({ message: 'Note not found' });

  if (note.status === SETTLED.credit) {
    return res.status(409).json({ message: 'This has already been settled.' });
  }
  if (CLOSED.includes(note.status)) {
    return res.status(409).json({ message: 'This note is closed.' });
  }

  // Read by whoever approves the note — same rule as an invoice receipt.
  const documentUrl = safeUploadUrl(req.body?.document_url);
  if (!documentUrl) {
    return res.status(400).json({
      message: String(req.body?.document_url || '').trim()
        ? UPLOAD_URL_MESSAGE
        : 'Upload your proof of payment.',
    });
  }

  await note.update({
    payment_proof_url: documentUrl,
    payment_reference: String(req.body?.reference || '').trim() || null,
    payment_submitted_at: new Date(),
  });

  notify.dispatch({
    eventKey: 'note_payment_submitted',
    subjectUserId: req.user.id,
    companyId: note.company_id ?? null,
    context: { note },
    title: () => `Payment submitted — ${note.credit_note_id}`,
    body: (role, ctx) => (role === 'subject'
      ? `Your payment for ${note.credit_note_id} has been submitted and is awaiting review.`
      : `${ctx.subject?.name || 'Someone'} has submitted proof of paying ${note.credit_note_id}.`),
    data: { credit_note_id: note.id },
    actionLabel: 'Review notes',
    actionUrl: appUrl('finance/credit-notes', req),
  }).catch(() => {});

  res.json({ data: present(note, 'credit') });
});

/**
 * "You still owe me this."
 *
 * ── Who hears it ───────────────────────────────────────────────────────────
 *
 * Whoever can approve a debit note. The obvious alternative — tell whoever
 * raised it — fails for exactly the notes most likely to be chased: an
 * overpayment refund is raised by the system and has no author. The creator is
 * added on top when there is one, so a note somebody typed reaches them too.
 *
 * ── Why it is throttled ────────────────────────────────────────────────────
 *
 * A button that sends a notification is a button somebody will press twice,
 * and a queue full of the same reminder is a queue people stop reading. One a
 * day, and the reply says when the next one may be sent rather than failing
 * silently.
 */
const REMINDER_INTERVAL_HOURS = 24;

const remind = asyncHandler(async (req, res) => {
  const note = await DebitNote.findOne({ where: { id: req.params.id, ...mineWhere(req) } });
  if (!note) return res.status(404).json({ message: 'Note not found' });

  if (note.status === SETTLED.debit) {
    return res.status(409).json({ message: 'This has already been paid.' });
  }
  if (CLOSED.includes(note.status)) {
    return res.status(409).json({ message: 'This note is closed.' });
  }

  const last = note.reminder_sent_at ? new Date(note.reminder_sent_at) : null;
  const hoursSince = last ? (Date.now() - last.getTime()) / 3_600_000 : Infinity;
  if (hoursSince < REMINDER_INTERVAL_HOURS) {
    const hours = Math.ceil(REMINDER_INTERVAL_HOURS - hoursSince);
    return res.status(429).json({
      message: `You have already sent a reminder today. You can send another in ${hours} hour${hours === 1 ? '' : 's'}.`,
    });
  }

  await note.update({ reminder_sent_at: new Date() });

  notify.dispatch({
    eventKey: 'debit_note_reminder',
    subjectUserId: req.user.id,
    companyId: note.company_id ?? null,
    context: { note },
    // The person who raised it, where a person did. System-raised notes have
    // none, which is why the permission recipients above carry this event.
    extraUserIds: note.created_by ? [note.created_by] : [],
    title: () => `Reminder — ${note.debit_note_id} is still outstanding`,
    body: (role, ctx) => (role === 'subject'
      ? `Your reminder about ${note.debit_note_id} has been sent.`
      : `${ctx.subject?.name || 'Someone'} is still waiting on ${note.debit_note_id}`
        + `${note.reason ? ` — ${note.reason}` : ''}.`),
    data: { debit_note_id: note.id },
    actionLabel: 'View debit notes',
    actionUrl: appUrl('finance/debit-notes', req),
  }).catch(() => {});

  res.json({ data: present(note, 'debit') });
});

module.exports = { listMine, submitProof, remind };

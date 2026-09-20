const { Op } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize, CreditNote } = require('../models');
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
});

/** A credit note is settled when it has been used. */
const SETTLED = { credit: 'used' };
const CLOSED = ['cancelled', 'rejected'];

const listMine = asyncHandler(async (req, res) => {
  const where = mineWhere(req);
  /*
   * Credit notes only, since ACC-0.6.
   *
   * The other half of this list was debit notes — "what the company owes you"
   * — doing two unrelated jobs under one name: an overpayment refund and a
   * commission payout. Both have their own document and their own screen now,
   * and neither was ever a debit note in the sense an accountant means.
   */
  const credit = await CreditNote.findAll({ where, order: [['id', 'DESC']] });

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
      payment,
    },
  });
});

/*
 * `submitProof` is gone (ACC-0.1, ACC-0.3).
 *
 * It existed because a fee was a credit note the party PAID, so the note
 * needed somewhere to hang a receipt. A fee is a service-fee invoice now and
 * its payment is an ordinary invoice receipt — with an approval trail the
 * note flow never had — so there is nothing here to prove payment of. A credit
 * note reduces a balance; it is not settled by a screenshot.
 *
 * The three columns it wrote were dropped by dropRetiredNoteTables.
 */

module.exports = { listMine };

const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize, CreditNote } = require('../models');
const { q, lastInsertId, castText } = require('../../../../shared/src/dialect');
const { buildCompanyScope } = require('../utils/crudFactory');
const { approvePaidRequest, isChargeNote } = require('../../../../shared/src/realtorChargeCascade');
const { applyInvoiceDiscount } = require('../services/discountService');
const { postEvent } = require('../../../../shared/src/accounting/posting');
const { toMinor } = require('../../../../shared/src/money');
const { createDispatcher } = require('../../../../shared/src/notificationDispatcher');
const { appUrl } = require('../../../../shared/src/appOrigin');

const notify = createDispatcher(sequelize);

/**
 * Approving, refusing and settling a credit or debit note.
 *
 * ── Why these are endpoints and not a status field ──────────────────────────
 *
 * The status used to be whatever the creator typed. A credit note writes off
 * money owed TO the company and a debit note creates money owed OUT of it, so a
 * note that could be raised straight into a payable state was a way to move
 * money with one person's say-so. The state is now a consequence of an action
 * somebody took, and each action records who took it.
 *
 * ── The one rule worth stating ──────────────────────────────────────────────
 *
 * Nothing is paid out or used until it is approved, and approval needs
 * `finance.notes.approve` — a different permission from the one that raises a
 * note. Whoever asks for the money should not be the one who signs for it.
 */

/**
 * One instrument, since ACC-0.6.
 *
 * There were two. `debit_notes` was doing three unrelated jobs — paying a
 * commission, refunding an overpayment, and charging a realtor a fee — and was
 * named for a fourth thing it never did: in ordinary accounting a debit note
 * CHARGES a customer more. Each of those jobs now has its own document (a
 * payout run, a refund, an invoice), and the table is gone.
 *
 * What is left is the credit note, doing the one thing its name means:
 * reducing what a client owes.
 */
const KINDS = {
  credit: {
    model: CreditNote,
    table: 'credit_notes',
    reference: 'credit_note_id',
    // A credit note is consumed against what the party owes.
    settledStatus: 'used',
    settleVerb: 'used',
  },
};

const kindFrom = () => KINDS.credit;

/** The note, within the caller's company, or null. */
const findNote = async (req, kind) => {
  const scope = buildCompanyScope(req);
  const where = { id: req.params.id, ...scope };
  return kind.model.findOne({ where });
};

const approve = asyncHandler(async (req, res) => {
  const kind = kindFrom(req);
  const note = await findNote(req, kind);
  if (!note) return res.status(404).json({ message: 'Note not found' });

  if (note.status !== 'pending_approval') {
    return res.status(409).json({
      message: `This note is ${note.status.replace(/_/g, ' ')}, so it cannot be approved again.`,
    });
  }
  /**
   * A party and an amount are required to approve, not to draft. A note can be
   * started before it is known who it is for; it cannot be signed off that way,
   * because approving is the moment it becomes an obligation.
   */
  if (!note.client_id) {
    return res.status(422).json({ message: 'Choose who this note is for before approving it.' });
  }
  if (!(Number(note.amount) > 0)) {
    return res.status(422).json({ message: 'A note with no amount cannot be approved.' });
  }

  await note.update({
    status: 'approved',
    approved_by: req.user?.id ?? null,
    approved_at: new Date(),
    rejection_reason: null,
  });

  /**
   * Approving a credit note is the moment the client stops owing the money
   * (ACC-0.4).
   *
   * Until this, settling a credit note wrote no transaction and touched no
   * balance — it set a status and that was all, so the instrument that exists
   * to reduce what somebody owes reduced nothing. The reduction is spread
   * across the invoice's unpaid schedules by the same machinery a sale
   * discount uses, because to every balance in the system they are the same
   * thing: money that no longer has to be sent.
   *
   * Re-spread rather than incremented: applyInvoiceDiscount recomputes from a
   * clean slate every time, which is what makes a second note, a rejection or
   * a correction land correctly instead of compounding.
   *
   * Awaited, unlike the fire-and-forget cascades elsewhere: the response tells
   * the approver what the client now owes, and quoting a figure computed
   * before the reduction landed is worse than the extra round trip.
   */
  if (kind === KINDS.credit && note.invoice_id) {
    try {
      await applyInvoiceDiscount(note.invoice_id);
    } catch (error) {
      console.error(`[credit-note] ${note.credit_note_id} approved but not spread: ${error.message}`);
    }

    /*
     * ACC-3.4: Dr revenue, Dr VAT output, Cr AR.
     *
     * The receivable comes down by the gross the buyer no longer owes, and
     * the tax on it goes back the way it came. Posted at approval rather than
     * at settle, because approval is the moment the client stops owing — the
     * same moment the balance moved a few lines above.
     */
    await postEvent(sequelize, {
      rule: 'credit_note',
      companyId: note.company_id ?? null,
      entryDate: new Date(),
      source: 'credit_note',
      sourceId: String(note.id),
      memo: `${note.credit_note_id}${note.reason ? ` — ${String(note.reason).slice(0, 160)}` : ''}`,
      createdBy: req.user?.id ?? null,
      input: {
        netMinor: toMinor(note.amount),
        dimensions: { party_id: note.client_id, party_type: note.party_type || 'client' },
      },
    });
  }

  return res.json({ success: true, data: { id: note.id, status: 'approved' } });
});

const reject = asyncHandler(async (req, res) => {
  const kind = kindFrom(req);
  const note = await findNote(req, kind);
  if (!note) return res.status(404).json({ message: 'Note not found' });

  if (note.status !== 'pending_approval') {
    return res.status(409).json({
      message: `This note is ${note.status.replace(/_/g, ' ')}, so there is nothing to refuse.`,
    });
  }

  /**
   * A reason is required. The person who raised it is shown this, and "no"
   * without a reason produces another identical note the following day.
   */
  const reason = String(req.body?.reason || '').trim();
  if (!reason) {
    return res.status(400).json({ message: 'Say why it is being refused — the person who raised it is shown this.' });
  }

  await note.update({
    status: 'rejected',
    approved_by: req.user?.id ?? null,
    approved_at: new Date(),
    rejection_reason: reason.slice(0, 2000),
  });

  return res.json({ success: true, data: { id: note.id, status: 'rejected' } });
});

/**
 * Record that an approved note has been settled — a debit note paid out, a
 * credit note used against what the party owes.
 *
 * ── Paying a debit note is where the DEBIT is written ───────────────────────
 *
 * This is the moment money actually leaves, and it is the only moment in the
 * application that writes a `transactions` DEBIT for a payout. Marking a
 * commission paid used to write one, which put the ledger entry before any
 * approval existed: the entry said money had gone out on the say-so of whoever
 * clicked, and nothing had signed for it.
 *
 * Now the order is the one an accounts department would recognise — raise the
 * note, have it approved, pay it, and the ledger entry comes from the payment.
 *
 * The transaction row and the status change are written together, so a note can
 * never read as paid without an entry behind it. That is the failure that would
 * make the two disagree permanently, and it is unrecoverable from the outside:
 * the evidence of what happened is the thing that is missing.
 */
const settle = asyncHandler(async (req, res) => {
  const kind = kindFrom(req);
  const note = await findNote(req, kind);
  if (!note) return res.status(404).json({ message: 'Note not found' });

  if (note.status !== 'approved') {
    return res.status(409).json({
      message: note.status === 'pending_approval'
        ? `This note has not been approved yet, so it cannot be ${kind.settleVerb}.`
        : `This note is ${note.status.replace(/_/g, ' ')}, so it cannot be ${kind.settleVerb}.`,
    });
  }

  const transaction = await sequelize.transaction();
  try {
    let transactionId = null;

    /**
     * A fee note settles the thing it was a fee FOR.
     *
     * Kept for notes raised BEFORE fees became invoices (ACC-0.1). New fees
     * are service-fee invoices and unlock their request when the invoice is
     * paid, in financeController; this covers the rows already in the table.
     * Returns null for every ordinary note, which is now almost all of them.
     */
    const unlocked = isChargeNote(note)
      ? await approvePaidRequest(sequelize, {
        sourceType: note.source_type,
        sourceId: note.source_id,
        approverId: req.user?.id ?? null,
        transaction,
      })
      : null;

    await note.update({ status: kind.settledStatus }, { transaction });
    await transaction.commit();

    /*
     * The same events the manual approval sends, so a realtor cannot tell
     * which route approved them — and so a company that has configured who
     * hears about verifications still hears about these.
     */
    if (unlocked) {
      const verification = unlocked.kind === 'verification';
      notify.dispatch({
        eventKey: verification ? 'realtor_kyc_approved' : 'realtor_level_request_approved',
        subjectUserId: unlocked.userId,
        companyId: unlocked.companyId,
        context: { unlocked },
        title: () => (verification
          ? 'Your verification was approved'
          : `Upgrade approved — ${unlocked.levelName || 'new level'}`),
        body: (role, ctx) => {
          const who = ctx.subject?.name || 'A realtor';
          if (role !== 'subject') {
            return verification
              ? `${who}'s identity verification was approved — the fee has been paid.`
              : `${who}'s move to the ${unlocked.levelName || 'requested'} level was approved `
                + '— the fee has been paid.';
          }
          return verification
            ? 'Your payment has been confirmed and your identity verification is approved.'
            : `Your payment has been confirmed and you have moved to the `
              + `${unlocked.levelName || 'new'} level.`;
        },
        data: verification
          ? { kyc_id: unlocked.requestId }
          : { request_id: unlocked.requestId, level_id: unlocked.levelId },
        actionLabel: 'Go to your dashboard',
        actionUrl: appUrl('dashboard', req),
      }).catch(() => {});
    }

    return res.json({
      success: true,
      data: {
        id: note.id,
        status: kind.settledStatus,
        transaction_id: transactionId,
        unlocked: unlocked ? { kind: unlocked.kind, id: unlocked.requestId } : null,
      },
    });
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }
});

/** Everything waiting on somebody, oldest first — a queue rather than a list. */
const pending = asyncHandler(async (req, res) => {
  const scope = buildCompanyScope(req);
  const companyId = Object.prototype.hasOwnProperty.call(scope, 'company_id') ? scope.company_id : null;
  const filter = companyId ? 'AND n.company_id = :companyId' : '';

  /*
   * `party_type` is still cast to text, though there is no longer a union.
   *
   * It was there because Postgres gives every enum column its own type named
   * for its table, so credit_notes.party_type and debit_notes.party_type had
   * no common ancestor and the union failed outright with "UNION could not
   * convert type" — while MySQL's inline enums unioned as text and made it
   * work in development. The second half of that union is gone with
   * debit_notes (ACC-0.6); the cast stays because callers now receive a
   * string on both engines and changing that silently is not worth the tidy.
   */
  const partyType = castText(sequelize, 'n.party_type');

  const rows = await sequelize.query(
    `SELECT 'credit' AS kind, n.id, n.credit_note_id AS reference, n.client_id,
            ${partyType} AS party_type,
            n.amount, n.reason, n.created_at, u.name AS party_name
       FROM credit_notes n
       LEFT JOIN users u ON u.id = n.client_id
      WHERE n.status = 'pending_approval' ${filter}
      ORDER BY created_at ASC`,
    { replacements: companyId ? { companyId } : {}, type: QueryTypes.SELECT },
  );

  res.json({ success: true, data: rows });
});

module.exports = { approve, reject, settle, pending };

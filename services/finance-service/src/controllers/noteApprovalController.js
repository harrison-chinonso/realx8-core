const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize, CreditNote, DebitNote } = require('../models');
const { q, lastInsertId, castText } = require('../../../../shared/src/dialect');
const { buildCompanyScope } = require('../utils/crudFactory');

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

const KINDS = {
  credit: {
    model: CreditNote,
    table: 'credit_notes',
    reference: 'credit_note_id',
    // A credit note is consumed against what the party owes.
    settledStatus: 'used',
    settleVerb: 'used',
  },
  debit: {
    model: DebitNote,
    table: 'debit_notes',
    reference: 'debit_note_id',
    // A debit note is money the company pays out.
    settledStatus: 'paid',
    settleVerb: 'paid',
  },
};

const kindFrom = (req) => (req.baseUrl + req.path).includes('credit') ? KINDS.credit : KINDS.debit;

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

    if (kind === KINDS.debit) {
      /**
       * A debit note is money owed OUT of the company, so paying it is a DEBIT
       * against the party it was raised for. A credit note is the opposite kind
       * of instrument — it discharges what somebody owes rather than moving
       * money — so it writes nothing here.
       */
      await sequelize.query(
        `INSERT INTO ${q(sequelize, 'transactions')}
           (user_id, type, entry_type, amount, description, payment_method, status, reference, company_id, created_at)
         VALUES (:userId, 'debit_note_payout', 'debit', :amount, :description, :method, 'completed', :reference, :companyId, NOW())`,
        {
          replacements: {
            userId: note.client_id,
            amount: Number(note.amount) || 0,
            description: note.reason
              ? `${note.debit_note_id} — ${String(note.reason).slice(0, 180)}`
              : `Debit note ${note.debit_note_id}`,
            method: String(req.body?.payment_method || 'transfer'),
            reference: String(req.body?.reference || note.debit_note_id),
            companyId: note.company_id ?? null,
          },
          type: QueryTypes.INSERT,
          transaction,
        },
      );
      transactionId = await lastInsertId(sequelize, { transaction });
    }

    await note.update({ status: kind.settledStatus }, { transaction });
    await transaction.commit();

    return res.json({
      success: true,
      data: { id: note.id, status: kind.settledStatus, transaction_id: transactionId },
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
   * `party_type` is cast to text on BOTH sides of the union.
   *
   * Postgres gives every enum column its own type, named for its table — so
   * credit_notes.party_type and debit_notes.party_type are two different types
   * with no common ancestor, and the union fails outright with "UNION could not
   * convert type". MySQL's enums are inline and union as text, so this worked
   * in development and returned 400 on every poll in production.
   */
  const partyType = castText(sequelize, 'n.party_type');

  const rows = await sequelize.query(
    `SELECT 'credit' AS kind, n.id, n.credit_note_id AS reference, n.client_id,
            ${partyType} AS party_type,
            n.amount, n.reason, n.created_at, u.name AS party_name
       FROM credit_notes n
       LEFT JOIN users u ON u.id = n.client_id
      WHERE n.status = 'pending_approval' ${filter}
      UNION ALL
     SELECT 'debit' AS kind, n.id, n.debit_note_id AS reference, n.client_id,
            ${partyType} AS party_type,
            n.amount, n.reason, n.created_at, u.name AS party_name
       FROM debit_notes n
       LEFT JOIN users u ON u.id = n.client_id
      WHERE n.status = 'pending_approval' ${filter}
      ORDER BY created_at ASC`,
    { replacements: companyId ? { companyId } : {}, type: QueryTypes.SELECT },
  );

  res.json({ success: true, data: rows });
});

module.exports = { approve, reject, settle, pending };

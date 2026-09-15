const { QueryTypes } = require('sequelize');
const { nextNumber } = require('../../../../shared/src/documentSequence');
const { toMajor, asMinor } = require('../../../../shared/src/money');
const { q } = require('../../../../shared/src/dialect');

/**
 * Turning a client's overpayment into something that can actually be refunded.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * When a payment covers more than is owed, allocation records the surplus on
 * the plan as `credit_balance_minor` and stamps `credit_balance_flagged_at`.
 * That flag put the money in an admin queue, but a queue is not an instrument:
 * there was nothing to approve and nothing to pay against, so the surplus sat
 * on the plan until somebody happened to look. The client's money, held by the
 * company, with no document saying so.
 *
 * A debit note is exactly that document — money owed OUT of the company — so
 * the surplus is raised as one, `pending_approval` like any other. The flag on
 * the plan stays where it is: it is what the credit-balances screen reads, and
 * the two are answering different questions ("is there a surplus here" versus
 * "has anybody decided what to do about it").
 *
 * ── Approval is the decision point, deliberately ────────────────────────────
 *
 * Not every overpayment should be refunded. Often the client would rather it
 * came off the next instalment, and raising the note does not pre-empt that —
 * an approver who knows the client wants it carried forward refuses the note
 * with a reason, and the credit balance stays on the plan to be applied. The
 * note makes the choice visible and attributable instead of leaving it to
 * whoever next opens the queue.
 *
 * ── Why it is raised inside the payment's transaction ───────────────────────
 *
 * If the note were raised afterwards, a crash between the two would leave a
 * surplus with nothing pointing at it — the precise state this exists to
 * prevent, reachable only in the case nobody tests. Failing the note fails the
 * payment, which is recoverable; a silent half-write is not.
 */

const RAISED_BY_SYSTEM = null;

/**
 * Raise a debit note for one overpayment.
 *
 * @param {object} transaction   the payment's own transaction — required
 * @param {object} args  { sequelize, invoice, plan, surplusMinor, paymentId, companyId }
 * @returns {Promise<{ id, reference, amount_minor }|null>}
 */
const raiseOverpaymentNote = async (transaction, {
  sequelize, invoice, plan, surplusMinor, paymentId, companyId,
}) => {
  const surplus = asMinor(surplusMinor);
  if (surplus <= 0) return null;

  const companyScope = companyId ?? invoice?.company_id ?? null;

  /**
   * One note per payment, not per plan.
   *
   * Two overpayments are two separate things somebody has to decide about, and
   * a running total would have to be re-approved every time it moved. The
   * payment id is what makes a replayed approval a no-op rather than a second
   * refund of the same money.
   */
  const [existing] = await sequelize.query(
    `SELECT id FROM ${q(sequelize, 'debit_notes')}
      WHERE source_payment_id = :paymentId LIMIT 1`,
    { replacements: { paymentId }, type: QueryTypes.SELECT, transaction },
  ).catch(() => [null]);
  if (existing) return null;

  /**
   * The counter's table is created at service start, not here — creating it
   * now would be DDL inside the payment's own transaction, which MySQL answers
   * by failing the transaction. See shared/src/documentSequence.
   */
  const reference = await nextNumber(sequelize, {
    docType: 'debit_notes', table: 'debit_notes', field: 'debit_note_id',
    prefix: 'DN-', companyId: companyScope, transaction,
  });

  const reason = `Overpayment on invoice ${invoice?.invoice_id || invoice?.id}. `
    + `The client paid ${toMajor(surplus)} more than was owed. `
    + 'Approve to refund it, or refuse it with a reason to leave the surplus on the plan for the next instalment.';

  const [id] = await sequelize.query(
    `INSERT INTO ${q(sequelize, 'debit_notes')}
       (debit_note_id, client_id, party_type, invoice_id, amount, status,
        reason, source_payment_id, created_by, company_id, created_at)
     VALUES
       (:reference, :clientId, 'client', :invoiceId, :amount, 'pending_approval',
        :reason, :paymentId, :createdBy, :companyId, NOW())`,
    {
      replacements: {
        reference,
        clientId: invoice?.client_id ?? null,
        invoiceId: invoice?.id ?? null,
        amount: toMajor(surplus),
        reason,
        paymentId,
        createdBy: RAISED_BY_SYSTEM,
        companyId: companyScope,
      },
      type: QueryTypes.INSERT,
      transaction,
    },
  );

  return { id, reference, amount_minor: surplus, plan_id: plan?.id ?? null };
};

module.exports = { raiseOverpaymentNote };

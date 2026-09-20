const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize, Refund } = require('../models');
const { buildCompanyScope } = require('../utils/crudFactory');
const { asMinor, toMajor } = require('../../../../shared/src/money');
const { postEvent } = require('../../../../shared/src/accounting/posting');

/**
 * Refunding an overpayment (ACC-0.5).
 *
 * ── Three steps, and the separation is the control ──────────────────────────
 *
 * Raised by the system when a payment lands beyond what was owed; approved by
 * a person who has decided the money should go back rather than sit on the
 * plan; recorded as paid when the transfer has actually happened. The same
 * shape as a commission payout run, and for the same reason — the figures have
 * to be reviewable before the money moves, which is the only moment review is
 * worth anything.
 *
 * ── Rejecting is a decision, not a failure ──────────────────────────────────
 *
 * Refusing a refund leaves the surplus where it is: on the payment plan as a
 * credit balance, against the next instalment. That is frequently what the
 * buyer wants and always cheaper than two transfers, so it needs a reason
 * rather than an apology, and the reason stays on the row.
 */

const scope = (req) => buildCompanyScope(req);

const listRefunds = asyncHandler(async (req, res) => {
  const where = { ...scope(req) };
  if (req.query.status) where.status = req.query.status;

  const rows = await sequelize.query(
    `SELECT r.*, u.name AS client_name, i.invoice_id AS invoice_reference
       FROM refunds r
       LEFT JOIN users u ON u.id = r.client_id
       LEFT JOIN invoices i ON i.id = r.invoice_id
      WHERE ${where.company_id ? 'r.company_id = :companyId' : '1 = 1'}
        ${req.query.status ? 'AND r.status = :status' : ''}
      ORDER BY r.id DESC
      LIMIT 200`,
    {
      replacements: { companyId: where.company_id ?? null, status: req.query.status },
      type: QueryTypes.SELECT,
    },
  );
  res.json({ data: rows });
});

const findRefund = async (req) => Refund.findOne({
  where: { id: req.params.id, ...scope(req) },
});

const approveRefund = asyncHandler(async (req, res) => {
  const refund = await findRefund(req);
  if (!refund) return res.status(404).json({ message: 'Refund not found' });

  if (refund.status !== 'pending_approval') {
    return res.status(409).json({
      message: `This refund is ${refund.status.replace(/_/g, ' ')}, so it cannot be approved again.`,
    });
  }

  await refund.update({
    status: 'approved',
    approved_by: req.user?.id ?? null,
    approved_at: new Date(),
    rejection_reason: null,
  });
  res.json({ data: refund });
});

const rejectRefund = asyncHandler(async (req, res) => {
  const refund = await findRefund(req);
  if (!refund) return res.status(404).json({ message: 'Refund not found' });

  if (refund.status !== 'pending_approval') {
    return res.status(409).json({
      message: `This refund is ${refund.status.replace(/_/g, ' ')}, so there is nothing to refuse.`,
    });
  }
  const reason = String(req.body.reason || '').trim();
  if (!reason) {
    return res.status(400).json({
      message: 'Say why. The surplus stays on the plan against the next instalment, '
        + 'and the buyer is entitled to know that is what was decided.',
    });
  }

  await refund.update({
    status: 'rejected',
    rejection_reason: reason,
    approved_by: req.user?.id ?? null,
    approved_at: new Date(),
  });
  res.json({ data: refund });
});

/**
 * The money has gone. This is the step that discharges the liability.
 *
 * ── Why the credit balance moves here and not at approval ───────────────────
 *
 * Approving says the company intends to repay. Until the transfer is made, the
 * company is still holding the buyer's money and the plan's credit balance is
 * still the truth. Clearing it at approval would show a buyer a balance of
 * nothing while the money had not yet arrived with them, which is the one
 * misstatement a refund flow can make that looks like theft.
 */
const markRefundPaid = asyncHandler(async (req, res) => {
  const refund = await findRefund(req);
  if (!refund) return res.status(404).json({ message: 'Refund not found' });

  if (refund.status !== 'approved') {
    return res.status(409).json({
      message: refund.status === 'paid'
        ? 'This refund has already been paid.'
        : 'A refund must be approved before it can be paid.',
    });
  }

  const amount = asMinor(refund.amount_minor);

  await sequelize.transaction(async (transaction) => {
    await refund.update({
      status: 'paid',
      paid_by: req.user?.id ?? null,
      paid_at: new Date(),
      payment_method: String(req.body.payment_method || 'transfer'),
      payment_reference: String(req.body.reference || '').trim() || refund.reference,
    }, { transaction });

    /*
     * Take it off the plan's credit balance, never below zero.
     *
     * The surplus may have been partly consumed by a later instalment between
     * the refund being raised and being paid — the plan applies credit as it
     * goes — so the balance can be smaller than the refund by the time it is
     * sent. Clamping is the honest arithmetic; going negative would invent a
     * debt the buyer does not have.
     */
    if (refund.invoice_id) {
      await sequelize.query(
        `UPDATE invoice_payment_plans
            SET credit_balance_minor = GREATEST(credit_balance_minor - :amount, 0)
          WHERE invoice_id = :invoiceId`,
        { replacements: { amount, invoiceId: refund.invoice_id }, type: QueryTypes.UPDATE, transaction },
      );
    }

    /*
     * The cash book entry, written where the money actually left — the same
     * placement the commission payout moved to in ACC-0.6.
     */
    await sequelize.query(
      `INSERT INTO transactions
         (user_id, type, entry_type, amount, description, payment_method, status, reference, company_id, created_at)
       VALUES (:userId, 'refund', 'debit', :amount, :description, :method, 'completed', :reference, :companyId, NOW())`,
      {
        replacements: {
          userId: refund.client_id,
          amount: toMajor(amount),
          description: `Refund ${refund.reference}${refund.reason ? ` — ${String(refund.reason).slice(0, 160)}` : ''}`,
          method: String(req.body.payment_method || 'transfer'),
          reference: String(req.body.reference || '').trim() || refund.reference,
          companyId: refund.company_id ?? null,
        },
        type: QueryTypes.INSERT,
        transaction,
      },
    );

    /*
     * ACC-3.4: Dr customer credit balances / Cr bank.
     *
     * The liability raised when the overpayment was banked is discharged. No
     * revenue in either direction — the sale never grew and never shrank, the
     * company simply stops holding money that was not its own.
     */
    await postEvent(sequelize, {
      rule: 'refund',
      companyId: refund.company_id ?? null,
      entryDate: new Date(),
      source: 'refund',
      sourceId: String(refund.id),
      memo: `Refund ${refund.reference}`,
      createdBy: req.user?.id ?? null,
      input: {
        amountMinor: amount,
        dimensions: { party_id: refund.client_id, party_type: 'client' },
      },
    }, { transaction });
  });

  res.json({ data: refund });
});

module.exports = { listRefunds, approveRefund, rejectRefund, markRefundPaid };

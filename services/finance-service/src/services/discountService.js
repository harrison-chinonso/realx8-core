const { QueryTypes } = require('sequelize');
const { approvedCreditMinor } = require('../../../../shared/src/creditNotes');
const { sequelize } = require('../models');
const { asMinor, toMinor } = require('../../../../shared/src/money');
const { spreadDiscount } = require('../../../../shared/src/invoiceDiscount');

/**
 * Applying an invoice's discount to the installments still to be paid.
 *
 * ── Why this runs on a discount CHANGE rather than at generation ────────────
 *
 * A discount is often agreed after the plan exists — a negotiation, a gesture
 * for a late handover, a correction. Until now `invoices.discount` was a
 * display field: it appeared on the invoice, fed the commission base, and
 * changed nothing about what the buyer owed. The schedule ledger still demanded
 * the full amount, so a buyer granted ₦1m off was still chased for it.
 *
 * ── Applied as a difference, never stacked ──────────────────────────────────
 *
 * `invoice_payment_plans.discount_minor` records what has already been spread.
 * Re-saving an invoice with the same discount must therefore be a no-op, and
 * raising it from ₦1m to ₦1.5m must apply ₦500k — not ₦1.5m on top of ₦1m.
 * Without that, editing an invoice twice halves it.
 */

/** The schedules of a plan, in due order, with what each still owes. */
const schedulesFor = async (planId, transaction = null) => sequelize.query(
  `SELECT id, sequence, principal_minor, principal_outstanding_minor,
          fee_outstanding_minor, discount_minor, settlement_status
     FROM payment_schedules
    WHERE invoice_payment_plan_id = :planId
    ORDER BY due_date ASC, sequence ASC`,
  { replacements: { planId }, type: QueryTypes.SELECT, transaction },
);

/**
 * Bring an invoice's plan into line with its discount.
 *
 * @returns {{ applied_minor, unapplied_minor, schedules_changed, skipped? }}
 */
const applyInvoiceDiscount = async (invoiceId, { transaction = null } = {}) => {
  const run = async (tx) => {
    const [invoice] = await sequelize.query(
      'SELECT id, discount FROM invoices WHERE id = :id LIMIT 1',
      { replacements: { id: invoiceId }, type: QueryTypes.SELECT, transaction: tx },
    );
    if (!invoice) return { skipped: 'no_such_invoice' };

    const [plan] = await sequelize.query(
      `SELECT id, total_minor, discount_minor FROM invoice_payment_plans
        WHERE invoice_id = :id LIMIT 1`,
      { replacements: { id: invoiceId }, type: QueryTypes.SELECT, transaction: tx },
    );
    // An invoice with no plan has no installments to reduce. Its discount still
    // shows on the invoice and still feeds the commission base.
    if (!plan) return { skipped: 'no_payment_plan' };

    /**
     * What comes off, from both sources (ACC-0.4).
     *
     * `invoices.discount` is a reduction granted at the point of sale. An
     * approved CREDIT NOTE is a reduction granted afterwards — a price
     * correction, a cancelled portion, an overcharge. They are the same thing
     * to every balance in the system, so they are spread as one figure rather
     * than as two parallel mechanisms each screen would have to learn.
     *
     * The invoice total is still untouched, which is what keeps the agreed
     * price answerable and the reduction reversible.
     */
    const wanted = toMinor(invoice.discount || 0)
      + await approvedCreditMinor(sequelize, invoiceId, { transaction: tx });
    const already = asMinor(plan.discount_minor);

    const schedules = await schedulesFor(plan.id, tx);

    /**
     * Start from a clean slate each time: clear what was spread before, then
     * spread the discount now wanted. Applying only the difference sounds
     * cheaper, but a difference cannot be spread correctly once some
     * installments have been paid since — the shape of "unpaid" has changed,
     * and the old allocation no longer describes it.
     */
    const restored = schedules.map((schedule) => ({
      ...schedule,
      // What the installment would owe with no discount on it at all.
      principal_outstanding_minor: asMinor(schedule.principal_outstanding_minor),
      discount_minor: 0,
    }));

    const result = spreadDiscount(wanted, restored);
    const byId = new Map(result.allocations.map((a) => [Number(a.schedule_id), a.discount_minor]));

    let changed = 0;
    for (const schedule of schedules) {
      const next = byId.get(Number(schedule.id)) ?? 0;
      if (next === asMinor(schedule.discount_minor)) continue;
      // eslint-disable-next-line no-await-in-loop
      await sequelize.query(
        'UPDATE payment_schedules SET discount_minor = :discount, updated_at = NOW() WHERE id = :id',
        { replacements: { id: schedule.id, discount: next }, type: QueryTypes.UPDATE, transaction: tx },
      );
      changed += 1;
    }

    await sequelize.query(
      'UPDATE invoice_payment_plans SET discount_minor = :applied, updated_at = NOW() WHERE id = :id',
      { replacements: { id: plan.id, applied: result.applied_minor }, type: QueryTypes.UPDATE, transaction: tx },
    );

    if (result.unapplied_minor > 0) {
      console.warn(`[discount] invoice ${invoiceId}: ${result.unapplied_minor} minor units could not `
        + 'be applied — the discount exceeds what is still owed');
    }

    return {
      applied_minor: result.applied_minor,
      unapplied_minor: result.unapplied_minor,
      previously_applied_minor: already,
      schedules_changed: changed,
    };
  };

  return transaction ? run(transaction) : sequelize.transaction((tx) => run(tx));
};

module.exports = { applyInvoiceDiscount, schedulesFor };

const { asMinor, allocateByWeight } = require('./money');

/**
 * Spreading a discount across the installments a buyer has not paid yet.
 *
 * ── The invoice total is never touched ──────────────────────────────────────
 *
 * A discount changes what somebody has to PAY, not what the thing cost. The
 * invoice keeps its amount, every schedule keeps its principal, and the
 * reduction lives alongside as a separate figure. Overwriting the principal
 * would erase the agreed price — and with it any way to answer "what was this
 * sold for", to reconcile against the property, or to reverse the discount if
 * it was granted in error.
 *
 * ── Only unpaid installments, and proportionally ────────────────────────────
 *
 * Money already paid cannot be discounted, only refunded, which is a different
 * decision with different authority behind it. So the discount lands on what is
 * still outstanding.
 *
 * Spread in proportion to what each unpaid installment still owes. On the usual
 * plan, where every installment is the same size, that is an equal reduction on
 * each — which is what a buyer expects when told their payments have come down.
 * Proportional rather than strictly equal matters when the installments are
 * NOT the same size: an equal split would take more from a small final
 * installment than it contains, and the excess would have to go somewhere
 * anyway.
 *
 * Largest-remainder, so the parts sum to exactly the discount. A discount that
 * does not reconcile to the kobo is one somebody has to explain.
 */

/**
 * @param {number} discountMinor  the whole discount to apply
 * @param {object[]} schedules    [{ id, principal_minor, principal_outstanding_minor,
 *                                   settlement_status }] in due order
 * @returns {{ allocations: {schedule_id, discount_minor, payable_minor}[],
 *             applied_minor, unapplied_minor }}
 */
const spreadDiscount = (discountMinor, schedules = []) => {
  const discount = Math.max(asMinor(discountMinor), 0);

  /**
   * "Unpaid" means it still owes something, whatever its status column says.
   * A schedule marked partially paid has an outstanding balance and belongs
   * here; one marked unpaid that somehow owes nothing does not.
   */
  const unpaid = schedules.filter((s) => asMinor(s.principal_outstanding_minor) > 0);

  if (discount <= 0 || !unpaid.length) {
    return { allocations: [], applied_minor: 0, unapplied_minor: discount };
  }

  const outstanding = unpaid.map((s) => asMinor(s.principal_outstanding_minor));
  const capacity = outstanding.reduce((total, amount) => total + amount, 0);

  /**
   * A discount larger than what is left to pay is applied only up to the
   * balance. The remainder is reported rather than silently dropped: it means
   * somebody granted more than the invoice can absorb, which is a conversation,
   * not a rounding difference.
   */
  const applied = Math.min(discount, capacity);
  const shares = allocateByWeight(applied, outstanding);

  return {
    allocations: unpaid.map((schedule, index) => ({
      schedule_id: schedule.id,
      discount_minor: shares[index],
      // What the buyer actually has to send for this installment now.
      payable_minor: asMinor(schedule.principal_outstanding_minor) - shares[index],
    })),
    applied_minor: applied,
    unapplied_minor: discount - applied,
  };
};

/**
 * The discount already spread across a plan, so a REVISED discount can be
 * applied as a difference rather than by stacking on top of itself.
 *
 * Re-granting a discount that was already applied is the obvious way to halve
 * an invoice by accident, and it is the kind of mistake that only shows up when
 * the buyer stops paying at what they believe is the end.
 */
const discountAlreadyApplied = (schedules = []) => schedules
  .reduce((total, schedule) => total + asMinor(schedule.discount_minor), 0);

/**
 * What one schedule is worth, after any discount on it.
 *
 * A single place to ask, because the figure appears on the schedule table, the
 * payment page, the reminder and the receipt, and four subtractions written
 * four times eventually disagree.
 */
const payableFor = (schedule = {}) => Math.max(
  asMinor(schedule.principal_outstanding_minor) - asMinor(schedule.discount_minor),
  0,
) + asMinor(schedule.fee_outstanding_minor);

module.exports = { spreadDiscount, discountAlreadyApplied, payableFor };

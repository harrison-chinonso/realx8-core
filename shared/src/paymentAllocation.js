/**
 * Payment allocation (FRD 8.2) — the arithmetic half.
 *
 * A client may pay any amount, any number of times, in any month, and this
 * resolves it: oldest due date first, accrued default fees before principal
 * within a schedule, overflow cascading to the next unpaid schedule, and any
 * surplus past the final schedule becoming a credit balance for an admin to
 * look at.
 *
 * Pure on purpose. The persisting half — the transaction, the allocation rows,
 * the inventory hold — lives in finance-service's allocationService, which
 * calls this and writes what it returns. Keeping the resolution itself free of
 * the database is what lets the FRD's worked scenario be asserted directly, and
 * it is the reason there is ONE allocator rather than one per entry point
 * (client submission, admin entry on behalf, a future gateway callback).
 */

const { asMinor } = require('./money');

/**
 * Oldest first, and deterministic.
 *
 * `sequence` breaks ties because two schedules of the same plan can share a due
 * date once an admin has edited an invoice, and `id` breaks the remaining tie
 * so a replayed allocation lands identically.
 */
const byDueDate = (a, b) => (
  new Date(a.due_date) - new Date(b.due_date)
  || (Number(a.sequence) || 0) - (Number(b.sequence) || 0)
  || (Number(a.id) || 0) - (Number(b.id) || 0)
);

const outstandingOf = (schedule) => ({
  fee: Math.max(asMinor(schedule.fee_outstanding_minor), 0),
  principal: Math.max(asMinor(schedule.principal_outstanding_minor), 0),
});

/**
 * Resolves `amountMinor` across `schedules`.
 *
 * Returns the allocation LINES (FRD 8.4 — which payment contributed how much to
 * which schedule, split between fee and principal), the resulting state of each
 * touched schedule, and whatever is left over.
 *
 * Already-paid schedules are skipped rather than filtered out by the caller, so
 * passing a plan's full schedule set is always safe. Nothing is mutated: the
 * caller gets new state objects and decides what to persist.
 */
const allocate = ({ amountMinor, schedules = [] }) => {
  let remaining = Math.max(asMinor(amountMinor), 0);

  const queue = schedules
    .filter((schedule) => schedule.settlement_status !== 'paid')
    .slice()
    .sort(byDueDate);

  const lines = [];

  for (const schedule of queue) {
    if (remaining <= 0) break;

    const before = outstandingOf(schedule);

    // Fees first: a schedule that accrued a default fee must clear the fee
    // before the payment touches principal, or the fee outlives a schedule the
    // client believes they have settled.
    const feeApplied = Math.min(remaining, before.fee);
    remaining -= feeApplied;

    const principalApplied = Math.min(remaining, before.principal);
    remaining -= principalApplied;

    if (feeApplied === 0 && principalApplied === 0) continue;

    const feeOutstanding = before.fee - feeApplied;
    const principalOutstanding = before.principal - principalApplied;
    const settled = feeOutstanding === 0 && principalOutstanding === 0;

    lines.push({
      schedule_id: schedule.id ?? null,
      sequence: schedule.sequence ?? null,
      due_date: schedule.due_date ?? null,
      fee_minor: feeApplied,
      principal_minor: principalApplied,
      // The state the caller writes back to the row.
      next: {
        fee_outstanding_minor: feeOutstanding,
        principal_outstanding_minor: principalOutstanding,
        settlement_status: settled ? 'paid' : 'partially_paid',
        // timing_status is deliberately NOT written here. FRD 9.2 keeps timing
        // and settlement as two independent dimensions, and a settled schedule
        // exits the timing progression by being PAID rather than by having its
        // timing overwritten — so a schedule that went overdue before it was
        // settled still records that it did. Everything downstream (the daily
        // job, plan status, the default-fee trigger) asks for overdue AND
        // unsettled, never overdue alone.
      },
    });
  }

  return {
    appliedMinor: Math.max(asMinor(amountMinor), 0) - remaining,
    // Surplus beyond every schedule. FRD 8.2 puts it on the payment plan as a
    // credit balance and flags an admin — it is never quietly absorbed.
    creditBalanceMinor: remaining,
    lines,
  };
};

module.exports = { allocate, byDueDate };

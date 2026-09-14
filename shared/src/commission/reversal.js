const { asMinor } = require('../money');

/**
 * Taking commission back when a deal shrinks or dies (§7.10).
 *
 * ── The order is the whole design ───────────────────────────────────────────
 *
 * FR-ADJ-002 sets it, and it is ordered by how much it costs the person:
 *
 *   1. cancel what has not been released      — nobody notices
 *   2. offset what is released but unpaid     — a smaller next payout
 *   3. raise a receivable for the remainder   — a conversation
 *
 * Reaching for step 3 first would demand money back from somebody who still has
 * an unreleased accrual sitting against the very same deal, which is both
 * needlessly aggressive and worse for the company: a receivable is recovered
 * slowly, if at all, while an accrual is simply not paid.
 *
 * ── Recompute, never delete ─────────────────────────────────────────────────
 *
 * A downward re-pricing is not a cancellation. The engine re-runs against the
 * new figures and the DIFFERENCE is reversed (FR-ADJ-004), so a deal
 * renegotiated from 50M to 45M reduces everybody proportionally rather than
 * unwinding and rebuilding — which would lose the trace of what was originally
 * agreed.
 */

/**
 * What to do to one participant's position, given a revised entitlement.
 *
 * @param {object} line   { constrained_minor, released_minor, paid_minor }
 * @param {number} revisedMinor  what they are now owed on this deal
 * @returns {{ cancel_accrual_minor, offset_wallet_minor, clawback_minor,
 *             revised_minor, unchanged }}
 */
const reverseLine = (line = {}, revisedMinor = 0) => {
  const entitled = asMinor(line.constrained_minor);
  const released = asMinor(line.released_minor);
  const paid = asMinor(line.paid_minor);
  const revised = Math.max(asMinor(revisedMinor), 0);

  if (revised >= entitled) {
    return {
      cancel_accrual_minor: 0,
      offset_wallet_minor: 0,
      clawback_minor: 0,
      revised_minor: revised,
      unchanged: true,
    };
  }

  const surrendered = entitled - revised;

  /**
   * Step 1 — the unreleased accrual. Costs the earner nothing they have seen.
   */
  const unreleased = Math.max(entitled - released, 0);
  const cancelAccrual = Math.min(surrendered, unreleased);

  let outstanding = surrendered - cancelAccrual;

  /**
   * Step 2 — released but not yet paid out. Still the company's money, so
   * taking it back is bookkeeping rather than recovery.
   */
  const releasedUnpaid = Math.max(released - paid, 0);
  const offsetWallet = Math.min(outstanding, releasedUnpaid);
  outstanding -= offsetWallet;

  /**
   * Step 3 — money that has actually left. A receivable, recovered from future
   * earnings at the configured rate, and the only part anybody has to be told
   * about.
   */
  return {
    cancel_accrual_minor: cancelAccrual,
    offset_wallet_minor: offsetWallet,
    clawback_minor: Math.max(outstanding, 0),
    revised_minor: revised,
    unchanged: false,
  };
};

/**
 * Whether a deal is still inside its clawback window (FR-ADJ-006).
 *
 * A company may decide that after a year a paid commission is final, whatever
 * later happens to the deal. Without a window the liability is open forever,
 * which is not a position anybody can plan against — and a realtor cannot be
 * expected to hold a reserve indefinitely against a sale they made.
 */
const withinClawbackWindow = (plan = {}, attributionDate, now = new Date()) => {
  const months = Number(plan.clawback_window_months) || 0;
  if (months <= 0) return true;               // unset means no expiry
  const from = new Date(attributionDate);
  if (Number.isNaN(from.getTime())) return true;
  const deadline = new Date(from);
  deadline.setMonth(deadline.getMonth() + months);
  return now <= deadline;
};

/**
 * How much of a payout may be withheld against an outstanding receivable
 * (FR-ADJ-003).
 *
 * Capped, deliberately. Recovering the whole of somebody's next payout is
 * legally fraught in most places and practically self-defeating — a realtor
 * with nothing coming has no reason to keep selling, which is the only way the
 * receivable ever gets paid.
 */
const recoveryFromPayout = (payoutMinor, owedMinor, plan = {}) => {
  const payout = asMinor(payoutMinor);
  const owed = asMinor(owedMinor);
  if (payout <= 0 || owed <= 0) return { recovered_minor: 0, net_minor: payout, still_owed_minor: owed };

  const percentage = Math.min(Math.max(Number(plan.clawback_recovery_percentage) || 100, 0), 100);
  const most = Math.floor((payout * percentage) / 100);
  const recovered = Math.min(owed, most);

  return {
    recovered_minor: recovered,
    net_minor: payout - recovered,
    still_owed_minor: owed - recovered,
    recovery_percentage: percentage,
  };
};

/**
 * Does a reversal reach the uplines, or only the seller?
 *
 * `PROTECT_UPLINE` exists because a generational override rewards having built
 * the team, not the individual sale — and a company may reasonably decide that
 * a buyer defaulting is not the sponsor's fault. Defaulting to cascading is the
 * conservative choice: the money came from a sale that did not happen.
 */
const cascadesToUpline = (plan = {}) => plan.clawback_scope !== 'PROTECT_UPLINE';

module.exports = { reverseLine, withinClawbackWindow, recoveryFromPayout, cascadesToUpline };

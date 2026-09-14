const { asMinor, allocateByWeight } = require('../money');

/**
 * When an accrued entitlement becomes payable (§7.9).
 *
 * ── Why release is decoupled from accrual at all ────────────────────────────
 *
 * Property is rarely paid in one instalment. Recognising the whole commission
 * when the deal is signed and paying it out immediately is the most expensive
 * mistake available in this domain: the buyer abandons the plan in month four,
 * and the company is chasing eight realtors for money it already transferred.
 * So the entitlement is recognised at the deal and RELEASED against what the
 * buyer has actually paid.
 *
 * ── Pure, like the rest of the engine ───────────────────────────────────────
 *
 * These functions take what has been received and return what should now be
 * released. They do not know what has been released already — the caller
 * subtracts — and they never decide eligibility, which is a separate question
 * asked at the same moment (§5.9).
 */

const TRIGGER = {
  /** The whole thing, as soon as the deal is confirmed. */
  ON_DEAL_CONFIRMATION: 'ON_DEAL_CONFIRMATION',
  /** The whole thing, once any money has arrived. */
  ON_INITIAL_DEPOSIT: 'ON_INITIAL_DEPOSIT',
  /** The whole thing, once cumulative receipts pass a percentage of the base. */
  ON_THRESHOLD: 'ON_THRESHOLD',
  /** In step with the buyer: 40% paid, 40% released. */
  PRO_RATA: 'PRO_RATA',
  /** Nothing until the buyer has paid in full. */
  ON_FULL_PAYMENT: 'ON_FULL_PAYMENT',
  /** Against named milestones — title issued, construction stage reached. */
  MILESTONE: 'MILESTONE',
  /** On a fixed schedule after confirmation, regardless of receipts. */
  SCHEDULED: 'SCHEDULED',
};
const TRIGGERS = Object.values(TRIGGER);

/**
 * How much of an entitlement has vested, given what the buyer has paid.
 *
 * @param {object} plan     the vesting configuration
 * @param {object} context  { entitlement_minor, commissionable_base_minor,
 *                            received_minor, confirmed, milestones_met[],
 *                            elapsed_days }
 * @returns {{ vested_minor, reason, of }}
 *
 * Returns the CUMULATIVE vested figure, not an increment. The caller holds
 * `released_minor` and pays the difference — which makes a replayed receipt a
 * no-op rather than a second payment, and means a correction that reduces the
 * received total can be detected rather than silently over-released.
 */
const vestedAmount = (plan = {}, context = {}) => {
  const entitlement = asMinor(context.entitlement_minor);
  const base = asMinor(context.commissionable_base_minor);
  const received = asMinor(context.received_minor);
  const trigger = plan.release_trigger || TRIGGER.ON_FULL_PAYMENT;

  if (entitlement <= 0) return { vested_minor: 0, reason: 'nothing_to_vest', of: trigger };

  switch (trigger) {
    case TRIGGER.ON_DEAL_CONFIRMATION:
      return context.confirmed
        ? { vested_minor: entitlement, reason: 'deal_confirmed', of: trigger }
        : { vested_minor: 0, reason: 'not_yet_confirmed', of: trigger };

    case TRIGGER.ON_INITIAL_DEPOSIT:
      return received > 0
        ? { vested_minor: entitlement, reason: 'deposit_received', of: trigger }
        : { vested_minor: 0, reason: 'no_payment_yet', of: trigger };

    case TRIGGER.ON_THRESHOLD: {
      /**
       * A percentage of the BASE, not of the instalment plan's total.
       *
       * The two differ whenever a plan carries a surcharge, and the base is the
       * figure the commission itself was computed from — so "released once the
       * buyer is halfway" means halfway through what we were paid commission
       * on, not halfway through a total that includes interest.
       */
      const needed = Math.ceil((base * (Number(plan.threshold_percentage) || 0)) / 100);
      return received >= needed && needed > 0
        ? { vested_minor: entitlement, reason: 'threshold_reached', of: trigger, threshold_minor: needed }
        : { vested_minor: 0, reason: 'below_threshold', of: trigger, threshold_minor: needed, received_minor: received };
    }

    case TRIGGER.PRO_RATA: {
      /**
       * FR-VST-002, and the clamp matters.
       *
       * Receipts can exceed the base — an overpayment, a fee collected on the
       * same invoice — and without the clamp the realtor would vest more than
       * they are owed. Capped at the entitlement, never above it.
       */
      if (base <= 0) return { vested_minor: 0, reason: 'no_base', of: trigger };
      const ratio = Math.min(received / base, 1);
      return {
        vested_minor: Math.min(Math.floor(entitlement * ratio), entitlement),
        reason: 'pro_rata',
        of: trigger,
        received_ratio: ratio,
      };
    }

    case TRIGGER.MILESTONE: {
      /**
       * Each milestone carries a share, and only the ones MET vest.
       *
       * Shares are allocated by weight rather than multiplied out, so a set of
       * milestones that all complete releases exactly the entitlement and not a
       * kobo more or less.
       */
      const milestones = plan.milestones || [];
      if (!milestones.length) return { vested_minor: 0, reason: 'no_milestones_configured', of: trigger };

      const met = new Set(context.milestones_met || []);
      const shares = allocateByWeight(entitlement, milestones.map((m) => Number(m.weight) || 0));
      const vested = milestones.reduce(
        (total, milestone, index) => total + (met.has(milestone.code) ? shares[index] : 0),
        0,
      );
      return {
        vested_minor: vested,
        reason: met.size ? 'milestones_met' : 'no_milestones_met',
        of: trigger,
        met: [...met],
      };
    }

    case TRIGGER.SCHEDULED: {
      /**
       * Time, not money. Used where a company pays commission on an agreed
       * drumbeat and carries the buyer-default risk itself.
       */
      const steps = Math.max(Number(plan.schedule_steps) || 1, 1);
      const every = Math.max(Number(plan.schedule_interval_days) || 30, 1);
      const elapsed = Math.max(Number(context.elapsed_days) || 0, 0);
      const due = Math.min(Math.floor(elapsed / every) + (plan.release_first_immediately ? 1 : 0), steps);
      if (due <= 0) return { vested_minor: 0, reason: 'no_step_due_yet', of: trigger };
      const shares = allocateByWeight(entitlement, Array.from({ length: steps }, () => 1));
      return {
        vested_minor: shares.slice(0, due).reduce((total, share) => total + share, 0),
        reason: 'scheduled',
        of: trigger,
        steps_due: due,
        steps,
      };
    }

    case TRIGGER.ON_FULL_PAYMENT:
    default:
      return received >= base && base > 0
        ? { vested_minor: entitlement, reason: 'paid_in_full', of: TRIGGER.ON_FULL_PAYMENT }
        : { vested_minor: 0, reason: 'not_paid_in_full', of: TRIGGER.ON_FULL_PAYMENT };
  }
};

/**
 * What a holdback keeps back (FR-VST-004).
 *
 * A percentage of the entitlement is retained past the ordinary trigger until
 * its own condition is met — typically title documentation. Applied AFTER the
 * trigger, so a pro-rata release of a holdback plan releases pro-rata of the
 * released portion and nothing of the retained one.
 */
const applyHoldback = (vestedMinor, entitlementMinor, plan = {}, context = {}) => {
  const percentage = Number(plan.holdback_percentage) || 0;
  if (percentage <= 0) return { vested_minor: vestedMinor, held_minor: 0 };

  if (context.holdback_released) return { vested_minor: vestedMinor, held_minor: 0 };

  const held = Math.ceil((asMinor(entitlementMinor) * percentage) / 100);
  const payable = Math.max(Math.min(vestedMinor, asMinor(entitlementMinor) - held), 0);
  return { vested_minor: payable, held_minor: Math.min(held, asMinor(entitlementMinor)) };
};

/**
 * Whether a released amount has matured enough to withdraw (FR-VST-005).
 *
 * A cooling-off period between release and availability, so an early
 * cancellation is absorbed by money still on the premises rather than chased
 * from somebody's bank account. Released is not the same as available, and this
 * is the difference.
 */
const isMatured = (plan = {}, releasedAt, now = new Date()) => {
  const days = Number(plan.maturity_days) || 0;
  if (days <= 0) return true;
  const released = new Date(releasedAt);
  if (Number.isNaN(released.getTime())) return false;
  // Coerced, for the reason set out in reversal.withinClawbackWindow: a caller
  // that passes an ISO string would otherwise throw on .getTime().
  const asAt = new Date(now);
  if (Number.isNaN(asAt.getTime())) return false;
  return asAt.getTime() - released.getTime() >= days * 24 * 60 * 60 * 1000;
};

module.exports = { TRIGGER, TRIGGERS, vestedAmount, applyHoldback, isMatured };

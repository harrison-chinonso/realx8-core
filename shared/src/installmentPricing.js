/**
 * Purchase pricing and schedule generation (FRD 4, 9.1).
 *
 * The client calculates the same numbers for display, but this module is the
 * authority: `quote()` runs again server-side at invoice creation and its
 * result is what gets stored, so a client-supplied total is never trusted.
 *
 * Everything here is a pure function over integer minor units. No database, no
 * request, no clock except the `from` date passed in — which is what makes the
 * worked scenarios in the FRD directly testable.
 */

const {
  asMinor, toMinor, percentageOf, applyRounding, splitEvenly,
} = require('./money');

/** FRD 2 — the two payment types. */
const PAYMENT_TYPES = ['outright', 'installment'];

/**
 * The plan terms every calculation reads.
 *
 * Deliberately a flat shape rather than a plan row: at invoice creation the
 * live plan is snapshotted onto the invoice's payment plan (FRD 3.3) and every
 * subsequent calculation reads the SNAPSHOT. Both callers hand the same shape
 * to the same functions, so historic invoices cannot silently pick up an edited
 * plan's terms.
 */
const planTerms = (input) => {
  // `= {}` only defaults an UNDEFINED argument, so an explicit null still threw.
  // Callers upstream reject a missing plan before reaching here, but a helper
  // that reads a shape should tolerate the shape being absent rather than
  // turning a validation problem into a TypeError.
  const source = input || {};
  return {
    name: source.name ?? source.snapshot_plan_name ?? null,
    durationMonths: Math.trunc(Number(source.duration_months ?? source.snapshot_duration_months ?? 0)) || 0,
    surchargeType: String(source.surcharge_type ?? source.snapshot_surcharge_type ?? 'none'),
    surchargeValue: Number(source.surcharge_value ?? source.snapshot_surcharge_value ?? 0) || 0,
    roundingRule: String(source.rounding_rule ?? source.snapshot_rounding_rule ?? 'none'),
    gracePeriodDays: Math.trunc(Number(source.grace_period_days ?? source.snapshot_grace_period_days ?? 0)) || 0,
    defaultFeeType: String(source.default_fee_type ?? source.snapshot_default_fee_type ?? 'none'),
    defaultFeeValue: Number(source.default_fee_value ?? source.snapshot_default_fee_value ?? 0) || 0,
    defaultFeeRecurrence: String(source.default_fee_recurrence ?? source.snapshot_default_fee_recurrence ?? 'once'),
  };
};

/** The snapshot written onto invoice_payment_plans at creation (FRD 3.3). */
const snapshotOf = (plan) => {
  const terms = planTerms(plan);
  return {
    snapshot_plan_name: terms.name,
    snapshot_duration_months: terms.durationMonths,
    snapshot_surcharge_type: terms.surchargeType,
    snapshot_surcharge_value: terms.surchargeValue,
    snapshot_rounding_rule: terms.roundingRule,
    snapshot_grace_period_days: terms.gracePeriodDays,
    snapshot_default_fee_type: terms.defaultFeeType,
    snapshot_default_fee_value: terms.defaultFeeValue,
    snapshot_default_fee_recurrence: terms.defaultFeeRecurrence,
  };
};

/**
 * The plan surcharge, applied ONCE to the full base amount (FRD 15.2), not per
 * installment.
 */
const surchargeFor = (baseMinor, terms) => {
  if (terms.surchargeType === 'percentage') return percentageOf(baseMinor, terms.surchargeValue);
  if (terms.surchargeType === 'flat') return toMinor(terms.surchargeValue);
  return 0;
};

/**
 * Prices one purchase.
 *
 * Outright is the base amount untouched — no surcharge, no rounding, so the
 * comparison figure in FRD 4.2 is exactly `unitPrice x quantity`.
 *
 * Returns minor units throughout. `perMonthMinor` is the floor of the even
 * split and `finalMonthMinor` carries the remainder, which is what the plan
 * list displays.
 */
const quote = ({ unitPriceMinor, quantity, paymentType, plan = null }) => {
  const qty = Math.trunc(Number(quantity)) || 0;
  const baseMinor = asMinor(unitPriceMinor) * qty;

  if (String(paymentType) !== 'installment') {
    return {
      paymentType: 'outright',
      quantity: qty,
      unitPriceMinor: asMinor(unitPriceMinor),
      baseMinor,
      surchargeMinor: 0,
      subtotalMinor: baseMinor,
      totalMinor: baseMinor,
      durationMonths: 0,
      perMonthMinor: 0,
      finalMonthMinor: 0,
      roundingAdjustmentMinor: 0,
      terms: null,
    };
  }

  const terms = planTerms(plan);
  const surchargeMinor = surchargeFor(baseMinor, terms);
  const subtotalMinor = baseMinor + surchargeMinor;
  const totalMinor = applyRounding(subtotalMinor, terms.roundingRule);
  const parts = splitEvenly(totalMinor, terms.durationMonths);

  return {
    paymentType: 'installment',
    quantity: qty,
    unitPriceMinor: asMinor(unitPriceMinor),
    baseMinor,
    surchargeMinor,
    subtotalMinor,
    totalMinor,
    durationMonths: terms.durationMonths,
    perMonthMinor: parts[0] ?? 0,
    finalMonthMinor: parts[parts.length - 1] ?? 0,
    // Rounding is shown separately from the surcharge so the plan list can
    // state the plan charge exactly (FRD 4.1) without folding a rounding
    // adjustment into it.
    roundingAdjustmentMinor: totalMinor - subtotalMinor,
    terms,
  };
};

/**
 * Adds whole calendar months, clamping to the end of the target month.
 *
 * 31 January plus one month is 28 February, not 3 March — which is what
 * `setMonth` alone does, and it would drift every subsequent schedule of a plan
 * bought at month end.
 */
const addMonths = (date, months) => {
  const start = new Date(date);
  const target = new Date(Date.UTC(
    start.getUTCFullYear(), start.getUTCMonth() + months, 1,
    start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), 0,
  ));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(start.getUTCDate(), lastDay));
  return target;
};

/**
 * The schedule set for an installment invoice (FRD 9.1).
 *
 * Schedule n falls due n calendar months after the invoice date, so schedule 1
 * is due one month after creation rather than on the day — FRD 15.1's stated
 * default. Nothing else in the journey assumes that, so moving to a
 * deposit-on-purchase model is a change to `firstDueOffsetMonths` alone.
 *
 * The final schedule carries the rounding remainder, and the returned
 * principals sum to `totalMinor` exactly.
 */
const buildSchedules = ({ totalMinor, durationMonths, from, firstDueOffsetMonths = 1 }) => {
  const parts = splitEvenly(totalMinor, durationMonths);
  const start = from ? new Date(from) : new Date();
  return parts.map((principalMinor, index) => ({
    sequence: index + 1,
    due_date: addMonths(start, index + firstDueOffsetMonths),
    principal_minor: principalMinor,
    principal_outstanding_minor: principalMinor,
    fee_accrued_minor: 0,
    fee_outstanding_minor: 0,
    timing_status: 'upcoming',
    settlement_status: 'unpaid',
  }));
};

/**
 * The default fee due on an unsettled schedule once grace elapses (FRD 9.3).
 *
 * Percentage applies to the schedule's OUTSTANDING principal (FRD 15.3), so a
 * part-paid schedule is charged on what is still owed rather than on the
 * original amount.
 */
const defaultFeeFor = (schedule, terms) => {
  if (terms.defaultFeeType === 'percentage') {
    return percentageOf(schedule.principal_outstanding_minor, terms.defaultFeeValue);
  }
  if (terms.defaultFeeType === 'flat') return toMinor(terms.defaultFeeValue);
  return 0;
};

module.exports = {
  PAYMENT_TYPES,
  planTerms,
  snapshotOf,
  surchargeFor,
  quote,
  addMonths,
  buildSchedules,
  defaultFeeFor,
};

/**
 * Money as integer minor units (kobo), and the plan rounding rules.
 *
 * The rest of the schema stores money as DECIMAL(12,2), which is fine for
 * holding a figure. It is not fine for DERIVING one: a percentage surcharge on
 * a float drifts, and once it drifts the installment schedules no longer sum to
 * the invoice total — the one arithmetic error in this design that silently
 * misstates what a client owes.
 *
 * So every calculation in the purchase journey runs here, in integers, and
 * converts back to major units only at the boundary with the older columns.
 * The new tables (installment plans, payment schedules, allocations) store
 * minor units directly and never need the round trip.
 */

/** Minor units per major unit. NGN throughout — see FRD 15.9. */
const MINOR_PER_MAJOR = 100;

const ROUNDING_RULES = ['none', 'nearest_100', 'nearest_1000', 'up_to_1000'];
const SURCHARGE_TYPES = ['none', 'percentage', 'flat'];
const DEFAULT_FEE_TYPES = ['none', 'percentage', 'flat'];
const DEFAULT_FEE_RECURRENCES = ['once', 'monthly'];

/**
 * Major units (a DECIMAL column, a JSON number, a form string) -> minor units.
 *
 * Rounds rather than truncates: `2699.999999` out of a float division is 2700,
 * not 2699.99. Anything unparseable is 0 — a NaN reaching a BIGINT column
 * fails the insert, and a blank price field is a legitimate 0.
 */
const toMinor = (value) => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * MINOR_PER_MAJOR);
};

/** Minor units -> a major-unit number, for the DECIMAL(12,2) columns. */
const toMajor = (minor) => {
  const amount = Number(minor);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount) / MINOR_PER_MAJOR;
};

/**
 * Coerces to a whole number of minor units.
 *
 * MySQL hands BIGINT back as a string once it exceeds the JS safe range, and as
 * a number below it, so every read of a `_minor` column goes through here
 * before arithmetic.
 */
const asMinor = (value) => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.trunc(amount);
};

/**
 * A percentage of a minor-unit amount, rounded half-up to the nearest kobo.
 *
 * `rate` is a human percentage — 2 means 2%, matching what an admin types into
 * the plan form.
 */
const percentageOf = (minor, rate) => {
  const pct = Number(rate);
  if (!Number.isFinite(pct) || pct === 0) return 0;
  return Math.round((asMinor(minor) * pct) / 100);
};

/**
 * FRD 3.1 rounding rules, applied to the post-surcharge subtotal.
 *
 * The step values are in MAJOR units in the rule names ("nearest 100" means
 * ₦100), so they are scaled to minor here. `up_to_1000` always rounds away from
 * zero to the next ₦1,000 — a subtotal already on the step stays put.
 */
const applyRounding = (minor, rule) => {
  const amount = asMinor(minor);
  const step = { nearest_100: 100, nearest_1000: 1000, up_to_1000: 1000 }[rule];
  if (!step) return amount;
  const stepMinor = step * MINOR_PER_MAJOR;
  return String(rule) === 'up_to_1000'
    ? Math.ceil(amount / stepMinor) * stepMinor
    : Math.round(amount / stepMinor) * stepMinor;
};

/**
 * Splits a total across `count` installments.
 *
 * Each installment is the floor of the even split and the remainder lands on
 * the FINAL one (FRD 4, 9.1), so the parts always sum back to the total exactly.
 * That identity is what the "schedules sum to the invoice total" acceptance
 * criterion checks, and it is why the split is integer-only.
 */
const splitEvenly = (totalMinor, count) => {
  const total = asMinor(totalMinor);
  const parts = Math.trunc(Number(count));
  if (!Number.isFinite(parts) || parts < 1) return [];
  const each = Math.floor(total / parts);
  const amounts = new Array(parts).fill(each);
  amounts[parts - 1] = total - each * (parts - 1);
  return amounts;
};

module.exports = {
  MINOR_PER_MAJOR,
  ROUNDING_RULES,
  SURCHARGE_TYPES,
  DEFAULT_FEE_TYPES,
  DEFAULT_FEE_RECURRENCES,
  toMinor,
  toMajor,
  asMinor,
  percentageOf,
  applyRounding,
  splitEvenly,
};

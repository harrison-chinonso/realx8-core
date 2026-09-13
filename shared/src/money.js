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

/**
 * Rounding modes for a single figure, as FR-CAP-008 requires them.
 *
 * Distinct from applyRounding above, which snaps a subtotal to a ₦100/₦1,000
 * step for presentation on an installment schedule. This rounds to the kobo and
 * only decides what happens exactly on the half.
 *
 * `half_even` (banker's rounding) is offered because a plan that prorates
 * hundreds of deals a month with half_up accumulates a small upward bias
 * against the company; half_even does not.
 */
const ROUNDING_MODES = ['half_up', 'half_even', 'floor'];

const roundWith = (value, mode = 'half_up') => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  if (mode === 'floor') return Math.floor(amount);
  if (mode === 'half_even') {
    const floor = Math.floor(amount);
    const fraction = amount - floor;
    if (fraction > 0.5) return floor + 1;
    if (fraction < 0.5) return floor;
    // Exactly on the half: go to the even neighbour.
    return floor % 2 === 0 ? floor : floor + 1;
  }
  return Math.floor(amount + 0.5);
};

/**
 * Divides `total` among `weights` so that the parts sum to `total` EXACTLY.
 *
 * This is the constraint phase's arithmetic (§7 of the pipeline) and the reason
 * it cannot be "multiply each share by a factor and round".
 *
 * Rounding each share independently leaves a residual: four participants
 * prorated by 8/9 will be a kobo or two short of, or over, the pool. A pool is
 * a hard ceiling — over is a company paying more than its own cap — and a
 * shortfall is money that belongs to nobody and reconciles against nothing. The
 * FRD requires (FR-CAP-008) that allocations "always reconcile exactly to the
 * pool", and AC-001 checks that the total equals the cap to the kobo.
 *
 * So: floor every share, then hand the remaining units out one at a time to
 * whoever was cut by the most — the largest-remainder method. Every participant
 * is within one kobo of their exact share, the parts sum to the total by
 * construction, and the result does not depend on the order the participants
 * happen to arrive in, because ties break on weight and then on index.
 *
 * Returns integers in the same unit as `total`; pass minor units.
 */
const allocateByWeight = (totalMinor, weights) => {
  const total = asMinor(totalMinor);
  const values = weights.map((weight) => {
    const number = Number(weight);
    return Number.isFinite(number) && number > 0 ? number : 0;
  });
  const sum = values.reduce((running, weight) => running + weight, 0);

  // Nothing to divide by. Returning zeros rather than throwing: a deal whose
  // participants all have a zero entitlement is a legitimate outcome, and the
  // caller decides whether that is breakage.
  if (!values.length || sum <= 0 || total === 0) return values.map(() => 0);

  const exact = values.map((weight) => (total * weight) / sum);
  const floors = exact.map((share) => Math.floor(share));
  let residual = total - floors.reduce((running, share) => running + share, 0);

  /**
   * Who gets the leftover units, in order.
   *
   * By fractional part first — that is the participant the floor cut hardest.
   * Then by weight, so that between two equally-cut participants the larger
   * claim is served first, and finally by index so the answer is deterministic
   * for two participants identical in both. Without that last tiebreak the same
   * deal could allocate differently on a recalculation, which would show up as
   * a phantom one-kobo delta in FR-CLC-006.
   */
  const order = exact
    .map((share, index) => ({ index, fraction: share - floors[index], weight: values[index] }))
    .sort((a, b) => (b.fraction - a.fraction)
      || (b.weight - a.weight)
      || (a.index - b.index));

  const allocated = [...floors];
  for (let i = 0; residual > 0 && i < order.length; i += 1) {
    allocated[order[i].index] += 1;
    residual -= 1;
  }
  // A negative residual cannot arise from flooring, but a caller passing a
  // total smaller than the participant count would produce one; absorb it on
  // the smallest shares rather than returning parts that do not sum.
  for (let i = order.length - 1; residual < 0 && i >= 0; i -= 1) {
    if (allocated[order[i].index] > 0) { allocated[order[i].index] -= 1; residual += 1; }
  }

  return allocated;
};

module.exports = {
  MINOR_PER_MAJOR,
  ROUNDING_MODES,
  roundWith,
  allocateByWeight,
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

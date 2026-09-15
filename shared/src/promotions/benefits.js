const { asMinor, allocateByWeight } = require('../money');
const { BENEFIT, BASIS, TIER_ON } = require('./types');

/**
 * What a qualifying promotion is actually worth, in money.
 *
 * ── The discount is allocated to LINES, not left as a lump ──────────────────
 *
 * A basket-level discount of ₦4m is easy to compute and useless afterwards. The
 * invoice has to show what each unit cost, a part-refund has to know which
 * unit's money to give back, and the commission engine has to know what the
 * sale was worth per line. So every benefit ends up spread across the
 * qualifying lines by `allocateByWeight`, which puts the remainder where it
 * belongs instead of losing a kobo to rounding.
 *
 * ── Nothing here touches the unit's configured price ────────────────────────
 *
 * The FRD's central rule. Every function takes `unit_price_minor` and returns a
 * DISCOUNT; no function returns a new price. The promotional price is always
 * derived — original minus discount — so an expiring campaign cannot leave a
 * changed price behind, and a historical transaction keeps what it was given.
 */

/** Never more than the line is worth, and never negative. */
const clamp = (discount, ceiling) => Math.max(Math.min(discount, ceiling), 0);

/** The value of a set of lines at their own prices. */
const valueOf = (lines = []) => lines.reduce(
  (sum, line) => sum + asMinor(line.unit_price_minor) * (Number(line.quantity) || 0), 0,
);

/**
 * Which tier a basket falls into.
 *
 * Tiers are matched on the HIGHEST threshold the basket reaches, whatever order
 * they were configured in. An admin who lists them out of order gets the right
 * answer rather than a silently wrong one, and a basket that reaches no tier
 * gets nothing rather than the first.
 */
const tierFor = (promotion, { quantity, value_minor: valueMinor }) => {
  const tiers = promotion.tiers || [];
  if (!tiers.length) return null;

  const on = promotion.tier_on || TIER_ON.QUANTITY;
  const measured = on === TIER_ON.VALUE ? asMinor(valueMinor) : Number(quantity) || 0;

  const reached = tiers
    .filter((tier) => measured >= Number(tier.from ?? tier.min ?? 0))
    .sort((a, b) => Number(a.from ?? a.min ?? 0) - Number(b.from ?? b.min ?? 0));

  return reached.length ? reached[reached.length - 1] : null;
};

/**
 * Buy X, get Y — free or discounted.
 *
 * ── How many rewards ────────────────────────────────────────────────────────
 *
 * `repeatable` is the difference between "buy 2 get 1" meaning one free unit
 * however many you buy, and meaning three free units when you buy six. Both
 * campaigns exist and they cost the company very different amounts, so it is a
 * setting and not an assumption.
 *
 * ── The reward has to be IN the basket ──────────────────────────────────────
 *
 * A free half plot is only free if the buyer is taking one. If the reward unit
 * is not in the basket the promotion qualifies but pays nothing, and the caller
 * is told so — that is a prompt to add it, not a failure. Silently discounting
 * a unit they did not ask for would put something on their invoice they never
 * chose.
 */
const buyXGetY = (promotion, qualifying = [], basket = {}) => {
  const config = promotion.buy_x_get_y || {};
  const buyQty = Math.max(Number(config.buy_quantity) || 0, 0);
  const rewardQty = Math.max(Number(config.reward_quantity) || 0, 0);
  if (buyQty <= 0 || rewardQty <= 0) {
    return { discount_minor: 0, allocations: [], note: 'buy_x_get_y_not_configured' };
  }

  /**
   * The qualifying count is of the unit the promotion NAMES, where it names
   * one — "buy 2 full plots" is not satisfied by two half plots. Where it names
   * none, any line in scope counts.
   */
  const buyUnitId = config.buy_unit_id == null ? null : Number(config.buy_unit_id);
  const counting = buyUnitId == null
    ? qualifying
    : qualifying.filter((line) => Number(line.unit_id) === buyUnitId);
  const bought = counting.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);

  if (bought < buyQty) {
    return { discount_minor: 0, allocations: [], note: 'not_enough_qualifying_units' };
  }

  const rewardUnitId = config.reward_unit_id == null ? buyUnitId : Number(config.reward_unit_id);

  /**
   * How big a "set" is, and it depends on whether the reward is the SAME unit.
   *
   * "Buy 2 full plots, get a half plot" — the set is 2 full plots, because the
   * reward comes out of a different line and does not consume any of them.
   *
   * "Buy 2, get the 3rd at 20% off" — the set is THREE, not two. Nine units is
   * three complete sets and therefore three rewards. Counting sets as
   * floor(9/2) = 4 and then discovering only one unit is left over gives one
   * reward, which is both wrong and wrong in the company's favour — the buyer
   * is shortchanged on an offer that was advertised to them.
   */
  const rewardIsQualifier = rewardUnitId != null && rewardUnitId === buyUnitId;
  const setSize = rewardIsQualifier ? buyQty + rewardQty : buyQty;

  const sets = config.repeatable
    ? Math.floor(bought / setSize)
    : (bought >= setSize ? 1 : 0);

  let rewardsEarned = sets * rewardQty;
  if (config.max_rewards) rewardsEarned = Math.min(rewardsEarned, Number(config.max_rewards));

  if (rewardsEarned <= 0) {
    return { discount_minor: 0, allocations: [], rewards_earned: 0, note: 'not_enough_qualifying_units' };
  }
  const rewardLines = (basket.lines || []).filter(
    (line) => rewardUnitId == null || Number(line.unit_id) === rewardUnitId,
  );
  if (!rewardLines.length) {
    return {
      discount_minor: 0, allocations: [], rewards_earned: rewardsEarned,
      note: 'reward_unit_not_in_basket',
    };
  }

  /**
   * A reward cannot be a unit that was needed to QUALIFY.
   *
   * "Buy 2, get the 3rd free" on a basket of two must give nothing — otherwise
   * the buyer pays for one and gets one, which is not the offer. So when the
   * reward is the same unit as the qualifier, only the units beyond those
   * consumed by the qualifying sets are rewardable.
   */
  const rewardPercentage = config.reward_discount_percentage == null
    ? 100
    : Math.min(Math.max(Number(config.reward_discount_percentage), 0), 100);

  const allocations = [];
  let remaining = rewardsEarned;
  let discount = 0;

  for (const line of rewardLines) {
    if (remaining <= 0) break;
    /**
     * When the reward is the same unit, the units that EARNED the reward
     * cannot also be the reward. Each set contributes `buyQty` paid units, and
     * only what is left over is rewardable.
     */
    const consumedByQualifying = rewardIsQualifier ? sets * buyQty : 0;
    const rewardable = Math.max((Number(line.quantity) || 0) - consumedByQualifying, 0);
    const take = Math.min(remaining, rewardable);
    if (take <= 0) continue;

    const perUnit = Math.floor((asMinor(line.unit_price_minor) * rewardPercentage) / 100);
    const lineDiscount = perUnit * take;
    allocations.push({
      unit_id: Number(line.unit_id),
      quantity: take,
      discount_minor: lineDiscount,
      reward_percentage: rewardPercentage,
    });
    discount += lineDiscount;
    remaining -= take;
  }

  return {
    discount_minor: discount,
    allocations,
    rewards_earned: rewardsEarned,
    rewards_granted: rewardsEarned - remaining,
    note: remaining > 0 && !allocations.length ? 'reward_unit_not_in_basket' : null,
  };
};

/**
 * Turn a qualifying promotion into a discount and its per-line allocation.
 *
 * @param {object} promotion
 * @param {object} qualification  what evaluateConditions returned
 * @param {object} basket
 * @returns {{ discount_minor, allocations[], capped, benefit_type, detail }}
 */
const applyBenefit = (promotion, qualification = {}, basket = {}) => {
  const qualifying = qualification.lines || [];
  const basis = promotion.basis === BASIS.WHOLE_BASKET ? (basket.lines || []) : qualifying;
  const basisValue = valueOf(basis);

  const type = promotion.benefit_type;
  let raw = 0;
  let allocations = [];
  let detail = {};

  switch (type) {
    case BENEFIT.PERCENTAGE: {
      const percentage = Math.min(Math.max(Number(promotion.percentage) || 0, 0), 100);
      /**
       * Rounded DOWN. A discount that rounds up gives away a kobo the company
       * never agreed to, on every line, forever — and it is the direction that
       * cannot be explained to an accountant.
       */
      raw = Math.floor((basisValue * percentage) / 100);
      detail = { percentage, basis_value_minor: basisValue };
      break;
    }

    case BENEFIT.FIXED_AMOUNT: {
      raw = clamp(asMinor(promotion.amount_minor), basisValue);
      detail = { requested_minor: asMinor(promotion.amount_minor), basis_value_minor: basisValue };
      break;
    }

    case BENEFIT.TIERED: {
      const tier = tierFor(promotion, qualification);
      if (!tier) {
        return {
          discount_minor: 0, allocations: [], capped: false, benefit_type: type,
          detail: { reason: 'no_tier_reached' },
        };
      }
      raw = tier.percentage != null
        ? Math.floor((basisValue * Math.min(Math.max(Number(tier.percentage), 0), 100)) / 100)
        : clamp(asMinor(tier.amount_minor), basisValue);
      detail = { tier, basis_value_minor: basisValue };
      break;
    }

    case BENEFIT.BUY_X_GET_Y: {
      const result = buyXGetY(promotion, qualifying, basket);
      raw = result.discount_minor;
      allocations = result.allocations;
      detail = {
        rewards_earned: result.rewards_earned ?? 0,
        rewards_granted: result.rewards_granted ?? 0,
        note: result.note,
      };
      break;
    }

    case BENEFIT.NON_MONETARY:
      /**
       * Worth nothing in money and everything to the buyer who was promised it.
       * Carried through as a named perk so whoever fulfils it knows, rather
       * than being dropped because it does not fit in a discount column.
       */
      return {
        discount_minor: 0,
        allocations: [],
        capped: false,
        benefit_type: type,
        perks: promotion.perks || [],
        detail: { basis_value_minor: basisValue },
      };

    default:
      return {
        discount_minor: 0, allocations: [], capped: false, benefit_type: type,
        detail: { reason: 'unknown_benefit_type' },
      };
  }

  /**
   * The company's ceiling on its own generosity.
   *
   * "20% off, maximum ₦10m" exists because a percentage on a large enough
   * basket is an unbounded promise. Applied AFTER the calculation so the
   * breakdown can show what was claimed and what was actually given.
   */
  const ceiling = asMinor(promotion.max_discount_minor);
  const capped = ceiling > 0 && raw > ceiling;
  const discount = capped ? ceiling : raw;

  /**
   * Spread across the lines. BUY_X_GET_Y has already allocated itself — its
   * discount belongs to specific reward units and must not be smeared over the
   * basket — so it is left alone, unless the cap changed the total, in which
   * case its own allocation is scaled to match.
   */
  if (type === BENEFIT.BUY_X_GET_Y) {
    if (capped && raw > 0) {
      const shares = allocateByWeight(discount, allocations.map((a) => a.discount_minor));
      allocations = allocations.map((a, index) => ({ ...a, discount_minor: shares[index] }));
    }
  } else if (discount > 0) {
    const weights = basis.map((line) => asMinor(line.unit_price_minor) * (Number(line.quantity) || 0));
    const shares = allocateByWeight(discount, weights);
    allocations = basis.map((line, index) => ({
      unit_id: Number(line.unit_id),
      quantity: Number(line.quantity) || 0,
      discount_minor: shares[index],
    })).filter((a) => a.discount_minor > 0);
  }

  return {
    discount_minor: discount,
    allocations,
    capped,
    claimed_minor: raw,
    benefit_type: type,
    perks: promotion.perks || [],
    detail,
  };
};

module.exports = { applyBenefit, tierFor, buyXGetY, valueOf };

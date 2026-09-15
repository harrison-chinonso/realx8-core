const { asMinor } = require('../money');
const { AUDIENCE, PAYMENT_CONDITION, STATUS, APPLICABLE_STATUSES } = require('./types');

/**
 * Whether a basket qualifies for a promotion.
 *
 * ── Every answer says WHY ───────────────────────────────────────────────────
 *
 * A qualification check that returns false is nearly useless to the person who
 * configured the campaign: they are looking at a basket that they believe
 * should qualify and the system is silently disagreeing. So every refusal
 * carries a `reason` and a human sentence, and the preview screen shows them.
 * Most misconfigured promotions are found this way rather than by a customer
 * complaining that an advertised discount did nothing.
 *
 * ── Nothing here reads the clock or the database ────────────────────────────
 *
 * `now`, the buyer's history and the redemption counts are all passed in. That
 * is what makes a promotion testable against a date it is not yet, which is the
 * whole point of the preview.
 */

/**
 * A basket line.
 *
 * @typedef {object} Line
 * @property {number} unit_id
 * @property {number} property_id
 * @property {number} quantity
 * @property {number} unit_price_minor   the unit's OWN configured price, never
 *                                       a promotional one — see applyBenefit
 */

/** Lines the promotion's scope actually covers. */
const qualifyingLines = (promotion, lines = []) => {
  const scope = promotion.scope || {};

  /**
   * An empty scope means the whole company, not nothing.
   *
   * The opposite reading is defensible and is the wrong one here: a promotion
   * saved with no scope is almost always one an admin has not finished, and
   * "applies to everything" is the dangerous interpretation. But the
   * VALIDATOR refuses to activate a scopeless promotion, so by the time this
   * runs the scope has been chosen deliberately — and a company-wide campaign
   * has to be expressible.
   */
  const unitIds = scope.unit_ids?.length ? new Set(scope.unit_ids.map(Number)) : null;
  const propertyIds = scope.property_ids?.length ? new Set(scope.property_ids.map(Number)) : null;

  return lines.filter((line) => {
    if (unitIds && unitIds.has(Number(line.unit_id))) return true;
    if (propertyIds && propertyIds.has(Number(line.property_id))) return true;
    // Named neither way: in scope only when the promotion names nothing at all.
    return !unitIds && !propertyIds;
  });
};

const totalQuantity = (lines = []) => lines.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);

const totalValue = (lines = []) => lines.reduce(
  (sum, line) => sum + asMinor(line.unit_price_minor) * (Number(line.quantity) || 0), 0,
);

/**
 * Whether the basket contains a required COMBINATION of unit types.
 *
 * This is the rule that makes real-estate promotions different from retail
 * ones: "buy 2 full plots and 1 half plot" is not a quantity rule and not a
 * value rule, and expressing it as either loses the thing that matters.
 *
 * Each requirement names a unit and a minimum. The basket satisfies the
 * combination when every requirement is met — an AND, because "buy a full plot
 * OR a half plot" is simply two promotions and modelling it as one would make
 * the benefit ambiguous.
 */
const meetsCombination = (combination = [], lines = []) => {
  if (!combination.length) return { ok: true, missing: [] };

  const have = new Map();
  for (const line of lines) {
    const key = Number(line.unit_id);
    have.set(key, (have.get(key) || 0) + (Number(line.quantity) || 0));
  }

  const missing = combination
    .map((requirement) => {
      const needed = Math.max(Number(requirement.quantity) || 0, 0);
      const held = have.get(Number(requirement.unit_id)) || 0;
      return held >= needed
        ? null
        : { unit_id: Number(requirement.unit_id), needed, held, label: requirement.label || null };
    })
    .filter(Boolean);

  return { ok: missing.length === 0, missing };
};

/** Whether the promotion's dates enclose the moment being asked about. */
const withinDates = (promotion, now) => {
  const at = new Date(now);
  if (Number.isNaN(at.getTime())) return false;

  if (promotion.starts_at) {
    const from = new Date(promotion.starts_at);
    if (!Number.isNaN(from.getTime()) && at < from) return false;
  }
  if (promotion.ends_at) {
    const to = new Date(promotion.ends_at);
    /**
     * The end date is INCLUSIVE of its whole day when it carries no time.
     *
     * "Valid to 31 October" means the 31st counts. Storing a bare date and
     * comparing it as midnight would end the campaign a day early — the kind of
     * error that is only noticed by the customers it turned away.
     */
    if (!Number.isNaN(to.getTime())) {
      const endsMidnight = to.getUTCHours() === 0 && to.getUTCMinutes() === 0 && to.getUTCSeconds() === 0;
      const boundary = endsMidnight ? to.getTime() + 24 * 60 * 60 * 1000 - 1 : to.getTime();
      if (at.getTime() > boundary) return false;
    }
  }
  return true;
};

/** Whether the buyer is one of the people this campaign is for. */
const audienceAllows = (promotion, buyer = {}) => {
  const rule = promotion.eligibility || {};
  const audience = rule.audience || AUDIENCE.EVERYONE;

  switch (audience) {
    case AUDIENCE.EVERYONE:
      return { ok: true };

    case AUDIENCE.NEW_CUSTOMERS:
      return Number(buyer.completed_purchases) > 0
        ? { ok: false, reason: 'not_a_new_customer', message: 'This offer is for first-time buyers.' }
        : { ok: true };

    case AUDIENCE.EXISTING_CUSTOMERS:
      return Number(buyer.completed_purchases) > 0
        ? { ok: true }
        : { ok: false, reason: 'not_an_existing_customer', message: 'This offer is for returning buyers.' };

    case AUDIENCE.FIRST_PURCHASE:
      return Number(buyer.completed_purchases) > 0
        ? { ok: false, reason: 'not_first_purchase', message: 'This offer applies to a first purchase only.' }
        : { ok: true };

    case AUDIENCE.SELECTED_CUSTOMERS: {
      const allowed = new Set((rule.customer_ids || []).map(Number));
      return allowed.has(Number(buyer.id))
        ? { ok: true }
        : { ok: false, reason: 'customer_not_selected', message: 'This offer is for selected buyers.' };
    }

    case AUDIENCE.CUSTOMER_CATEGORY: {
      const allowed = new Set((rule.categories || []).map(String));
      return allowed.has(String(buyer.category))
        ? { ok: true }
        : { ok: false, reason: 'category_not_eligible', message: 'This offer is for a different customer group.' };
    }

    case AUDIENCE.SELECTED_REALTORS: {
      const allowed = new Set((rule.realtor_ids || []).map(Number));
      return allowed.has(Number(buyer.realtor_id))
        ? { ok: true }
        : { ok: false, reason: 'realtor_not_participating', message: 'This offer is for buyers introduced by participating agents.' };
    }

    case AUDIENCE.REALTOR_LEVELS: {
      const allowed = new Set((rule.realtor_level_ids || []).map(Number));
      return allowed.has(Number(buyer.realtor_level_id))
        ? { ok: true }
        : { ok: false, reason: 'realtor_level_not_eligible', message: 'This offer is for buyers introduced by agents at a particular level.' };
    }

    default:
      /**
       * An audience nobody recognises does NOT quietly become "everyone".
       *
       * A restriction the engine cannot understand is a restriction it must
       * honour: reading it as unrestricted would hand a targeted discount to
       * the whole world because somebody mistyped a setting.
       */
      return { ok: false, reason: 'unknown_audience', message: 'This offer has an eligibility rule the system does not recognise.' };
  }
};

/** Whether the chosen payment arrangement is one the promotion allows. */
const paymentAllows = (promotion, context = {}) => {
  const condition = promotion.payment_condition || PAYMENT_CONDITION.ANY;
  const paymentType = String(context.payment_type || '').toLowerCase();

  if (condition === PAYMENT_CONDITION.OUTRIGHT_ONLY && paymentType !== 'outright') {
    return { ok: false, reason: 'outright_only', message: 'This offer applies to outright payment only.' };
  }
  if (condition === PAYMENT_CONDITION.INSTALLMENT_ONLY && paymentType !== 'installment') {
    return { ok: false, reason: 'installment_only', message: 'This offer applies to instalment plans only.' };
  }

  /** A named set of instalment plans, for "10% off the 3-month plan". */
  const plans = promotion.installment_plan_ids || [];
  if (plans.length && paymentType === 'installment') {
    if (!plans.map(Number).includes(Number(context.installment_plan_id))) {
      return { ok: false, reason: 'plan_not_eligible', message: 'This offer applies to a different instalment plan.' };
    }
  }

  /** A minimum proportion paid up front, for "₦1m off if you pay 50% now". */
  const minimumUpfront = Number(promotion.min_upfront_percentage) || 0;
  if (minimumUpfront > 0) {
    const offered = Number(context.upfront_percentage) || 0;
    if (offered < minimumUpfront) {
      return {
        ok: false,
        reason: 'upfront_too_low',
        message: `This offer needs at least ${minimumUpfront}% paid up front.`,
      };
    }
  }

  return { ok: true };
};

/** Whether the campaign has any redemptions left. */
const withinUsageLimits = (promotion, usage = {}) => {
  const limits = promotion.limits || {};

  if (limits.total_redemptions
    && Number(usage.total_redemptions) >= Number(limits.total_redemptions)) {
    return { ok: false, reason: 'fully_redeemed', message: 'This offer has been fully taken up.' };
  }
  if (limits.per_customer
    && Number(usage.customer_redemptions) >= Number(limits.per_customer)) {
    return { ok: false, reason: 'customer_limit_reached', message: 'You have already used this offer.' };
  }
  if (limits.per_day
    && Number(usage.today_redemptions) >= Number(limits.per_day)) {
    return { ok: false, reason: 'daily_limit_reached', message: "Today's allocation for this offer has gone." };
  }
  if (limits.total_units
    && Number(usage.units_redeemed) >= Number(limits.total_units)) {
    return { ok: false, reason: 'unit_limit_reached', message: 'The units set aside for this offer have all been taken.' };
  }
  return { ok: true };
};

/**
 * The whole question, in one call.
 *
 * @returns {{ ok, reason, message, lines, quantity, value_minor }}
 *   `lines` is the qualifying subset, which the benefit calculation needs and
 *   which the preview shows so an admin can see WHAT qualified, not only that
 *   something did.
 */
const evaluateConditions = (promotion, basket = {}, context = {}) => {
  const refuse = (reason, message, extra = {}) => ({ ok: false, reason, message, ...extra });

  if (!APPLICABLE_STATUSES.has(promotion.status)) {
    const words = {
      [STATUS.DRAFT]: 'has not been published yet',
      [STATUS.SCHEDULED]: 'has not started yet',
      [STATUS.PAUSED]: 'is paused',
      [STATUS.EXPIRED]: 'has ended',
      [STATUS.DEACTIVATED]: 'has been switched off',
      [STATUS.ARCHIVED]: 'has been archived',
    };
    return refuse('not_active', `This offer ${words[promotion.status] || 'is not available'}.`);
  }

  if (!withinDates(promotion, context.now || new Date())) {
    return refuse('outside_dates', 'This offer is not running at the moment.');
  }

  const audience = audienceAllows(promotion, context.buyer || {});
  if (!audience.ok) return refuse(audience.reason, audience.message);

  const payment = paymentAllows(promotion, context);
  if (!payment.ok) return refuse(payment.reason, payment.message);

  const usage = withinUsageLimits(promotion, context.usage || {});
  if (!usage.ok) return refuse(usage.reason, usage.message);

  const lines = qualifyingLines(promotion, basket.lines || []);
  if (!lines.length) {
    return refuse('nothing_in_scope', 'Nothing in this purchase is covered by the offer.');
  }

  const combination = meetsCombination(promotion.combination || [], lines);
  if (!combination.ok) {
    const first = combination.missing[0];
    return refuse('combination_not_met',
      `This offer needs ${first.needed} × ${first.label || `unit #${first.unit_id}`}`
      + ` and this purchase has ${first.held}.`,
      { missing: combination.missing });
  }

  const quantity = totalQuantity(lines);
  const value = totalValue(lines);

  const minQuantity = Number(promotion.min_quantity) || 0;
  if (minQuantity && quantity < minQuantity) {
    return refuse('below_min_quantity',
      `This offer needs at least ${minQuantity} unit${minQuantity === 1 ? '' : 's'}; this purchase has ${quantity}.`,
      { quantity });
  }

  const minValue = asMinor(promotion.min_purchase_minor);
  if (minValue && value < minValue) {
    return refuse('below_min_value',
      'This purchase is below the minimum this offer requires.',
      { value_minor: value, required_minor: minValue });
  }

  return { ok: true, lines, quantity, value_minor: value };
};

module.exports = {
  qualifyingLines, totalQuantity, totalValue,
  meetsCombination, withinDates, audienceAllows, paymentAllows, withinUsageLimits,
  evaluateConditions,
};

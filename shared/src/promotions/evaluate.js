const { asMinor } = require('../money');
const { RESOLUTION, TRIGGER } = require('./types');
const { evaluateConditions } = require('./conditions');
const { applyBenefit, valueOf } = require('./benefits');

/**
 * Deciding what a basket actually costs, given every promotion a company is
 * running.
 *
 * ── The one thing this module must never do ─────────────────────────────────
 *
 * Return a price. It returns the ORIGINAL amount and a DISCOUNT, and the
 * promotional amount is their difference. Every other design lets a campaign
 * leak into the property's own pricing, and then expiring it is a data
 * migration rather than a date passing.
 *
 * ── Why a losing promotion is still reported ────────────────────────────────
 *
 * `considered` carries every promotion that was looked at and what happened to
 * it — qualified, refused and why, or qualified but beaten. Without it the
 * commonest support question ("why didn't my discount apply?") has no answer
 * except reading the configuration and guessing, and the preview screen has
 * nothing to show an admin except silence.
 */

/** A promotion's own benefit, as a comparable number. */
const benefitOf = (outcome) => outcome?.benefit?.discount_minor || 0;

/**
 * Sorts candidates into the order the company asked for.
 *
 * Priority is ascending — 1 is first — because administrators write priority
 * lists that way and a screen that says "priority 1" meaning "last" is a bug
 * report waiting to happen.
 */
const byPriority = (a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0);

/**
 * Evaluate every candidate promotion against a basket.
 *
 * @param {object[]} promotions  the candidates, already narrowed to the
 *        company and its properties by whoever loaded them
 * @param {object} basket  { lines: [{ unit_id, property_id, quantity, unit_price_minor }] }
 * @param {object} context {
 *          now, buyer, payment_type, installment_plan_id, upfront_percentage,
 *          usage: { [promotionId]: { total_redemptions, customer_redemptions, ... } },
 *          codes: ['BLACKFRIDAY20'],
 *          resolution: RESOLUTION.*
 *        }
 */
const evaluateBasket = (promotions = [], basket = {}, context = {}) => {
  const originalMinor = valueOf(basket.lines || []);
  const strategy = context.resolution || RESOLUTION.HIGHEST_BENEFIT;
  const offered = new Set((context.codes || []).map((code) => String(code).trim().toUpperCase()));

  const considered = [];
  const qualified = [];

  for (const promotion of promotions) {
    /**
     * A code promotion is invisible until its code is typed.
     *
     * Checked before the conditions so an untyped private code reports
     * `code_required` rather than whatever else it might have failed on — the
     * buyer needs to know a code exists, not that their basket is too small
     * for an offer they have never heard of.
     */
    if ((promotion.trigger || TRIGGER.AUTOMATIC) === TRIGGER.CODE) {
      const code = String(promotion.code || '').trim().toUpperCase();
      if (!code || !offered.has(code)) {
        considered.push({
          promotion_id: promotion.id,
          name: promotion.name,
          applied: false,
          reason: 'code_required',
          message: 'This offer needs a promotion code.',
        });
        continue;
      }
    }

    const usage = (context.usage || {})[promotion.id] || {};
    const qualification = evaluateConditions(promotion, basket, { ...context, usage });

    if (!qualification.ok) {
      considered.push({
        promotion_id: promotion.id,
        name: promotion.name,
        applied: false,
        reason: qualification.reason,
        message: qualification.message,
        missing: qualification.missing,
      });
      continue;
    }

    const benefit = applyBenefit(promotion, qualification, basket);

    /**
     * Qualifying for nothing is not qualifying.
     *
     * A promotion whose reward unit is absent from the basket, or whose tier
     * the basket does not reach, computes a zero discount. Letting it "win"
     * would suppress a second promotion that was worth real money — so it is
     * reported, with its reason, and excluded from the contest.
     */
    if (benefit.discount_minor <= 0 && !(benefit.perks || []).length) {
      considered.push({
        promotion_id: promotion.id,
        name: promotion.name,
        applied: false,
        reason: benefit.detail?.note || benefit.detail?.reason || 'no_benefit',
        message: benefit.detail?.note === 'reward_unit_not_in_basket'
          ? 'Add the reward unit to this purchase to claim this offer.'
          : 'This offer produces no benefit on this purchase.',
      });
      continue;
    }

    qualified.push({ promotion, qualification, benefit });
  }

  if (!qualified.length) {
    return {
      original_minor: originalMinor,
      discount_minor: 0,
      payable_minor: originalMinor,
      applied: [],
      considered,
      resolution: strategy,
    };
  }

  // ── choose ────────────────────────────────────────────────────────────────
  let chosen = [];

  if (strategy === RESOLUTION.STACK) {
    /**
     * Stacking is opt-in PER PROMOTION, not merely per company.
     *
     * A company that allows stacking in general may still have one campaign it
     * never wants combined. So the company strategy says "stacking is possible
     * here" and each promotion says whether it consents — and the first
     * non-stackable promotion to be applied ends the stack, because combining
     * it with anything is exactly what it forbade.
     */
    const ordered = [...qualified].sort((a, b) => byPriority(a.promotion, b.promotion));
    for (const candidate of ordered) {
      if (!chosen.length) { chosen.push(candidate); continue; }
      const alreadyExclusive = chosen.some((c) => c.promotion.stackable === false);
      if (alreadyExclusive || candidate.promotion.stackable === false) {
        considered.push({
          promotion_id: candidate.promotion.id,
          name: candidate.promotion.name,
          applied: false,
          reason: 'not_stackable',
          message: 'This offer cannot be combined with another.',
        });
        continue;
      }
      chosen.push(candidate);
    }
  } else if (strategy === RESOLUTION.HIGHEST_PRIORITY) {
    chosen = [[...qualified].sort((a, b) => byPriority(a.promotion, b.promotion))[0]];
  } else if (strategy === RESOLUTION.FIRST_MATCHING) {
    chosen = [qualified[0]];
  } else {
    /**
     * HIGHEST_BENEFIT, the default, and ties break on priority.
     *
     * Two campaigns worth exactly the same is not a rare accident — "10% off"
     * and "₦2m off" coincide at a price of ₦20m, which is a common round
     * number. Falling back to the administrator's own ordering makes the
     * outcome deterministic rather than dependent on the order rows came back.
     */
    chosen = [[...qualified].sort((a, b) => {
      const difference = benefitOf(b) - benefitOf(a);
      return difference !== 0 ? difference : byPriority(a.promotion, b.promotion);
    })[0]];
  }

  const chosenIds = new Set(chosen.map((c) => c.promotion.id));
  for (const candidate of qualified) {
    if (chosenIds.has(candidate.promotion.id)) continue;
    if (considered.some((c) => c.promotion_id === candidate.promotion.id)) continue;
    considered.push({
      promotion_id: candidate.promotion.id,
      name: candidate.promotion.name,
      applied: false,
      reason: 'better_offer_applied',
      message: 'Another offer on this purchase was worth more.',
      would_have_saved_minor: benefitOf(candidate),
    });
  }

  /**
   * The total is CAPPED at the basket. Two stacked promotions of 60% each
   * would otherwise produce a negative price — the company paying the buyer to
   * take the property, which no administrator intended by ticking "stackable".
   */
  const rawDiscount = chosen.reduce((sum, c) => sum + benefitOf(c), 0);
  const discount = Math.min(rawDiscount, originalMinor);
  const overCapped = rawDiscount > originalMinor;

  return {
    original_minor: originalMinor,
    discount_minor: discount,
    payable_minor: originalMinor - discount,
    over_capped: overCapped,
    applied: chosen.map(({ promotion, benefit, qualification }) => ({
      promotion_id: promotion.id,
      version_id: promotion.version_id ?? null,
      name: promotion.name,
      code: promotion.code || null,
      benefit_type: benefit.benefit_type,
      discount_minor: benefit.discount_minor,
      claimed_minor: benefit.claimed_minor ?? benefit.discount_minor,
      capped: Boolean(benefit.capped),
      perks: benefit.perks || [],
      allocations: benefit.allocations,
      qualifying_quantity: qualification.quantity,
      qualifying_value_minor: qualification.value_minor,
      detail: benefit.detail,
      message: promotion.customer_message || null,
      terms: promotion.terms || null,
    })),
    considered,
    resolution: strategy,
  };
};

/**
 * The same evaluation, reduced to what a single unit costs right now.
 *
 * Used by listings and the unit picker, where there is no basket yet and the
 * question is "what would one of these cost me". Quantity-based and
 * combination-based campaigns will not qualify on a basket of one, which is
 * correct — showing a "10% off when you buy 4" price against a single unit
 * would be a promise the checkout then breaks.
 */
const priceForUnit = (promotions, unit, context = {}) => {
  const quantity = Number(context.quantity) || 1;
  const basket = {
    lines: [{
      unit_id: Number(unit.id),
      property_id: Number(unit.property_id),
      quantity,
      unit_price_minor: asMinor(unit.unit_price_minor ?? Math.round(Number(unit.price || 0) * 100)),
    }],
  };
  const result = evaluateBasket(promotions, basket, context);
  return {
    ...result,
    unit_id: Number(unit.id),
    quantity,
    original_unit_minor: basket.lines[0].unit_price_minor,
    // Per unit, for a listing that shows one price rather than a basket total.
    promotional_unit_minor: quantity > 0
      ? Math.round(result.payable_minor / quantity)
      : result.payable_minor,
  };
};

module.exports = { evaluateBasket, priceForUnit };

/**
 * The promotion engine, against the FRD's own worked examples.
 *
 * ── Why the scenarios are the FRD's and not mine ────────────────────────────
 *
 * The document lists ten scenarios (A–J) and several worked calculations with
 * the arithmetic spelled out. Those are the acceptance criteria in everything
 * but name, so they are reproduced here literally — a test that invents its own
 * examples can pass while the thing the customer asked for does not work.
 *
 * ── The rule every case is really checking ──────────────────────────────────
 *
 * A promotion NEVER changes a unit's price. Every assertion below reads the
 * original price back after evaluating, because the failure mode that matters
 * is not a wrong discount — it is a campaign that silently rewrites what a
 * property is worth, which survives the campaign and cannot be undone.
 *
 * Pure arithmetic, no database: every case is a literal input and a literal
 * expected answer.
 */
const { evaluateBasket, priceForUnit } = require('../shared/src/promotions/evaluate');
const { validatePromotion } = require('../shared/src/promotions/validate');
const {
  BENEFIT, RESOLUTION, STATUS, TIER_ON, AUDIENCE, PAYMENT_CONDITION, TRIGGER, BASIS,
} = require('../shared/src/promotions/types');

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

const naira = (amount) => Math.round(amount * 100);
const show = (minor) => `₦${(Number(minor) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

// ── the catalogue used throughout, mirroring the FRD's Lekki Gardens ────────
const LEKKI = 1;
const FULL_PLOT = 10;
const HALF_PLOT = 11;
const FLAT_2BED = 12;
const FLAT_3BED = 13;

const PRICES = {
  [FULL_PLOT]: naira(20_000_000),
  [HALF_PLOT]: naira(12_000_000),
  [FLAT_2BED]: naira(10_000_000),
  [FLAT_3BED]: naira(15_000_000),
};

const line = (unitId, quantity, propertyId = LEKKI) => ({
  unit_id: unitId, property_id: propertyId, quantity,
  unit_price_minor: PRICES[unitId],
});

const basket = (...lines) => ({ lines });

/** A promotion with the boring fields already filled in. */
const promo = (overrides = {}) => ({
  id: overrides.id ?? 1,
  name: overrides.name ?? 'Test promotion',
  status: STATUS.ACTIVE,
  trigger: TRIGGER.AUTOMATIC,
  starts_at: '2026-10-01T00:00:00Z',
  ends_at: '2026-10-31T00:00:00Z',
  scope: { unit_ids: [FULL_PLOT] },
  ...overrides,
});

const OCTOBER = new Date('2026-10-15T12:00:00Z');
const at = (extra = {}) => ({ now: OCTOBER, buyer: {}, payment_type: 'outright', ...extra });

console.log('\n── Scenario A  20% off all Full Plots (FRD 8.1) ────────────────');
{
  const p = promo({ benefit_type: BENEFIT.PERCENTAGE, percentage: 20 });
  const cart = basket(line(FULL_PLOT, 1));
  const result = evaluateBasket([p], cart, at());

  check('Original stays ₦20,000,000', result.original_minor === naira(20_000_000), show(result.original_minor));
  check('Discount is ₦4,000,000', result.discount_minor === naira(4_000_000), show(result.discount_minor));
  check('Payable is ₦16,000,000', result.payable_minor === naira(16_000_000), show(result.payable_minor));

  /**
   * The rule the whole module rests on. Read the basket back AFTER evaluating:
   * the unit's own price must be untouched, so the campaign can expire without
   * anybody restoring anything.
   */
  check('The unit\'s configured price is not rewritten',
    cart.lines[0].unit_price_minor === naira(20_000_000),
    `still ${show(cart.lines[0].unit_price_minor)} — the promotional price is derived, never stored`);
}

console.log('\n── Scenario B  Buy 4 Flats, 10% off (FRD 8.3) ──────────────────');
{
  const p = promo({
    benefit_type: BENEFIT.PERCENTAGE, percentage: 10,
    scope: { unit_ids: [FLAT_2BED] }, min_quantity: 4,
  });

  const three = evaluateBasket([p], basket(line(FLAT_2BED, 3)), at());
  check('Three flats do not reach the minimum', three.discount_minor === 0,
    three.considered[0]?.message);

  const four = evaluateBasket([p], basket(line(FLAT_2BED, 4)), at());
  check('Four flats: original ₦40,000,000', four.original_minor === naira(40_000_000), show(four.original_minor));
  check('...discount ₦4,000,000', four.discount_minor === naira(4_000_000), show(four.discount_minor));
  check('...payable ₦36,000,000', four.payable_minor === naira(36_000_000), show(four.payable_minor));
}

console.log('\n── Scenario C  Buy 2 Full Plots, get 1 Half Plot free ──────────');
{
  const p = promo({
    benefit_type: BENEFIT.BUY_X_GET_Y,
    scope: { unit_ids: [FULL_PLOT, HALF_PLOT] },
    buy_x_get_y: {
      buy_unit_id: FULL_PLOT, buy_quantity: 2,
      reward_unit_id: HALF_PLOT, reward_quantity: 1,
      reward_discount_percentage: 100,
    },
  });

  const cart = basket(line(FULL_PLOT, 2), line(HALF_PLOT, 1));
  const result = evaluateBasket([p], cart, at());
  check('The half plot is free', result.discount_minor === naira(12_000_000), show(result.discount_minor));
  check('Payable is the two full plots only',
    result.payable_minor === naira(40_000_000), show(result.payable_minor));

  /**
   * The reward has to be in the basket. Qualifying for a free half plot the
   * buyer never asked for must not put one on their invoice.
   */
  const noReward = evaluateBasket([p], basket(line(FULL_PLOT, 2)), at());
  check('Without the half plot in the basket, nothing is discounted',
    noReward.discount_minor === 0, noReward.considered[0]?.message);
  check('...and the buyer is told to add it',
    /add the reward unit/i.test(noReward.considered[0]?.message || ''), noReward.considered[0]?.message);
}

console.log('\n── Scenario D  Buy 2 Full Plots, get a Half Plot at 50% off ────');
{
  const p = promo({
    benefit_type: BENEFIT.BUY_X_GET_Y,
    scope: { unit_ids: [FULL_PLOT, HALF_PLOT] },
    buy_x_get_y: {
      buy_unit_id: FULL_PLOT, buy_quantity: 2,
      reward_unit_id: HALF_PLOT, reward_quantity: 1,
      reward_discount_percentage: 50,
    },
  });
  const result = evaluateBasket([p], basket(line(FULL_PLOT, 2), line(HALF_PLOT, 1)), at());
  check('Half of the half plot comes off', result.discount_minor === naira(6_000_000), show(result.discount_minor));
  check('Payable is ₦46,000,000', result.payable_minor === naira(46_000_000), show(result.payable_minor));
}

console.log('\n── Buy 2 get the 3rd at 20% off (FRD 10) ───────────────────────');
{
  const p = promo({
    benefit_type: BENEFIT.BUY_X_GET_Y,
    buy_x_get_y: {
      buy_unit_id: FULL_PLOT, buy_quantity: 2,
      reward_unit_id: FULL_PLOT, reward_quantity: 1,
      reward_discount_percentage: 20,
      repeatable: false,
    },
  });

  /**
   * The reward is the same unit that qualifies, so the two that earned it
   * cannot themselves be discounted. A basket of exactly two gets nothing.
   */
  const two = evaluateBasket([p], basket(line(FULL_PLOT, 2)), at());
  check('Buying exactly two earns nothing — those two are the qualifier',
    two.discount_minor === 0, two.considered[0]?.message);

  const three = evaluateBasket([p], basket(line(FULL_PLOT, 3)), at());
  check('The third plot gets 20% off', three.discount_minor === naira(4_000_000), show(three.discount_minor));

  // Not repeatable: six units still earn one reward.
  const six = evaluateBasket([p], basket(line(FULL_PLOT, 6)), at());
  check('Six units still earn ONE reward when not repeatable',
    six.discount_minor === naira(4_000_000), show(six.discount_minor));

  const repeatable = promo({
    benefit_type: BENEFIT.BUY_X_GET_Y,
    buy_x_get_y: {
      buy_unit_id: FULL_PLOT, buy_quantity: 2,
      reward_unit_id: FULL_PLOT, reward_quantity: 1,
      reward_discount_percentage: 20,
      repeatable: true,
    },
  });
  /**
   * A "set" here is THREE units — two paid for and one discounted — because the
   * reward is the same unit that qualifies. Six units is two complete sets.
   *
   * Counting sets as floor(6/2) = 3 and then discovering only enough units for
   * one reward is the subtle way to get this wrong, and it is wrong in the
   * company's favour: the buyer is shortchanged on an offer advertised to them.
   */
  const sixRepeat = evaluateBasket([repeatable], basket(line(FULL_PLOT, 6)), at());
  check('Repeatable on six units is two complete sets, so two rewards',
    sixRepeat.discount_minor === naira(8_000_000),
    `${show(sixRepeat.discount_minor)} — 2 × 20% of ₦20m`);

  const nine = evaluateBasket([repeatable], basket(line(FULL_PLOT, 9)), at());
  check('Nine units is three complete sets, so three rewards',
    nine.discount_minor === naira(12_000_000),
    `${show(nine.discount_minor)} — 3 × 20% of ₦20m`);

  const five = evaluateBasket([repeatable], basket(line(FULL_PLOT, 5)), at());
  check('Five units is one complete set, not one and a half',
    five.discount_minor === naira(4_000_000),
    `${show(five.discount_minor)} — a part-set earns nothing`);

  const twoNonRepeat = evaluateBasket([p], basket(line(FULL_PLOT, 2)), at());
  check('Buying exactly two never earns the third, repeatable or not',
    twoNonRepeat.discount_minor === 0, '');
}

console.log('\n── Scenario E  Mixed units — 1 Full + 1 Half, ₦3m off ──────────');
{
  const p = promo({
    benefit_type: BENEFIT.FIXED_AMOUNT,
    amount_minor: naira(3_000_000),
    scope: { unit_ids: [FULL_PLOT, HALF_PLOT] },
    combination: [
      { unit_id: FULL_PLOT, quantity: 1, label: 'Full Plot' },
      { unit_id: HALF_PLOT, quantity: 1, label: 'Half Plot' },
    ],
  });

  const both = evaluateBasket([p], basket(line(FULL_PLOT, 1), line(HALF_PLOT, 1)), at());
  check('The combination qualifies', both.discount_minor === naira(3_000_000), show(both.discount_minor));
  check('Payable is ₦29,000,000', both.payable_minor === naira(29_000_000), show(both.payable_minor));

  const onlyFull = evaluateBasket([p], basket(line(FULL_PLOT, 2)), at());
  check('Two full plots do NOT satisfy "one of each"', onlyFull.discount_minor === 0, '');
  check('...and the refusal names what is missing',
    /Half Plot/.test(onlyFull.considered[0]?.message || ''), onlyFull.considered[0]?.message);

  /**
   * The discount is spread across the lines in proportion to their value, so
   * the invoice can show what each unit actually cost. ₦3m over ₦20m and ₦12m
   * is ₦1,875,000 and ₦1,125,000.
   */
  const spread = both.applied[0].allocations;
  check('...and the discount is allocated across both lines, not left as a lump',
    spread.length === 2
      && spread.reduce((sum, a) => sum + a.discount_minor, 0) === naira(3_000_000),
    spread.map((a) => `#${a.unit_id} ${show(a.discount_minor)}`).join(' + '));
}

console.log('\n── Scenario F  Tiered by quantity (FRD 14) ─────────────────────');
{
  const p = promo({
    benefit_type: BENEFIT.TIERED,
    tier_on: TIER_ON.QUANTITY,
    scope: { unit_ids: [FLAT_2BED] },
    tiers: [
      { from: 1, percentage: 0 },
      { from: 3, percentage: 5 },
      { from: 5, percentage: 10 },
      { from: 10, percentage: 15 },
    ],
  });

  const forQty = (quantity) => evaluateBasket([p], basket(line(FLAT_2BED, quantity)), at());

  check('2 units → nothing', forQty(2).discount_minor === 0, show(forQty(2).discount_minor));
  check('3 units → 5% of ₦30m = ₦1.5m', forQty(3).discount_minor === naira(1_500_000), show(forQty(3).discount_minor));
  check('5 units → 10% of ₦50m = ₦5m', forQty(5).discount_minor === naira(5_000_000), show(forQty(5).discount_minor));
  check('12 units → 15% of ₦120m = ₦18m', forQty(12).discount_minor === naira(18_000_000), show(forQty(12).discount_minor));

  /**
   * Tiers listed out of order must still resolve to the highest one reached.
   * An admin's ordering mistake should not silently change what customers pay.
   */
  const shuffled = promo({
    benefit_type: BENEFIT.TIERED, tier_on: TIER_ON.QUANTITY, scope: { unit_ids: [FLAT_2BED] },
    tiers: [{ from: 10, percentage: 15 }, { from: 1, percentage: 0 }, { from: 5, percentage: 10 }, { from: 3, percentage: 5 }],
  });
  const outOfOrder = evaluateBasket([shuffled], basket(line(FLAT_2BED, 5)), at());
  check('Tiers configured out of order still resolve correctly',
    outOfOrder.discount_minor === naira(5_000_000), show(outOfOrder.discount_minor));
}

console.log('\n── Tiered by value (FRD 14) ────────────────────────────────────');
{
  const p = promo({
    benefit_type: BENEFIT.TIERED, tier_on: TIER_ON.VALUE, scope: {},
    tiers: [
      { from: naira(20_000_000), percentage: 5 },
      { from: naira(50_000_000), percentage: 10 },
      { from: naira(100_000_000), percentage: 15 },
    ],
  });
  const result = evaluateBasket([p], basket(line(FULL_PLOT, 3)), at()); // ₦60m
  check('₦60m reaches the ₦50m tier at 10%', result.discount_minor === naira(6_000_000), show(result.discount_minor));
}

console.log('\n── Scenario G  Payment-plan conditions (FRD 19) ────────────────');
{
  const p = promo({
    benefit_type: BENEFIT.PERCENTAGE, percentage: 15,
    payment_condition: PAYMENT_CONDITION.OUTRIGHT_ONLY,
  });

  const outright = evaluateBasket([p], basket(line(FULL_PLOT, 1)), at({ payment_type: 'outright' }));
  check('Outright gets 15%', outright.discount_minor === naira(3_000_000), show(outright.discount_minor));

  const instalment = evaluateBasket([p], basket(line(FULL_PLOT, 1)), at({ payment_type: 'installment' }));
  check('An instalment purchase does not', instalment.discount_minor === 0, instalment.considered[0]?.message);

  const upfront = promo({
    id: 2, benefit_type: BENEFIT.FIXED_AMOUNT, amount_minor: naira(1_000_000),
    min_upfront_percentage: 50,
  });
  const tooLittle = evaluateBasket([upfront], basket(line(FULL_PLOT, 1)),
    at({ payment_type: 'installment', upfront_percentage: 20 }));
  check('A 50%-upfront offer refuses a 20% deposit', tooLittle.discount_minor === 0, tooLittle.considered[0]?.message);
  const enough = evaluateBasket([upfront], basket(line(FULL_PLOT, 1)),
    at({ payment_type: 'installment', upfront_percentage: 60 }));
  check('...and accepts 60%', enough.discount_minor === naira(1_000_000), show(enough.discount_minor));
}

console.log('\n── Scenario H  Minimum purchase value (FRD 16) ─────────────────');
{
  const p = promo({
    benefit_type: BENEFIT.FIXED_AMOUNT, amount_minor: naira(5_000_000),
    scope: {}, min_purchase_minor: naira(50_000_000),
  });
  const below = evaluateBasket([p], basket(line(FULL_PLOT, 2)), at()); // ₦40m
  check('₦40m is below the ₦50m threshold', below.discount_minor === 0, below.considered[0]?.message);
  const above = evaluateBasket([p], basket(line(FULL_PLOT, 3)), at()); // ₦60m
  check('₦60m qualifies for ₦5m off', above.discount_minor === naira(5_000_000), show(above.discount_minor));
}

console.log('\n── Scenario I  New customers only (FRD 17) ─────────────────────');
{
  const p = promo({
    benefit_type: BENEFIT.PERCENTAGE, percentage: 10,
    eligibility: { audience: AUDIENCE.NEW_CUSTOMERS },
  });
  const newBuyer = evaluateBasket([p], basket(line(FULL_PLOT, 1)), at({ buyer: { id: 5, completed_purchases: 0 } }));
  check('A first-time buyer qualifies', newBuyer.discount_minor === naira(2_000_000), show(newBuyer.discount_minor));
  const returning = evaluateBasket([p], basket(line(FULL_PLOT, 1)), at({ buyer: { id: 5, completed_purchases: 2 } }));
  check('A returning buyer does not', returning.discount_minor === 0, returning.considered[0]?.message);
}

console.log('\n── Scenario J  Promotion code (FRD 30) ─────────────────────────');
{
  const p = promo({
    benefit_type: BENEFIT.PERCENTAGE, percentage: 20,
    trigger: TRIGGER.CODE, code: 'EASTER20',
  });

  const without = evaluateBasket([p], basket(line(FULL_PLOT, 1)), at());
  check('Without the code, nothing applies', without.discount_minor === 0, without.considered[0]?.reason);
  check('...and the reason is that a code is needed',
    without.considered[0]?.reason === 'code_required', without.considered[0]?.message);

  const withCode = evaluateBasket([p], basket(line(FULL_PLOT, 1)), at({ codes: ['easter20'] }));
  check('With the code (any case), 20% applies', withCode.discount_minor === naira(4_000_000), show(withCode.discount_minor));
}

console.log('\n── Maximum discount (FRD 15) ───────────────────────────────────');
{
  const p = promo({
    benefit_type: BENEFIT.PERCENTAGE, percentage: 20, scope: {},
    max_discount_minor: naira(10_000_000),
  });
  const result = evaluateBasket([p], basket(line(FULL_PLOT, 5)), at()); // 20% of ₦100m = ₦20m
  check('A ₦20m discount is capped at ₦10m', result.discount_minor === naira(10_000_000), show(result.discount_minor));
  check('...and the breakdown says what was claimed',
    result.applied[0].claimed_minor === naira(20_000_000) && result.applied[0].capped === true,
    `claimed ${show(result.applied[0].claimed_minor)}, given ${show(result.applied[0].discount_minor)}`);
  check('...and the capped discount still allocates to exactly ₦10m',
    result.applied[0].allocations.reduce((s, a) => s + a.discount_minor, 0) === naira(10_000_000), '');
}

console.log('\n── Dates (FRD 26) ──────────────────────────────────────────────');
{
  const p = promo({ benefit_type: BENEFIT.PERCENTAGE, percentage: 20 });
  const before = evaluateBasket([p], basket(line(FULL_PLOT, 1)), at({ now: new Date('2026-09-30T23:00:00Z') }));
  check('The day before it starts, nothing applies', before.discount_minor === 0, before.considered[0]?.message);

  /**
   * "Valid to 31 October" includes the 31st. A bare end date compared as
   * midnight would close the campaign a day early — an error only its turned-
   * away customers would notice.
   */
  const lastDay = evaluateBasket([p], basket(line(FULL_PLOT, 1)), at({ now: new Date('2026-10-31T22:00:00Z') }));
  check('The whole of the last day still counts', lastDay.discount_minor === naira(4_000_000), show(lastDay.discount_minor));

  const after = evaluateBasket([p], basket(line(FULL_PLOT, 1)), at({ now: new Date('2026-11-01T00:30:00Z') }));
  check('The day after, it has ended', after.discount_minor === 0, after.considered[0]?.message);

  for (const status of [STATUS.DRAFT, STATUS.PAUSED, STATUS.EXPIRED, STATUS.DEACTIVATED, STATUS.ARCHIVED]) {
    const stopped = evaluateBasket([promo({ status, benefit_type: BENEFIT.PERCENTAGE, percentage: 20 })],
      basket(line(FULL_PLOT, 1)), at());
    check(`A ${status.toLowerCase()} promotion does not apply`, stopped.discount_minor === 0,
      stopped.considered[0]?.message);
  }
}

console.log('\n── Usage limits (FRD 28) ───────────────────────────────────────');
{
  const p = promo({
    id: 7, benefit_type: BENEFIT.PERCENTAGE, percentage: 20,
    limits: { total_redemptions: 100, per_customer: 1, per_day: 10, total_units: 50 },
  });
  const usageOf = (usage) => evaluateBasket([p], basket(line(FULL_PLOT, 1)), at({ usage: { 7: usage } }));

  check('Within every limit, it applies', usageOf({ total_redemptions: 5 }).discount_minor > 0, '');
  check('Fully redeemed stops it', usageOf({ total_redemptions: 100 }).discount_minor === 0,
    usageOf({ total_redemptions: 100 }).considered[0]?.message);
  check('A customer who has used it already cannot again',
    usageOf({ customer_redemptions: 1 }).discount_minor === 0,
    usageOf({ customer_redemptions: 1 }).considered[0]?.message);
  check("Today's allocation running out stops it",
    usageOf({ today_redemptions: 10 }).discount_minor === 0,
    usageOf({ today_redemptions: 10 }).considered[0]?.message);
  check('The unit allocation running out stops it',
    usageOf({ units_redeemed: 50 }).discount_minor === 0,
    usageOf({ units_redeemed: 50 }).considered[0]?.message);
}

console.log('\n── Competing promotions (FRD 21, 22) ───────────────────────────');
{
  const tenPercent = promo({ id: 1, name: '10% off', benefit_type: BENEFIT.PERCENTAGE, percentage: 10, priority: 1 });
  const fixedThree = promo({ id: 2, name: '₦3m off', benefit_type: BENEFIT.FIXED_AMOUNT, amount_minor: naira(3_000_000), priority: 2 });
  const cart = basket(line(FULL_PLOT, 1)); // ₦20m: 10% = ₦2m, fixed = ₦3m

  const best = evaluateBasket([tenPercent, fixedThree], cart, at({ resolution: RESOLUTION.HIGHEST_BENEFIT }));
  check('Highest benefit picks the ₦3m', best.discount_minor === naira(3_000_000), best.applied[0].name);
  check('...and says why the other did not apply',
    best.considered.some((c) => c.reason === 'better_offer_applied'),
    best.considered.find((c) => c.reason === 'better_offer_applied')?.message);
  check('...including what it would have been worth',
    best.considered.find((c) => c.reason === 'better_offer_applied')?.would_have_saved_minor === naira(2_000_000), '');

  const byPriority = evaluateBasket([tenPercent, fixedThree], cart, at({ resolution: RESOLUTION.HIGHEST_PRIORITY }));
  check('Highest priority picks priority 1 even though it is worth less',
    byPriority.applied[0].promotion_id === 1 && byPriority.discount_minor === naira(2_000_000),
    `${byPriority.applied[0].name} — ${show(byPriority.discount_minor)}`);

  const first = evaluateBasket([tenPercent, fixedThree], cart, at({ resolution: RESOLUTION.FIRST_MATCHING }));
  check('First matching takes the first in order', first.applied[0].promotion_id === 1, first.applied[0].name);

  const stackable = [
    { ...tenPercent, stackable: true },
    { ...fixedThree, stackable: true },
  ];
  const stacked = evaluateBasket(stackable, cart, at({ resolution: RESOLUTION.STACK }));
  check('Stacking applies both', stacked.applied.length === 2 && stacked.discount_minor === naira(5_000_000),
    `${stacked.applied.length} offers, ${show(stacked.discount_minor)}`);

  const oneExclusive = [
    { ...tenPercent, stackable: true },
    { ...fixedThree, stackable: false },
  ];
  const blocked = evaluateBasket(oneExclusive, cart, at({ resolution: RESOLUTION.STACK }));
  check('A promotion marked not-stackable refuses to be combined',
    blocked.applied.length === 1,
    blocked.considered.find((c) => c.reason === 'not_stackable')?.message || '');

  /**
   * Stacking must never produce a negative price. Two 60% campaigns is not a
   * contrived case — it is what a company gets by ticking "stackable" on a
   * seasonal sale and a clearance at the same time.
   */
  const greedy = [
    { ...promo({ id: 3, benefit_type: BENEFIT.PERCENTAGE, percentage: 60 }), stackable: true },
    { ...promo({ id: 4, benefit_type: BENEFIT.PERCENTAGE, percentage: 60 }), stackable: true },
  ];
  const capped = evaluateBasket(greedy, cart, at({ resolution: RESOLUTION.STACK }));
  check('Stacked discounts never exceed the basket',
    capped.payable_minor === 0 && capped.over_capped === true,
    `payable ${show(capped.payable_minor)} — never a negative price`);
}

console.log('\n── A single unit\'s advertised price (FRD 23) ───────────────────');
{
  const p = promo({ benefit_type: BENEFIT.PERCENTAGE, percentage: 20 });
  const quoted = priceForUnit([p], { id: FULL_PLOT, property_id: LEKKI, unit_price_minor: PRICES[FULL_PLOT] }, at());
  check('A listing shows ₦20,000,000 struck through', quoted.original_unit_minor === naira(20_000_000), show(quoted.original_unit_minor));
  check('...and ₦16,000,000 as the promotional price', quoted.promotional_unit_minor === naira(16_000_000), show(quoted.promotional_unit_minor));
  check('...and names the offer', quoted.applied[0]?.name === 'Test promotion', quoted.applied[0]?.name);

  /**
   * A quantity promotion must NOT advertise its price against a single unit.
   * "10% off when you buy 4" shown on one unit is a promise the checkout then
   * breaks, which is worse than not advertising it at all.
   */
  const bulk = promo({ benefit_type: BENEFIT.PERCENTAGE, percentage: 10, min_quantity: 4 });
  const single = priceForUnit([bulk], { id: FULL_PLOT, property_id: LEKKI, unit_price_minor: PRICES[FULL_PLOT] }, at());
  check('A bulk offer is not advertised against a single unit',
    single.promotional_unit_minor === naira(20_000_000), show(single.promotional_unit_minor));
}

console.log('\n── Scope (FRD 7) ───────────────────────────────────────────────');
{
  const wholeProperty = promo({ benefit_type: BENEFIT.PERCENTAGE, percentage: 20, scope: { property_ids: [LEKKI] } });
  const mixed = basket(line(FULL_PLOT, 1), line(HALF_PLOT, 1), line(FLAT_2BED, 1, 99));
  const result = evaluateBasket([wholeProperty], mixed, at());
  /** ₦32m of Lekki stock at 20% = ₦6.4m. The other property's flat is untouched. */
  check('A property-wide promotion covers its own units only',
    result.discount_minor === naira(6_400_000), show(result.discount_minor));
  check('...and a unit from another property is left alone',
    !result.applied[0].allocations.some((a) => a.unit_id === FLAT_2BED), '');

  const twoUnits = promo({ benefit_type: BENEFIT.PERCENTAGE, percentage: 20, scope: { unit_ids: [FULL_PLOT, HALF_PLOT] } });
  const onlyThose = evaluateBasket([twoUnits], mixed, at());
  check('A two-unit scope covers exactly those two',
    onlyThose.discount_minor === naira(6_400_000), show(onlyThose.discount_minor));
}

console.log('\n── Configuration mistakes are caught before customers see them ──');
{
  const missingPercentage = validatePromotion({ name: 'Broken', benefit_type: BENEFIT.PERCENTAGE });
  check('A percentage promotion with no percentage is refused',
    !missingPercentage.ok && missingPercentage.errors.some((e) => e.code === 'percentage_missing'),
    missingPercentage.errors[0]?.message);

  const overHundred = validatePromotion({ name: 'x', benefit_type: BENEFIT.PERCENTAGE, percentage: 120 });
  check('More than 100% off is refused', !overHundred.ok, overHundred.errors[0]?.message);

  const steep = validatePromotion({ name: 'x', benefit_type: BENEFIT.PERCENTAGE, percentage: 90, ends_at: '2026-12-31' });
  check('90% off is allowed but warned about',
    steep.ok && steep.warnings.some((w) => w.code === 'percentage_high'), steep.warnings[0]?.message);

  const reversed = validatePromotion({
    name: 'x', benefit_type: BENEFIT.PERCENTAGE, percentage: 10,
    starts_at: '2026-10-31', ends_at: '2026-10-01',
  });
  check('A promotion that ends before it starts is refused',
    !reversed.ok && reversed.errors.some((e) => e.code === 'dates_reversed'), reversed.errors[0]?.message);

  const duplicateTiers = validatePromotion({
    name: 'x', benefit_type: BENEFIT.TIERED, ends_at: '2026-12-31',
    tiers: [{ from: 3, percentage: 5 }, { from: 3, percentage: 10 }],
  });
  check('Two tiers at the same threshold are refused',
    !duplicateTiers.ok && duplicateTiers.errors.some((e) => e.code === 'tier_duplicate'),
    duplicateTiers.errors.find((e) => e.code === 'tier_duplicate')?.message);

  /**
   * The subtle one. A combination requiring a unit the scope excludes can never
   * fire — the scope filters the basket before the combination is counted — so
   * the campaign would run for a month and discount nobody.
   */
  const unreachable = validatePromotion({
    name: 'x', benefit_type: BENEFIT.FIXED_AMOUNT, amount_minor: naira(1_000_000), ends_at: '2026-12-31',
    scope: { unit_ids: [FULL_PLOT] },
    combination: [{ unit_id: HALF_PLOT, quantity: 1, label: 'Half Plot' }],
  });
  check('A combination outside the promotion\'s own scope is refused',
    !unreachable.ok && unreachable.errors.some((e) => e.code === 'combination_outside_scope'),
    unreachable.errors.find((e) => e.code === 'combination_outside_scope')?.message);

  const codeless = validatePromotion({
    name: 'x', benefit_type: BENEFIT.PERCENTAGE, percentage: 10, ends_at: '2026-12-31', trigger: TRIGGER.CODE,
  });
  check('A code promotion with no code is refused',
    !codeless.ok && codeless.errors.some((e) => e.code === 'code_missing'), codeless.errors[0]?.message);

  const unknownAudience = evaluateBasket(
    [promo({ benefit_type: BENEFIT.PERCENTAGE, percentage: 20, eligibility: { audience: 'VIPS_ONLY' } })],
    basket(line(FULL_PLOT, 1)), at(),
  );
  /**
   * A restriction the engine cannot read must be HONOURED, not ignored.
   * Treating an unrecognised audience as "everyone" hands a targeted discount
   * to the whole world because somebody mistyped a setting.
   */
  check('An eligibility rule the engine cannot read blocks rather than opens',
    unknownAudience.discount_minor === 0, unknownAudience.considered[0]?.message);
}

console.log('\n── Non-monetary benefits (FRD 32) ──────────────────────────────');
{
  const p = promo({
    benefit_type: BENEFIT.NON_MONETARY,
    perks: [{ code: 'FREE_DOCS', label: 'Free documentation' }],
  });
  const result = evaluateBasket([p], basket(line(FULL_PLOT, 1)), at());
  check('A free-documentation offer applies with no money off',
    result.applied.length === 1 && result.discount_minor === 0, '');
  check('...and carries the perk through so somebody can fulfil it',
    result.applied[0].perks[0]?.label === 'Free documentation', result.applied[0].perks[0]?.label);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

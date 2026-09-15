/**
 * The vocabulary of the promotion engine.
 *
 * ── Why these are constants and not free strings ────────────────────────────
 *
 * A promotion is stored as configuration, and configuration written by an admin
 * screen is read back years later by a calculation nobody is watching. A typo
 * in a free-string type does not fail — it silently matches nothing, and the
 * campaign quietly gives no discount to anybody. Naming the closed sets here
 * means an unknown value can be REJECTED at save time, when somebody is there
 * to fix it.
 */

/** What the promotion does when it qualifies. */
const BENEFIT = {
  /** A percentage off the qualifying amount. */
  PERCENTAGE: 'PERCENTAGE',
  /** A flat amount off, in minor units. */
  FIXED_AMOUNT: 'FIXED_AMOUNT',
  /**
   * Buy N of one thing, get M of another free or discounted.
   *
   * The reward may be the same unit as the qualifier ("buy 2, get the 3rd at
   * 20% off") or a different one ("buy 2 full plots, get a half plot free").
   * One shape covers both, because the difference is which unit id the reward
   * names — not a different kind of promotion.
   */
  BUY_X_GET_Y: 'BUY_X_GET_Y',
  /**
   * Different benefit at different quantities or values.
   *
   * Kept distinct from PERCENTAGE rather than modelled as several promotions,
   * because the tiers are mutually exclusive by definition and expressing that
   * as separate competing promotions would leave the conflict resolver to
   * rediscover it.
   */
  TIERED: 'TIERED',
  /**
   * Something that is not money off the unit — waived documentation, a free
   * allocation fee, a longer plan.
   *
   * Carries no automatic arithmetic. It is recorded against the purchase and
   * surfaced to whoever fulfils it, because the alternative is a promise made
   * at checkout that nothing downstream knows about.
   */
  NON_MONETARY: 'NON_MONETARY',
};
const BENEFIT_TYPES = Object.values(BENEFIT);

/** What the promotion is measured against. */
const BASIS = {
  /** Every qualifying line in the basket. */
  QUALIFYING_LINES: 'QUALIFYING_LINES',
  /** The whole basket, including lines that did not themselves qualify. */
  WHOLE_BASKET: 'WHOLE_BASKET',
};

/** How tiers are selected. */
const TIER_ON = {
  QUANTITY: 'QUANTITY',
  VALUE: 'VALUE',
};

/** What happens when several promotions qualify at once. */
const RESOLUTION = {
  /** Whichever saves the buyer the most. The kindest default. */
  HIGHEST_BENEFIT: 'HIGHEST_BENEFIT',
  /** Whichever the administrator ranked first. */
  HIGHEST_PRIORITY: 'HIGHEST_PRIORITY',
  /** The first that qualifies, in configured order. */
  FIRST_MATCHING: 'FIRST_MATCHING',
  /** All of them, where each permits stacking. */
  STACK: 'STACK',
};
const RESOLUTIONS = Object.values(RESOLUTION);

/** Where a promotion is in its life. */
const STATUS = {
  DRAFT: 'DRAFT',
  SCHEDULED: 'SCHEDULED',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  EXPIRED: 'EXPIRED',
  DEACTIVATED: 'DEACTIVATED',
  ARCHIVED: 'ARCHIVED',
};
const STATUSES = Object.values(STATUS);

/**
 * The statuses in which a promotion may be applied to a NEW purchase.
 *
 * Only one. Everything else — draft, scheduled, paused, expired, deactivated,
 * archived — is a state in which the company has said "not now", and the dates
 * are checked separately on top of this.
 */
const APPLICABLE_STATUSES = new Set([STATUS.ACTIVE]);

/** Who a promotion is open to. */
const AUDIENCE = {
  EVERYONE: 'EVERYONE',
  NEW_CUSTOMERS: 'NEW_CUSTOMERS',
  EXISTING_CUSTOMERS: 'EXISTING_CUSTOMERS',
  /** A named list of customer ids. */
  SELECTED_CUSTOMERS: 'SELECTED_CUSTOMERS',
  /** Buyers whose account carries one of the named categories. */
  CUSTOMER_CATEGORY: 'CUSTOMER_CATEGORY',
  /** Buyers introduced by one of the named realtors. */
  SELECTED_REALTORS: 'SELECTED_REALTORS',
  /** Buyers whose introducing realtor sits at one of the named levels. */
  REALTOR_LEVELS: 'REALTOR_LEVELS',
  /** Their first purchase on the platform, whoever they are. */
  FIRST_PURCHASE: 'FIRST_PURCHASE',
};

/** Which payment arrangements a promotion is restricted to. */
const PAYMENT_CONDITION = {
  ANY: 'ANY',
  OUTRIGHT_ONLY: 'OUTRIGHT_ONLY',
  INSTALLMENT_ONLY: 'INSTALLMENT_ONLY',
};

/** How a promotion is reached. */
const TRIGGER = {
  /** Applied whenever the basket qualifies, with nothing to type. */
  AUTOMATIC: 'AUTOMATIC',
  /** Applied only when the buyer supplies the code. */
  CODE: 'CODE',
};

module.exports = {
  BENEFIT, BENEFIT_TYPES,
  BASIS, TIER_ON,
  RESOLUTION, RESOLUTIONS,
  STATUS, STATUSES, APPLICABLE_STATUSES,
  AUDIENCE, PAYMENT_CONDITION, TRIGGER,
};

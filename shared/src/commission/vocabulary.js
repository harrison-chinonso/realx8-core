/**
 * The vocabulary a commission plan is written in.
 *
 * Every one of these is a value stored in configuration, so the lists here are
 * the contract between the admin UI, the database and the engine. Adding a
 * member is a deliberate act: the engine must handle it, the validator must
 * know it, and — because plan versions are immutable (§5.6) — an existing
 * version must keep meaning exactly what it meant before.
 *
 * Deliberately plain strings rather than integers. A plan version is read back
 * years later to explain a payment, sometimes by a person reading raw rows, and
 * `PROTECT_DIRECT` survives that better than `3`.
 */

/**
 * What a percentage is a percentage OF (§5.4).
 *
 * This field exists because "1.5% generational commission" is ambiguous, and
 * the ambiguity is the single most expensive kind of bug in this domain: both
 * readings produce a plausible number and only one is right. Every percentage
 * rule must state its basis; the validator refuses a plan where one does not.
 */
const BASIS = {
  COMMISSIONABLE_BASE: 'OF_COMMISSIONABLE_BASE',
  POOL: 'OF_POOL',
  DIRECT_EARNER_COMMISSION: 'OF_DIRECT_EARNER_COMMISSION',
  DOWNLINE_COMMISSION: 'OF_DOWNLINE_COMMISSION',
};
const BASES = Object.values(BASIS);

/**
 * Bases that depend on another participant's entitlement rather than on a
 * figure known before any rule runs.
 *
 * They force the entitlement phase to evaluate in dependency order instead of
 * in one pass, and they are what makes circular references possible — hence the
 * check in validate.js.
 */
const DEPENDENT_BASES = [BASIS.DIRECT_EARNER_COMMISSION, BASIS.DOWNLINE_COMMISSION];

/** How the deal's commissionable base is derived — always from price (§5.11). */
const CB_MODE = {
  GROSS_PRICE: 'GROSS_PRICE',
  NET_OF_DISCOUNT: 'NET_OF_DISCOUNT',
  NET_OF_COMPONENTS: 'NET_OF_COMPONENTS',
  DECLARED_AMOUNT: 'DECLARED_AMOUNT',
};
const CB_MODES = Object.values(CB_MODE);

/**
 * How the deal's pool is derived (§5.3).
 *
 * Phase 1 implements all six. They are cheap to support once the constraint
 * phase exists, and leaving some out would mean a plan that validates but
 * cannot be calculated.
 */
const POOL_MODE = {
  UNCAPPED: 'UNCAPPED',
  PERCENTAGE: 'PERCENTAGE',
  FLAT: 'FLAT',
  FLAT_PER_UNIT: 'FLAT_PER_UNIT',
  TIERED: 'TIERED',
  HYBRID: 'HYBRID',
};
const POOL_MODES = Object.values(POOL_MODE);

/** What happens when claims exceed the pool (FR-CAP-002). */
const RESOLUTION = {
  PRORATE: 'PRORATE',
  PRIORITY_ORDER: 'PRIORITY_ORDER',
  PROTECT_DIRECT: 'PROTECT_DIRECT',
  REJECT: 'REJECT',
};
const RESOLUTIONS = Object.values(RESOLUTION);

/** What happens to a flat pool nobody claimed all of (FR-CAP-003). */
const SURPLUS = {
  BREAKAGE: 'BREAKAGE',
  REDISTRIBUTE_PRORATA: 'REDISTRIBUTE_PRORATA',
  REDISTRIBUTE_TO_DIRECT: 'REDISTRIBUTE_TO_DIRECT',
  REDISTRIBUTE_TO_HOUSE_ACCOUNT: 'REDISTRIBUTE_TO_HOUSE_ACCOUNT',
};
const SURPLUSES = Object.values(SURPLUS);

/** Skipping an upline who does not qualify (FR-GNC-006). */
const COMPRESSION = {
  NONE: 'NONE',
  ROLL_UP: 'ROLL_UP',
  DYNAMIC: 'DYNAMIC_COMPRESSION',
};
const COMPRESSIONS = Object.values(COMPRESSION);

/** A rule's value is either a rate or an amount, never inferred. */
const VALUE_TYPE = { PERCENTAGE: 'PERCENTAGE', FLAT_AMOUNT: 'FLAT_AMOUNT' };
const VALUE_TYPES = Object.values(VALUE_TYPE);

/**
 * The rule types Phase 1 ships.
 *
 * The catalogue in §7.7 is longer; the rest arrive in later phases. A plan
 * naming a type not in this list fails validation rather than being silently
 * skipped, because a rule that quietly does not run is a participant quietly
 * not paid.
 */
const RULE_TYPE = {
  DIRECT_SALE: 'DIRECT_SALE',
  REFERRAL_BONUS: 'REFERRAL_BONUS',
  GENERATIONAL_OVERRIDE: 'GENERATIONAL_OVERRIDE',
};
const RULE_TYPES = Object.values(RULE_TYPE);

/** What a participant is on this deal. One realtor may hold more than one. */
const ROLE = {
  DIRECT: 'DIRECT',
  CO_AGENT: 'CO_AGENT',
  REFERRER: 'REFERRER',
  UPLINE: 'UPLINE',
};
const ROLES = Object.values(ROLE);

/** Two rules paying the same participant on one deal (FR-RUL-005). */
const STACKING = { STACK: 'STACK', HIGHEST_ONLY: 'HIGHEST_ONLY' };
const STACKINGS = Object.values(STACKING);

/**
 * Where the kobo left over by proration goes (FR-CAP-008).
 *
 * `LARGEST_REMAINDER` is the default and is not one of the two options the FRD
 * names. See allocateByWeight in shared/src/money.js: it keeps every
 * participant within one kobo of their exact share instead of concentrating the
 * whole residual on one nominated party, and it reconciles to the pool by
 * construction rather than by a correction step. The FRD's two options are kept
 * for companies that want the residual to land somewhere predictable.
 */
const RESIDUAL = {
  LARGEST_REMAINDER: 'LARGEST_REMAINDER',
  TO_DIRECT: 'TO_DIRECT',
  TO_BREAKAGE: 'TO_BREAKAGE',
};
const RESIDUALS = Object.values(RESIDUAL);

/**
 * Why a participant earned nothing.
 *
 * Recorded instead of an entitlement, never alongside one — see §7.16. The
 * distinction between these reasons is what FR-ANL-004's breakage report is
 * broken down by, so they are values rather than free text.
 */
const EXCLUSION = {
  INELIGIBLE: 'INELIGIBLE',              // status gate, §7.16
  UNQUALIFIED: 'UNQUALIFIED',            // tier qualification, FR-GNC-005
  BEYOND_LEVEL_DEPTH: 'BEYOND_LEVEL_DEPTH', // level's max_generations_earnable
  NO_TIER: 'NO_TIER',                    // deeper than the configured tiers
  ABSENT: 'ABSENT',                      // no such ancestor exists
};

module.exports = {
  BASIS, BASES, DEPENDENT_BASES,
  CB_MODE, CB_MODES,
  POOL_MODE, POOL_MODES,
  RESOLUTION, RESOLUTIONS,
  SURPLUS, SURPLUSES,
  COMPRESSION, COMPRESSIONS,
  VALUE_TYPE, VALUE_TYPES,
  RULE_TYPE, RULE_TYPES,
  ROLE, ROLES,
  STACKING, STACKINGS,
  RESIDUAL, RESIDUALS,
  EXCLUSION,
};

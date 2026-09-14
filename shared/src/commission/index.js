const vocabulary = require('./vocabulary');
const { commissionableBase, bandFor } = require('./base');
const { derivePool } = require('./pool');
const { buildParticipants } = require('./participants');
const { gateParticipants, checkEligibility, statusAt } = require('./eligibility');
const { computeEntitlements } = require('./entitlements');
const { applyConstraints, applyPeriodicCaps, applyFloor } = require('./constraints');
const vesting = require('./vesting');
const reversal = require('./reversal');
const deductions = require('./deductions');

/**
 * The commission calculation pipeline (§8.1).
 *
 * Pure. Nothing in this directory reads a database, writes a ledger, or knows
 * what time it is beyond the instant it is handed. Every input — the deal, the
 * plan version, the genealogy, each realtor's status history — arrives as a
 * plain object, and the output is a description of what should happen rather
 * than a thing that has happened.
 *
 * That is not architectural tidiness for its own sake. It is what makes
 * FR-SIM-005 possible ("simulation shall never write to the ledger") without a
 * second implementation: the simulator and the live engine are the same
 * function, and the only difference is whether the caller persists the result.
 * A separate simulation path would drift from the engine it is meant to predict,
 * and the drift would show up as a plan that cost something other than what the
 * backtest said it would.
 *
 * It is also what makes the thing testable at all. Every worked example in §10
 * is a call to `calculate` with literal inputs.
 */

/**
 * @param {object} input
 *   deal              { id, gross_price_minor, discount_minor, unit_count,
 *                       attribution_date, selling_realtor, referrer?, co_agents[] }
 *   plan              the resolved PLAN VERSION — see §5.6; the caller selects
 *                     it by the deal's attribution date, never by "now"
 *   ancestors         the seller's upline chain, nearest first
 *   components        the property's price components, for NET_OF_COMPONENTS
 *   evaluated_at      the instant the status gate is judged against. Defaults
 *                     to the attribution date, which is what accrual means;
 *                     a release checkpoint passes its own timestamp.
 *
 * @returns {object} the full allocation, with a trace on every line.
 */
const calculate = (input) => {
  const { deal, plan, ancestors = [], components = [] } = input;
  const evaluatedAt = input.evaluated_at || deal.attribution_date;

  // ── 3. Commissionable base ───────────────────────────────────────────────
  const base = commissionableBase(deal, plan.commissionable_base || {}, components);

  // ── 4. Pool ──────────────────────────────────────────────────────────────
  const pool = derivePool(plan.pool || {}, base.amount_minor, deal.unit_count);

  // ── 5a–5g. Participants ──────────────────────────────────────────────────
  const built = buildParticipants(deal, ancestors, plan);

  // ── 5h. Active-status gate (§7.16) ───────────────────────────────────────
  const gated = gateParticipants(built.participants, evaluatedAt);

  // ── 6. Gross entitlements ────────────────────────────────────────────────
  const context = {
    commissionable_base_minor: base.amount_minor,
    pool_minor: pool.amount_minor,
    property_type: deal.property_type ?? null,
    level_property_rates: plan.level_property_rates || {},
    plan_default_rate: plan.default_rate ?? null,
  };
  const entitled = computeEntitlements(gated.eligible, plan, context);

  // ── 7. Constraints ───────────────────────────────────────────────────────
  const constrained = applyConstraints(entitled.entitlements, plan, pool.amount_minor);

  /**
   * Then the constraints that are about the PERSON rather than the deal.
   *
   * Order matters and is not arbitrary. The pool is a property of the deal, so
   * it applies first; a periodic cap is a property of the realtor's year, and
   * can only be judged once their share of this deal is known. The floor is
   * last because it asks whether the FINAL figure is worth paying — asking
   * before proration would keep shares that proration is about to shrink below
   * it anyway.
   */
  const capped = applyPeriodicCaps(constrained.entitlements, plan, input.earned_so_far);
  const floored = applyFloor(capped.entitlements, plan);

  const allocated = floored.entitlements.reduce(
    (total, entry) => total + entry.constrained_minor, 0,
  );

  /**
   * Everybody who earned nothing, and why, in one list.
   *
   * Three different causes land here — ineligible by status, unqualified for a
   * tier, deeper than the plan pays — and they are kept apart rather than
   * flattened to "no entitlement". FR-ANL-004 reports breakage BY CAUSE, and a
   * company cannot act on "money went unallocated"; it can act on "forty
   * percent of it was Gen 2 uplines who never met the qualification bar".
   */
  const excluded = [...built.excluded, ...gated.excluded, ...entitled.excluded];

  return {
    deal_id: deal.id ?? null,
    plan_version_id: plan.id ?? null,
    evaluated_at: new Date(evaluatedAt).toISOString(),

    commissionable_base_minor: base.amount_minor,
    pool_minor: constrained.pool_minor,
    claims_total_minor: constrained.claims_total_minor,
    allocated_minor: allocated,
    /**
     * Everything the deal did not pay out, whatever the reason.
     *
     * A periodic cap and a dropped floor both leave money unallocated exactly
     * as an absent upline does, and a breakage report that counted only one
     * cause would not reconcile against the pool.
     */
    breakage_minor: constrained.breakage_minor + capped.forfeited_minor + floored.released_minor,
    ...(capped.carried_forward.length ? { carried_forward: capped.carried_forward } : {}),
    ...(capped.flagged.length ? { over_periodic_cap: capped.flagged } : {}),
    ...(floored.dropped.length ? { below_floor: floored.dropped } : {}),
    ...(constrained.surplus_minor ? { surplus_minor: constrained.surplus_minor } : {}),
    ...(constrained.to_house_account_minor
      ? { to_house_account_minor: constrained.to_house_account_minor } : {}),

    entitlements: floored.entitlements,
    excluded,
    ...(constrained.rejected ? { rejected: constrained.rejected } : {}),

    trace: {
      commissionable_base: base.trace,
      pool: pool.trace,
      resolution: plan.resolution ?? null,
      surplus_policy: plan.surplus ?? null,
      compression: (plan.rules || [])
        .find((rule) => rule.type === vocabulary.RULE_TYPE.GENERATIONAL_OVERRIDE)?.compression ?? null,
    },
  };
};

/**
 * Whether one already-accrued entitlement may release at this checkpoint
 * (pipeline step 10).
 *
 * Deliberately a separate entry point rather than a flag on `calculate`. A
 * release is not a recalculation: the amounts were settled at accrual and must
 * not move, and the only question being asked is whether this participant is
 * still entitled to receive. Folding it into `calculate` would invite a future
 * change to re-derive the amount at release time, which is exactly the rate
 * drift FR-ELG-014 forbids.
 */
const checkRelease = (realtor, at) => checkEligibility(realtor, at, 'release');

module.exports = {
  calculate,
  checkRelease,
  // Phase 2: what becomes payable, what comes back, and what comes off.
  ...vesting,
  ...reversal,
  ...deductions,
  checkEligibility,
  statusAt,
  commissionableBase,
  derivePool,
  bandFor,
  buildParticipants,
  computeEntitlements,
  applyConstraints,
  ...vocabulary,
};

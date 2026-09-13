const { asMinor, percentageOf } = require('../money');
const {
  BASIS, BASES, DEPENDENT_BASES, CB_MODES, POOL_MODE, POOL_MODES,
  RESOLUTIONS, SURPLUSES, COMPRESSIONS, VALUE_TYPE, VALUE_TYPES,
  RULE_TYPE, RULE_TYPES, STACKINGS,
} = require('./vocabulary');

/**
 * The dry-run validator (FR-CFG-008), and the activation guardrail
 * (FR-CFG-007).
 *
 * ── Why a plan is validated rather than merely saved ────────────────────────
 *
 * Every mistake this catches has the same shape: the plan saves, the screen
 * looks right, and the error only appears as money. A rule with no declared
 * basis pays a percentage of something nobody chose. A generational tier deeper
 * than the company has levels is a tier that will never fire. Rules summing
 * above the pool means every deal is silently prorated, so nobody is ever paid
 * the rate they were promised and the discrepancy is written off as "the cap".
 *
 * None of those throw. They just quietly produce a different number than
 * intended, on every deal, until someone reconciles a year of payouts by hand.
 *
 * Findings are separated into `errors` (activation is blocked) and `warnings`
 * (activation proceeds, and the admin is told). The line between them is
 * whether the plan is INCOHERENT or merely SURPRISING: a rule with no basis
 * cannot be calculated at all, while rules summing above the pool is a
 * legitimate configuration a company may fully intend.
 */

const error = (code, message, detail = {}) => ({ severity: 'error', code, message, ...detail });
const warn = (code, message, detail = {}) => ({ severity: 'warning', code, message, ...detail });

/** Value-level checks on one rule or one generational tier. */
const checkValueDefinition = (label, definition, findings) => {
  if (!VALUE_TYPES.includes(definition.value_type)) {
    findings.push(error('VALUE_TYPE_INVALID',
      `${label} has no valid value type. Expected one of: ${VALUE_TYPES.join(', ')}.`,
      { at: label, value_type: definition.value_type ?? null }));
    return;
  }

  if (definition.value_type === VALUE_TYPE.PERCENTAGE) {
    /**
     * The check FR-CFG-008 names first, and the one worth having on its own.
     * "1.5%" is not a rule until it says 1.5% OF WHAT — see §5.4. Both readings
     * produce a plausible figure, which is what makes the omission expensive.
     */
    if (!definition.basis) {
      findings.push(error('BASIS_UNDEFINED',
        `${label} is a percentage but does not say what it is a percentage of. `
        + `Set a basis: ${BASES.join(', ')}.`, { at: label }));
    } else if (!BASES.includes(definition.basis)) {
      findings.push(error('BASIS_UNKNOWN',
        `${label} uses an unrecognised basis "${definition.basis}".`, { at: label }));
    }

    const rate = Number(definition.value);
    if (definition.value !== undefined && definition.value !== null) {
      if (!Number.isFinite(rate)) {
        findings.push(error('RATE_NOT_A_NUMBER', `${label} has a non-numeric rate.`, { at: label }));
      } else if (rate < 0) {
        findings.push(error('RATE_NEGATIVE', `${label} has a negative rate.`, { at: label, value: rate }));
      } else if (rate > 100) {
        findings.push(warn('RATE_ABOVE_100',
          `${label} pays ${rate}%, which is more than the whole of its basis.`,
          { at: label, value: rate }));
      }
    }
    return;
  }

  const amount = asMinor(definition.value);
  if (amount < 0) {
    findings.push(error('AMOUNT_NEGATIVE', `${label} has a negative flat amount.`, { at: label }));
  }
  if (amount === 0) {
    findings.push(warn('AMOUNT_ZERO', `${label} pays a flat zero, so it will never pay anyone.`, { at: label }));
  }
};

/**
 * A rule that cannot fire, for a structural reason (FR-CFG-008 "unreachable
 * rules").
 *
 * Disabled rules are not reported: disabling one is deliberate, and warning
 * about it every time the plan is validated trains people to ignore the
 * validator, which is worse than the warning is worth.
 */
const checkReachability = (plan, findings) => {
  const rules = (plan.rules || []).filter((rule) => rule.enabled !== false);

  if (!rules.length) {
    findings.push(error('NO_ENABLED_RULES', 'The plan has no enabled rules, so it would pay nobody.'));
    return;
  }

  if (!rules.some((rule) => rule.type === RULE_TYPE.DIRECT_SALE)) {
    findings.push(warn('NO_DIRECT_SALE_RULE',
      'No direct-sale rule: the realtor who makes the sale earns nothing from it.'));
  }

  const generational = rules.filter((rule) => rule.type === RULE_TYPE.GENERATIONAL_OVERRIDE);
  if (generational.length > 1) {
    findings.push(error('MULTIPLE_GENERATIONAL_RULES',
      `${generational.length} generational rules are enabled. The engine resolves one chain, `
      + 'so the others would never be reached.'));
  }

  generational.forEach((rule) => {
    const tiers = rule.tiers || [];
    if (!tiers.length && !rule.open_ended_tier) {
      findings.push(error('GENERATIONAL_RULE_HAS_NO_TIERS',
        'The generational rule defines no tiers and no open-ended tier.', { at: rule.id }));
    }

    const seen = new Map();
    tiers.forEach((tier) => {
      const generation = Number(tier.generation);
      if (!Number.isInteger(generation) || generation < 1) {
        findings.push(error('TIER_GENERATION_INVALID',
          `A tier has generation "${tier.generation}". Generations start at 1.`, { at: rule.id }));
        return;
      }
      if (seen.has(generation)) {
        findings.push(error('TIER_DUPLICATED',
          `Two tiers both claim generation ${generation}; only one would be applied.`,
          { at: rule.id, generation }));
      }
      seen.set(generation, tier);
    });

    // A gap means the tiers below it are unreachable under NONE/ROLL_UP, where
    // generations are numbered by raw distance.
    const generations = [...seen.keys()].sort((a, b) => a - b);
    generations.forEach((generation, index) => {
      if (index > 0 && generation !== generations[index - 1] + 1) {
        findings.push(warn('TIER_GAP',
          `Tiers jump from generation ${generations[index - 1]} to ${generation}. `
          + 'The generations in between earn nothing.', { at: rule.id }));
      }
    });

    /**
     * FR-CFG-008's second named check. A tier deeper than any level permits is
     * a tier that can never pay: every candidate ancestor is refused by
     * max_generations_earnable before the tier is consulted.
     */
    const deepestEarnable = Math.max(
      0,
      ...(plan.levels || [])
        .map((level) => Number(level.max_generations_earnable))
        .filter((depth) => Number.isFinite(depth)),
    );
    if (deepestEarnable > 0) {
      generations.filter((generation) => generation > deepestEarnable).forEach((generation) => {
        findings.push(error('TIER_BEYOND_LEVEL_DEPTH',
          `Generation ${generation} is configured, but no level may earn deeper than `
          + `generation ${deepestEarnable}. Nobody can ever be paid this tier.`,
          { at: rule.id, generation, deepest_earnable: deepestEarnable }));
      });
    }
  });
};

/**
 * Whether the rules can, between them, claim more than the pool allows
 * (FR-CFG-008 "rules summing above the pool").
 *
 * A warning rather than an error: a company may fully intend rules that
 * over-claim, with proration as the mechanism that reconciles them. What it
 * must not do is intend that ACCIDENTALLY, because the symptom — every
 * participant quietly paid less than their stated rate, on every deal — looks
 * identical to a plan working correctly.
 */
const checkPoolCoverage = (plan, findings) => {
  const mode = plan.pool?.mode;
  const rules = (plan.rules || []).filter((rule) => rule.enabled !== false);

  const percentageClaims = [];
  let hasFlat = false;
  let hasDependent = false;

  rules.forEach((rule) => {
    const definitions = rule.type === RULE_TYPE.GENERATIONAL_OVERRIDE
      ? (rule.tiers || [])
      : [rule];
    definitions.forEach((definition) => {
      if (definition.value_type === VALUE_TYPE.FLAT_AMOUNT) { hasFlat = true; return; }
      if (DEPENDENT_BASES.includes(definition.basis)) { hasDependent = true; return; }
      if (definition.basis === BASIS.COMMISSIONABLE_BASE || definition.basis === BASIS.POOL) {
        percentageClaims.push({ rule: rule.id, basis: definition.basis, value: Number(definition.value) || 0 });
      }
    });
  });

  // ── Flat pool: shares must not exceed the whole (FR-CAP-004) ──────────────
  if (mode === POOL_MODE.FLAT || mode === POOL_MODE.FLAT_PER_UNIT) {
    const ofPool = percentageClaims.filter((claim) => claim.basis === BASIS.POOL);
    const total = ofPool.reduce((sum, claim) => sum + claim.value, 0);
    if (total > 100) {
      findings.push(error('POOL_SHARES_EXCEED_100',
        `Shares of the pool sum to ${total}%, which is more than the pool. `
        + 'In flat-pool mode shares must sum to 100% or less.', { total }));
    } else if (total < 100) {
      findings.push(warn('POOL_SHARES_UNDER_100',
        `Shares of the pool sum to ${total}%. The remaining ${100 - total}% will follow `
        + `the surplus policy (${plan.surplus || 'BREAKAGE'}).`, { total }));
    }

    const ofBase = percentageClaims.filter((claim) => claim.basis === BASIS.COMMISSIONABLE_BASE);
    if (ofBase.length) {
      findings.push(warn('MIXED_BASIS_IN_FLAT_POOL',
        `${ofBase.length} rule(s) are a percentage of the property price while the pool is a `
        + 'flat amount. Their claims do not scale with the pool and may exhaust it on a '
        + 'high-priced unit.', { rules: ofBase.map((claim) => claim.rule) }));
    }
    return;
  }

  // ── Percentage / hybrid cap: do the price-based rates fit inside it? ───────
  if (mode === POOL_MODE.PERCENTAGE || mode === POOL_MODE.HYBRID) {
    const cap = Number(plan.pool?.percentage) || 0;
    const claimed = percentageClaims
      .filter((claim) => claim.basis === BASIS.COMMISSIONABLE_BASE)
      .reduce((sum, claim) => sum + claim.value, 0);

    if (claimed > cap) {
      findings.push(warn('CLAIMS_EXCEED_CAP',
        `Rules can claim up to ${claimed}% of the commissionable base, but the pool is capped `
        + `at ${cap}%. Every fully-populated deal will be reduced by the `
        + `${plan.resolution || 'PRORATE'} strategy.`,
        { claimed_percentage: claimed, cap_percentage: cap }));
    }
    if (hasFlat) {
      findings.push(warn('FLAT_RULES_UNDER_PERCENTAGE_CAP',
        'Some rules pay a flat amount while the pool is a percentage of price. On a '
        + 'low-priced unit the flat amounts may exceed the pool on their own.'));
    }
    return;
  }

  // ── Uncapped ──────────────────────────────────────────────────────────────
  if (mode === POOL_MODE.UNCAPPED || mode === undefined) {
    const ofPool = percentageClaims.filter((claim) => claim.basis === BASIS.POOL);
    if (ofPool.length) {
      findings.push(error('POOL_BASIS_WITHOUT_POOL',
        `${ofPool.length} rule(s) pay a percentage OF_POOL, but the plan declares no pool. `
        + 'There is nothing for them to be a share of.', { rules: ofPool.map((claim) => claim.rule) }));
    }
    const claimed = percentageClaims
      .filter((claim) => claim.basis === BASIS.COMMISSIONABLE_BASE)
      .reduce((sum, claim) => sum + claim.value, 0);
    findings.push(warn('UNCAPPED_POOL',
      `The plan has no ceiling. A fully-populated genealogy would pay ${claimed}% of the `
      + 'commissionable base'
      + (hasFlat || hasDependent ? ', plus flat and derived amounts on top.' : '.'),
      { claimed_percentage: claimed }));
  }
};

/**
 * Circular basis references (§8.2).
 *
 * `OF_DOWNLINE_COMMISSION` at generation n reads generation n-1, so the chain
 * only terminates if generation 1 reads the direct seller — which it does, by
 * construction in resolveBasis. A cycle is therefore only possible if the
 * direct-sale rule itself is defined in terms of a downstream entitlement, and
 * that is what is refused here.
 */
const checkBasisCycles = (plan, findings) => {
  (plan.rules || [])
    .filter((rule) => rule.type === RULE_TYPE.DIRECT_SALE && rule.enabled !== false)
    .forEach((rule) => {
      if (DEPENDENT_BASES.includes(rule.basis)) {
        findings.push(error('CIRCULAR_BASIS',
          `The direct-sale rule is defined as a percentage of ${rule.basis}, which is itself `
          + 'derived from the direct-sale rule. The value cannot be resolved.', { at: rule.id }));
      }
    });
};

/** Shape checks that do not belong to any one of the passes above. */
const checkShape = (plan, findings) => {
  if (plan.commissionable_base?.mode && !CB_MODES.includes(plan.commissionable_base.mode)) {
    /**
     * Reaching here means something tried to configure a base mode the engine
     * does not have — including, in the case §5.11 cares about, a cost- or
     * margin-derived one. There is no such mode to name, so it fails here as an
     * unknown value rather than needing its own prohibition (FR-PRP-004).
     */
    findings.push(error('CB_MODE_UNKNOWN',
      `Unknown commissionable-base mode "${plan.commissionable_base.mode}". `
      + `The base is always price-derived: ${CB_MODES.join(', ')}.`));
  }
  if (plan.pool?.mode && !POOL_MODES.includes(plan.pool.mode)) {
    findings.push(error('POOL_MODE_UNKNOWN', `Unknown pool mode "${plan.pool.mode}".`));
  }
  if (plan.resolution && !RESOLUTIONS.includes(plan.resolution)) {
    findings.push(error('RESOLUTION_UNKNOWN', `Unknown resolution strategy "${plan.resolution}".`));
  }
  if (plan.surplus && !SURPLUSES.includes(plan.surplus)) {
    findings.push(error('SURPLUS_UNKNOWN', `Unknown surplus policy "${plan.surplus}".`));
  }
  if (plan.stacking && !STACKINGS.includes(plan.stacking)) {
    findings.push(error('STACKING_UNKNOWN', `Unknown stacking mode "${plan.stacking}".`));
  }

  if (plan.pool?.mode === POOL_MODE.TIERED) {
    const bands = plan.pool.bands || [];
    if (!bands.length) {
      findings.push(error('TIERED_POOL_HAS_NO_BANDS', 'A tiered pool defines no price bands.'));
    } else if (!bands.some((band) => band.up_to_minor === null || band.up_to_minor === undefined)) {
      findings.push(error('TIERED_POOL_HAS_NO_TOP_BAND',
        'The highest price band has a ceiling, so a deal above it matches no band and '
        + 'would derive a pool of zero. The last band must be open-ended.'));
    }
  }

  if (plan.pool?.mode === POOL_MODE.HYBRID) {
    const floor = plan.pool.floor_minor;
    const ceiling = plan.pool.ceiling_minor;
    if (floor != null && ceiling != null && asMinor(floor) > asMinor(ceiling)) {
      findings.push(error('HYBRID_FLOOR_ABOVE_CEILING',
        'The pool floor is higher than its ceiling, so the clamp can never be satisfied.'));
    }
  }

  (plan.rules || []).forEach((rule) => {
    if (!RULE_TYPES.includes(rule.type)) {
      findings.push(error('RULE_TYPE_UNSUPPORTED',
        `Rule "${rule.id}" is of type "${rule.type}", which this engine version does not `
        + `implement. Supported: ${RULE_TYPES.join(', ')}.`, { at: rule.id }));
      return;
    }
    if (rule.type === RULE_TYPE.GENERATIONAL_OVERRIDE) {
      if (rule.compression && !COMPRESSIONS.includes(rule.compression)) {
        findings.push(error('COMPRESSION_UNKNOWN',
          `Unknown compression mode "${rule.compression}".`, { at: rule.id }));
      }
      (rule.tiers || []).forEach((tier) => checkValueDefinition(
        `Generation ${tier.generation} of rule "${rule.id}"`, tier, findings,
      ));
      if (rule.open_ended_tier) {
        checkValueDefinition(`The open-ended tier of rule "${rule.id}"`, rule.open_ended_tier, findings);
      }
      return;
    }
    checkValueDefinition(`Rule "${rule.id}"`, rule, findings);
  });
};

/**
 * The platform payout guardrail (FR-CFG-007).
 *
 * Expressed as a percentage of the commissionable base, never of profit —
 * §5.11 again, and the reason there is no margin figure available here to
 * express it against even if someone wanted to.
 *
 * Only price-based percentage claims are counted. Flat amounts and
 * pool-relative shares cannot be compared to a percentage of the base without
 * knowing the deal, which is what the simulator's worst-case exposure report
 * (FR-SIM-004) is for.
 */
const DEFAULT_GUARDRAIL_PERCENTAGE = 100;

const checkGuardrail = (plan, guardrailPercentage, findings) => {
  const limit = Number(guardrailPercentage ?? DEFAULT_GUARDRAIL_PERCENTAGE);
  const mode = plan.pool?.mode;

  // A capped pool cannot pay more than its cap, whatever the rules claim.
  const worstCase = (mode === POOL_MODE.PERCENTAGE || mode === POOL_MODE.HYBRID)
    ? Number(plan.pool.percentage) || 0
    : (plan.rules || [])
      .filter((rule) => rule.enabled !== false)
      .flatMap((rule) => (rule.type === RULE_TYPE.GENERATIONAL_OVERRIDE ? (rule.tiers || []) : [rule]))
      .filter((definition) => definition.value_type === VALUE_TYPE.PERCENTAGE
        && definition.basis === BASIS.COMMISSIONABLE_BASE)
      .reduce((sum, definition) => sum + (Number(definition.value) || 0), 0);

  if (worstCase > limit) {
    findings.push(error('GUARDRAIL_EXCEEDED',
      `The plan can pay up to ${worstCase}% of the commissionable base, above the platform `
      + `guardrail of ${limit}%. Activation requires an explicit override.`,
      { worst_case_percentage: worstCase, guardrail_percentage: limit, overridable: true }));
  }

  return worstCase;
};

/**
 * Validate a plan version.
 *
 * @returns {{ ok, errors, warnings, findings, worst_case_percentage }}
 *          `ok` is false if anything would block activation. An override on the
 *          guardrail is the caller's decision, which is why the finding carries
 *          `overridable` rather than being suppressed here.
 */
const validatePlan = (plan, options = {}) => {
  const findings = [];

  checkShape(plan, findings);
  checkReachability(plan, findings);
  checkPoolCoverage(plan, findings);
  checkBasisCycles(plan, findings);
  const worstCase = checkGuardrail(plan, options.guardrail_percentage, findings);

  const errors = findings.filter((finding) => finding.severity === 'error');
  const warnings = findings.filter((finding) => finding.severity === 'warning');

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    findings,
    worst_case_percentage: worstCase,
  };
};

module.exports = { validatePlan, DEFAULT_GUARDRAIL_PERCENTAGE };

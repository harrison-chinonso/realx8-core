const { asMinor, percentageOf } = require('../money');
const { BASIS, VALUE_TYPE, RULE_TYPE, ROLE, STACKING, EXCLUSION } = require('./vocabulary');

/**
 * The entitlement phase (pipeline step 6): what each participant CLAIMS,
 * computed independently of what the deal can afford.
 *
 * The independence is the point (§5.2). Nothing here knows about the pool. A
 * rule says "a Senior Agent earns 6% of the base" and that is what it produces,
 * whether or not the sum of every claim fits inside the company's cap. The
 * constraint phase then reconciles the total in one place — which is why
 * switching a company from a percentage cap to a flat shared pool does not
 * require re-modelling a single rate.
 */

/**
 * The rate for one participant under one rule, walking the precedence chain in
 * §9 from most specific to most general and stopping at the first match.
 *
 * The `source` is returned alongside the value and stored in the trace. It is
 * the field that answers the only question a realtor actually asks about a
 * rate — "where did 6% come from?" — and answering it from a stored string
 * beats reconstructing the chain months later against configuration that has
 * since moved on.
 */
const resolveRate = (participant, rule, context = {}) => {
  // 1. A rate negotiated with this individual realtor, on this rule.
  const contractual = participant.contractual_rates?.[rule.id];
  if (contractual !== undefined && contractual !== null) {
    return { value: contractual, value_type: rule.value_type, source: 'PARTICIPANT_CONTRACT' };
  }

  // 2. The rule's own explicit value.
  if (rule.value !== undefined && rule.value !== null) {
    return { value: rule.value, value_type: rule.value_type, source: 'RULE' };
  }

  const level = participant.realtor?.level;

  // 3. Level × property-type matrix, where the plan defines one.
  const matrixRate = level && context.property_type
    ? context.level_property_rates?.[`${level.id}:${context.property_type}`]
    : undefined;
  if (matrixRate !== undefined && matrixRate !== null) {
    return { value: matrixRate, value_type: VALUE_TYPE.PERCENTAGE, source: 'LEVEL_PROPERTY_MATRIX' };
  }

  // 4. The level's own default direct rate.
  if (level?.direct_rate !== undefined && level?.direct_rate !== null) {
    return { value: level.direct_rate, value_type: VALUE_TYPE.PERCENTAGE, source: 'LEVEL_DEFAULT' };
  }

  // 5. The plan's fallback.
  if (context.plan_default_rate !== undefined && context.plan_default_rate !== null) {
    return { value: context.plan_default_rate, value_type: VALUE_TYPE.PERCENTAGE, source: 'PLAN_DEFAULT' };
  }

  // Nothing matched. Zero with a named source, rather than a throw: one
  // unconfigured rate must not stop the other participants on the deal being
  // paid, and `UNRESOLVED` in the trace is visible in a way a silent 0 is not.
  return { value: 0, value_type: rule.value_type, source: 'UNRESOLVED' };
};

/**
 * What a basis resolves to, given what has been computed so far (§8.2).
 *
 * `computed` is the running list of entitlements. The two dependent bases read
 * from it, which is why the caller must evaluate in dependency order — direct
 * seller first, then the chain upward.
 */
const resolveBasis = (basis, participant, context, computed) => {
  switch (basis) {
    case BASIS.COMMISSIONABLE_BASE:
      return { amount_minor: context.commissionable_base_minor, of: 'commissionable_base' };

    case BASIS.POOL: {
      /**
       * A percentage of the pool is meaningless when the plan declares no pool
       * — there is no ceiling to take a share of. The validator refuses this
       * combination at configuration time (FR-CFG-008); if one reaches here the
       * entitlement is zero and the trace says why, rather than the rule
       * silently paying a percentage of nothing.
       */
      if (context.pool_minor === null || context.pool_minor === undefined) {
        return { amount_minor: 0, of: 'pool', error: 'pool_is_uncapped' };
      }
      return { amount_minor: context.pool_minor, of: 'pool' };
    }

    case BASIS.DIRECT_EARNER_COMMISSION: {
      // The selling realtor's claim — the classic matching-bonus basis, and
      // what "pay Gen 1 ten percent of what the seller earned" means.
      const direct = computed
        .filter((entry) => entry.role === ROLE.DIRECT)
        .reduce((total, entry) => total + entry.gross_minor, 0);
      return { amount_minor: direct, of: 'direct_earner_commission' };
    }

    case BASIS.DOWNLINE_COMMISSION: {
      /**
       * The node directly beneath this participant in the chain. For Gen 1 that
       * is the selling realtor; for Gen n it is Gen n-1.
       *
       * Read after compression has renumbered the generations, so "the node
       * below" is the node below in the COMPRESSED chain — which is the chain
       * the money actually flows along, not the raw genealogy.
       */
      const generation = Number(participant.generation);
      const below = generation <= 1
        ? computed.filter((entry) => entry.role === ROLE.DIRECT)
        : computed.filter((entry) => entry.role === ROLE.UPLINE
          && Number(entry.generation) === generation - 1);
      const amount = below.reduce((total, entry) => total + entry.gross_minor, 0);
      return { amount_minor: amount, of: 'downline_commission', downline_generation: generation - 1 };
    }

    default:
      return { amount_minor: 0, of: 'unknown', error: `unknown_basis:${basis}` };
  }
};

/** A rule's raw value for one participant, before any cap. */
const valueFor = (rule, participant, context, computed) => {
  const rate = resolveRate(participant, rule, context);

  if (rate.value_type === VALUE_TYPE.FLAT_AMOUNT) {
    /**
     * A flat amount ignores the basis entirely — that is what makes
     * "Gen 1 = 1.5%, Gen 2 = ₦25,000" expressible (FR-GNC-003). The basis is
     * still recorded in the trace so that a reader can see it was not consulted
     * rather than wonder whether it was.
     */
    return {
      gross_minor: asMinor(rate.value),
      trace: {
        value_type: VALUE_TYPE.FLAT_AMOUNT,
        value: rate.value,
        rate_source: rate.source,
        basis: rule.basis ?? null,
        basis_applied: false,
      },
    };
  }

  const basis = resolveBasis(rule.basis, participant, context, computed);
  return {
    gross_minor: percentageOf(basis.amount_minor, rate.value),
    trace: {
      value_type: VALUE_TYPE.PERCENTAGE,
      rate: rate.value,
      rate_source: rate.source,
      basis: rule.basis,
      basis_of: basis.of,
      basis_amount_minor: basis.amount_minor,
      ...(basis.error ? { basis_error: basis.error } : {}),
      ...(basis.downline_generation !== undefined
        ? { downline_generation: basis.downline_generation } : {}),
    },
  };
};

/** Per-participant and per-role ceilings on a single deal (FR-CAP-005). */
const applyCaps = (grossMinor, rule, participant, plan) => {
  const caps = [];
  if (rule.per_participant_cap_minor !== undefined && rule.per_participant_cap_minor !== null) {
    caps.push({ kind: 'rule_participant', limit: asMinor(rule.per_participant_cap_minor) });
  }
  const roleCap = plan?.per_role_caps_minor?.[participant.role];
  if (roleCap !== undefined && roleCap !== null) {
    caps.push({ kind: 'role', limit: asMinor(roleCap) });
  }
  if (!caps.length) return { amount_minor: grossMinor, caps_applied: [] };

  // The tightest cap wins; all of them are recorded, so a trace shows both that
  // a cap bit and which one would have bitten next.
  const binding = caps.reduce((tightest, cap) => (cap.limit < tightest.limit ? cap : tightest));
  const capped = Math.min(grossMinor, binding.limit);
  return {
    amount_minor: capped,
    caps_applied: caps.map((cap) => ({ ...cap, binding: cap === binding && capped < grossMinor })),
  };
};

/**
 * Which rules apply to which participants.
 *
 * Phase 1: the direct-sale rule pays DIRECT (and co-agents, once
 * CO_BROKE_SPLIT lands), the referral bonus pays REFERRER, and the generational
 * override pays UPLINE by matching the participant's generation to a tier.
 */
const rulesFor = (participant, plan) => {
  const enabled = (plan.rules || []).filter((rule) => rule.enabled !== false);

  if (participant.role === ROLE.DIRECT || participant.role === ROLE.CO_AGENT) {
    return enabled.filter((rule) => rule.type === RULE_TYPE.DIRECT_SALE);
  }
  if (participant.role === ROLE.REFERRER) {
    return enabled.filter((rule) => rule.type === RULE_TYPE.REFERRAL_BONUS);
  }
  if (participant.role === ROLE.UPLINE) {
    return enabled
      .filter((rule) => rule.type === RULE_TYPE.GENERATIONAL_OVERRIDE)
      .map((rule) => {
        const tier = tierFor(rule, participant.generation);
        return tier ? { ...rule, ...tier, id: `${rule.id}:gen${participant.generation}` } : null;
      })
      .filter(Boolean);
  }
  return [];
};

/**
 * The tier that pays a given generation.
 *
 * An explicit tier wins. Failing that, an open-ended tier pays every generation
 * from its start depth down to its configured maximum — FR-GNC-008's "Gen 1-2
 * explicit, then 0.25% to all further qualified ancestors". Without the
 * open-ended case a company wanting to pay indefinitely would have to enumerate
 * fifty tiers, and the fifty-first ancestor would earn nothing for no stated
 * reason.
 */
const tierFor = (rule, generation) => {
  const gen = Number(generation);
  const explicit = (rule.tiers || []).find((tier) => Number(tier.generation) === gen);
  if (explicit) return explicit;

  const open = rule.open_ended_tier;
  if (!open) return null;
  const from = Number(open.from_generation ?? 1);
  const to = open.to_generation === null || open.to_generation === undefined
    ? Infinity : Number(open.to_generation);
  return gen >= from && gen <= to ? { ...open, generation: gen, open_ended: true } : null;
};

/**
 * The order participants are evaluated in.
 *
 * Dependency order, not presentation order (§8.2): the selling realtor first
 * because `OF_DIRECT_EARNER_COMMISSION` reads their claim, then the referrer,
 * then uplines ascending by generation because `OF_DOWNLINE_COMMISSION` at
 * generation n reads generation n-1. Evaluating in any other order would make
 * those two bases resolve against entitlements that do not exist yet — as
 * zero, silently.
 */
const RANK = { [ROLE.DIRECT]: 0, [ROLE.CO_AGENT]: 1, [ROLE.REFERRER]: 2, [ROLE.UPLINE]: 3 };

const inDependencyOrder = (participants) => [...participants].sort((a, b) => {
  const rank = (RANK[a.role] ?? 9) - (RANK[b.role] ?? 9);
  if (rank !== 0) return rank;
  return (Number(a.generation) || 0) - (Number(b.generation) || 0);
});

/**
 * Every participant's claim on the deal.
 *
 * @returns {{ entitlements: object[], excluded: object[] }}
 */
const computeEntitlements = (participants, plan, context) => {
  const computed = [];
  const excluded = [];

  inDependencyOrder(participants).forEach((participant) => {
    const applicable = rulesFor(participant, plan);

    if (!applicable.length) {
      // An upline deeper than the configured tiers, with no open-ended tier.
      // Recorded rather than dropped, so FR-ANL-003's generational-depth
      // analysis can show where the tree stops earning and why.
      if (participant.role === ROLE.UPLINE) {
        excluded.push({
          realtor_id: participant.realtor?.id ?? null,
          role: participant.role,
          generation: participant.generation ?? null,
          reason: EXCLUSION.NO_TIER,
          eligibility_check: participant.eligibility_check ?? null,
        });
      }
      return;
    }

    const forParticipant = applicable.map((rule) => {
      const { gross_minor, trace } = valueFor(rule, participant, context, computed);
      const { amount_minor, caps_applied } = applyCaps(gross_minor, rule, participant, plan);
      return {
        realtor_id: participant.realtor?.id ?? null,
        role: participant.role,
        generation: participant.generation ?? null,
        rule_id: rule.id,
        rule_type: rule.type,
        gross_minor: amount_minor,
        eligibility_check: participant.eligibility_check ?? null,
        trace: {
          ...trace,
          rule_id: rule.id,
          rule_type: rule.type,
          uncapped_minor: gross_minor,
          caps_applied,
        },
      };
    });

    /**
     * Two rules paying the same participant on one deal (FR-RUL-005).
     *
     * The case this exists for: the referrer is also somewhere in the seller's
     * upline, so they qualify for both a referral bonus and a generational
     * override. `STACK` pays both, `HIGHEST_ONLY` pays the larger. The plan
     * must say which — defaulting silently either way is how a company
     * discovers it has been double-paying its best-connected realtors.
     */
    if (plan.stacking === STACKING.HIGHEST_ONLY && forParticipant.length > 1) {
      const best = forParticipant.reduce((a, b) => (b.gross_minor > a.gross_minor ? b : a));
      forParticipant.forEach((entry) => {
        if (entry === best) return;
        excluded.push({
          realtor_id: entry.realtor_id,
          role: entry.role,
          generation: entry.generation,
          reason: 'SUPERSEDED_BY_HIGHER_RULE',
          superseded_by: best.rule_id,
          amount_minor: entry.gross_minor,
        });
      });
      computed.push(best);
      return;
    }

    computed.push(...forParticipant);
  });

  return { entitlements: computed, excluded };
};

module.exports = {
  computeEntitlements,
  resolveRate,
  resolveBasis,
  tierFor,
  inDependencyOrder,
};

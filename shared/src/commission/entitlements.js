const { asMinor, percentageOf } = require('../money');
const { fastStart, rankAchievement } = require('./incentives');
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

  /**
   * 2. A rate set for THIS REALTOR'S LEVEL on this rule.
   *
   * The most specific thing a plan can say: "on this plan, an Ambassador earns
   * 8% and a Basic earns 3%". It outranks the plan's flat rate below, because a
   * plan that states both means the flat rate as the answer for levels it did
   * NOT name — otherwise naming a level would have no effect.
   *
   * Matched on level id rather than name. Names are editable, and a company
   * that renames "Premium" would otherwise silently drop every realtor on it
   * back to the flat rate. `level_name` is carried alongside purely so a stored
   * plan version is still readable years later, when the level may be gone.
   */
  const levelRate = (rule.level_rates || [])
    .find((entry) => entry && Number(entry.level_id) === Number(participant.realtor?.level?.id));
  if (levelRate && levelRate.value !== undefined && levelRate.value !== null && levelRate.value !== '') {
    return {
      value: Number(levelRate.value),
      value_type: rule.value_type,
      source: 'PLAN_LEVEL_RATE',
      level_id: levelRate.level_id,
      level_name: levelRate.level_name ?? participant.realtor?.level?.code ?? null,
    };
  }

  /**
   * 3. The rule's own explicit value — the plan's FLAT rate, applying to every
   * realtor whose level the plan did not name. Stated as `value`, or in minor
   * units as `value_minor`.
   *
   * Both spellings are accepted because a flat amount is naturally written in
   * minor units, and a rule that used `value_minor` fell through this branch
   * entirely: it reached step 4 and was paid at the LEVEL's percentage rate. A
   * rule declaring "Gen 2 earns ₦25,000" silently paid 6% of the sale.
   */
  if (rule.value !== undefined && rule.value !== null) {
    return { value: rule.value, value_type: rule.value_type, source: 'RULE' };
  }
  if (rule.value_minor !== undefined && rule.value_minor !== null) {
    return { value: rule.value_minor, value_type: rule.value_type, source: 'RULE' };
  }

  /**
   * A rule that declares a fixed amount never falls back to a percentage.
   *
   * The remaining sources are all percentage rates — a level's direct rate, a
   * property matrix, the plan default. Handing one of them to a rule declared
   * FLAT_AMOUNT or NON_CASH produces a number that is wrong by orders of
   * magnitude and looks entirely plausible in a trace. Unresolved is the
   * honest answer, and it is visible where a silently substituted rate is not.
   */
  if (rule.value_type === VALUE_TYPE.FLAT_AMOUNT || rule.value_type === VALUE_TYPE.NON_CASH) {
    return { value: 0, value_type: rule.value_type, source: 'UNRESOLVED_FIXED_AMOUNT' };
  }

  const level = participant.realtor?.level;

  // 4. Level × property-type matrix, where the plan defines one.
  const matrixRate = level && context.property_type
    ? context.level_property_rates?.[`${level.id}:${context.property_type}`]
    : undefined;
  if (matrixRate !== undefined && matrixRate !== null) {
    return { value: matrixRate, value_type: VALUE_TYPE.PERCENTAGE, source: 'LEVEL_PROPERTY_MATRIX' };
  }

  /**
   * 5. The level's own rate, from the Realtor Levels configuration.
   *
   * The fallback a company wants when its levels already carry the right
   * numbers and a plan has no reason to restate them — one place to change a
   * rate rather than one per plan.
   */
  if (level?.direct_rate !== undefined && level?.direct_rate !== null) {
    return { value: level.direct_rate, value_type: VALUE_TYPE.PERCENTAGE, source: 'LEVEL_DEFAULT' };
  }

  // 6. The plan's own default, for a company that sets one.
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

/**
 * Rank differential: the SPREAD between this upline's rate and the highest
 * already paid below them in the leg (FR-LVL-009).
 *
 * The structural argument for it: under fixed generational tiers, promoting
 * somebody costs a whole extra tier on every deal beneath them. Under a
 * differential it costs only the difference, and a leg can never pay out more
 * in total than its most senior member's rate — which is what makes the
 * company's exposure knowable rather than a function of how deep the tree got.
 *
 * Somebody at or below the highest rate already paid earns NOTHING, and that is
 * the point rather than a gap: their entitlement has already been paid, to
 * somebody closer to the sale.
 */
const rankDifferential = (rule, participant, context, computed) => {
  const myRate = Number(participant.realtor?.level?.direct_rate ?? 0);

  /**
   * The highest rate paid to anyone below this participant.
   *
   * "Below" means the direct seller plus every upline of a lower generation —
   * everybody this override passes through on its way up.
   */
  const generation = Number(participant.generation) || 0;
  const beneath = computed.filter((entry) => entry.role === ROLE.DIRECT
    || (entry.role === ROLE.UPLINE && Number(entry.generation) < generation));

  /**
   * `rank_rate` FIRST, and the order is the whole correctness of this rule.
   *
   * On a differential line `trace.rate` is the SPREAD that line was paid, not
   * the rank it was paid at — Gen 1 on 6% over a 4% seller records rate: 2.
   * Reading that as "the highest paid below" told Gen 2 the leg was only at 4%,
   * so a second 6%-minus-4% spread was paid, and again at every equal rank
   * above. The leg then cost more than its most senior member's rate, which is
   * the one thing a differential is chosen to guarantee.
   *
   * `rank_rate` is the participant's own level rate, which is what "how far up
   * has this leg already been paid" actually means. Direct lines carry no
   * rank_rate and fall through to `rate`, which for them IS their rate.
   */
  const paidBelow = beneath.reduce(
    (highest, entry) => Math.max(highest, Number(entry.trace?.rank_rate ?? entry.trace?.rate ?? 0)),
    0,
  );

  const spread = Math.max(myRate - paidBelow, 0);
  const stop = rule.stop_at_equal_rank !== false && spread <= 0;

  return {
    gross_minor: spread > 0 ? percentageOf(context.commissionable_base_minor, spread) : 0,
    trace: {
      value_type: VALUE_TYPE.PERCENTAGE,
      rule_type: RULE_TYPE.RANK_DIFFERENTIAL,
      rank_rate: myRate,
      highest_paid_below: paidBelow,
      rate: spread,
      rate_source: 'RANK_DIFFERENTIAL',
      basis: BASIS.COMMISSIONABLE_BASE,
      basis_of: 'commissionable_base',
      basis_amount_minor: context.commissionable_base_minor,
      // Said explicitly, because "0" on a payout line invites the question.
      ...(stop ? { stopped: 'no_spread_above_the_leg' } : {}),
    },
  };
};

/** A rule's raw value for one participant, before any cap. */
const valueFor = (rule, participant, context, computed) => {
  if (rule.type === RULE_TYPE.RANK_DIFFERENTIAL) {
    return rankDifferential(rule, participant, context, computed);
  }

  /**
   * The incentives qualify before they pay. Without this they fell through to
   * the ordinary rate resolution, which paid a "first 90 days" bonus on every
   * deal a realtor ever closed and a promotion bonus again on each sale.
   */
  if (rule.type === RULE_TYPE.FAST_START) return fastStart(rule, participant, context);
  if (rule.type === RULE_TYPE.RANK_ACHIEVEMENT) return rankAchievement(rule, participant, context);

  const rate = resolveRate(participant, rule, context);

  /**
   * A non-cash award. Valued, entitled, and never payable in money.
   *
   * The notional value is carried so the pool accounts for what the award
   * actually costs the company — a plan whose awards were free to the pool
   * would let a company hand out ten cars against an 8% ceiling and still
   * believe it was inside it. What the flag prevents is the second payment: a
   * payout run that swept this line up would transfer the value of the prize on
   * top of the prize.
   */
  if (rate.value_type === VALUE_TYPE.NON_CASH) {
    return {
      gross_minor: asMinor(rule.value_minor ?? rate.value),
      trace: {
        value_type: VALUE_TYPE.NON_CASH,
        value: rate.value,
        rate_source: rate.source,
        payout_type: 'NON_CASH',
        award: rule.award ?? rule.label ?? null,
        basis: rule.basis ?? null,
        basis_applied: false,
      },
    };
  }

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

  /**
   * A co-broked sale divides the direct portion (FR-INC-003).
   *
   * Applied to the RATE's product rather than to the basis, so a co-agent on a
   * different level still earns at their OWN rate and takes their share of it —
   * splitting the basis instead would pay everybody at the seller's rate.
   */
  const share = rule.type === RULE_TYPE.DIRECT_SALE && participant.split_share !== undefined
    ? Number(participant.split_share)
    : 1;
  const full = percentageOf(basis.amount_minor, rate.value);

  return {
    gross_minor: share === 1 ? full : Math.round(full * share),
    trace: {
      value_type: VALUE_TYPE.PERCENTAGE,
      rate: rate.value,
      rate_source: rate.source,
      basis: rule.basis,
      basis_of: basis.of,
      basis_amount_minor: basis.amount_minor,
      ...(share === 1 ? {} : { co_broke_share: share, full_minor: full }),
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
    /**
     * POOL_SHARE is deliberately absent.
     *
     * It distributes a periodic pot by production share, and both the pot and
     * everybody's share of it are only known once the period has closed.
     * Evaluated per deal it would pay a share of a pot still filling, and pay
     * it again on every later deal in the same period. See
     * incentives.distributePool, which a periodic job calls once.
     */
    return enabled.filter((rule) => rule.type === RULE_TYPE.DIRECT_SALE
      || rule.type === RULE_TYPE.FAST_START
      || rule.type === RULE_TYPE.RANK_ACHIEVEMENT);
  }
  if (participant.role === ROLE.REFERRER) {
    return enabled.filter((rule) => rule.type === RULE_TYPE.REFERRAL_BONUS);
  }
  if (participant.role === ROLE.UPLINE) {
    return enabled.flatMap((rule) => {
      if (rule.type === RULE_TYPE.GENERATIONAL_OVERRIDE) {
        const tier = tierFor(rule, participant.generation);
        return tier ? [{ ...rule, ...tier, id: `${rule.id}:gen${participant.generation}` }] : [];
      }

      /**
       * A matching bonus applies to a bounded depth rather than to a tier list:
       * it pays a share of what the person below EARNED, so the only question
       * is how far up the chain it reaches.
       */
      if (rule.type === RULE_TYPE.MATCHING_BONUS) {
        const depth = Number(rule.depth ?? 1);
        return Number(participant.generation) <= depth
          ? [{ ...rule, basis: BASIS.DOWNLINE_COMMISSION, id: `${rule.id}:gen${participant.generation}` }]
          : [];
      }

      /**
       * Rank differential pays every upline, and the AMOUNT is what makes it
       * different — see valueFor. The rule applies to the whole chain because
       * whether somebody earns anything depends on their rank relative to
       * those below them, which is not knowable from their generation.
       */
      if (rule.type === RULE_TYPE.RANK_DIFFERENTIAL) {
        return [{ ...rule, id: `${rule.id}:gen${participant.generation}` }];
      }

      return [];
    });
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

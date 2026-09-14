const { ROLE, COMPRESSION, EXCLUSION, RULE_TYPE } = require('./vocabulary');
const { coBrokeSplit } = require('./incentives');

/** Rules that pay somebody above the seller, and so need the chain walked. */
const UPLINE_RULE_TYPES = [
  RULE_TYPE.GENERATIONAL_OVERRIDE,
  RULE_TYPE.RANK_DIFFERENTIAL,
  RULE_TYPE.MATCHING_BONUS,
];
const { tierFor } = require('./entitlements');

/**
 * Building the participant set (pipeline steps 5a–5g).
 *
 * Pure: the caller has already read the genealogy out of the database and hands
 * over an ordered list of ancestors, nearest first. What happens here is the
 * part that is business logic rather than data access — deciding who counts as
 * which generation once the unqualified have been dealt with.
 *
 * ── Why compression is not a detail ─────────────────────────────────────────
 *
 * A genealogy is not a payment ladder. It records who recruited whom, and it is
 * full of people who have stopped selling, never qualified, or joined to buy
 * one unit for themselves. Paying strictly by genealogical distance means the
 * money stops at the first such person, and the active realtor two rungs above
 * them — who is doing the work the override is meant to reward — earns nothing.
 *
 * The three modes differ in what they do about that, and they are genuinely
 * different policies, not variations in strictness:
 *
 *   NONE     pays by raw distance; an unqualified ancestor's tier is forfeited.
 *   ROLL_UP  pays that tier to the next qualified ancestor, keeping the tier
 *            structure intact — Gen 2's money stays Gen 2's money.
 *   DYNAMIC  removes unqualified ancestors BEFORE numbering, so the next
 *            qualified person becomes Gen 2 and the whole ladder slides up.
 *
 * ROLL_UP and DYNAMIC produce different answers whenever more than one tier is
 * involved, and companies mean different things by "skip them". Conflating them
 * silently overpays or underpays every deal in a sparse tree.
 */

/**
 * Does this ancestor meet the tier's own conditions (FR-GNC-005)?
 *
 * Separate from the status gate in eligibility.js, and checked separately. A
 * suspended realtor is not allowed to earn; a realtor who simply has not sold
 * anything this quarter is allowed to earn but has not met the bar this plan
 * sets. They are different refusals with different remedies, and the breakage
 * report (FR-ANL-004) reports them apart.
 */
const meetsQualification = (realtor, qualification) => {
  if (!qualification) return { qualified: true, checks: [] };
  const checks = [];
  const record = (name, ok, required, actual) => {
    checks.push({ name, ok, required, actual });
    return ok;
  };

  let qualified = true;
  if (qualification.min_level_position !== undefined && qualification.min_level_position !== null) {
    qualified = record('min_level_position', (realtor?.level?.position ?? 0) >= qualification.min_level_position,
      qualification.min_level_position, realtor?.level?.position ?? 0) && qualified;
  }
  if (qualification.min_personal_sales_minor) {
    qualified = record('min_personal_sales', (realtor?.period_sales_minor ?? 0) >= qualification.min_personal_sales_minor,
      qualification.min_personal_sales_minor, realtor?.period_sales_minor ?? 0) && qualified;
  }
  if (qualification.min_personal_deals) {
    qualified = record('min_personal_deals', (realtor?.period_deals ?? 0) >= qualification.min_personal_deals,
      qualification.min_personal_deals, realtor?.period_deals ?? 0) && qualified;
  }
  if (qualification.min_active_directs) {
    qualified = record('min_active_directs', (realtor?.active_directs ?? 0) >= qualification.min_active_directs,
      qualification.min_active_directs, realtor?.active_directs ?? 0) && qualified;
  }
  return { qualified, checks };
};

/** The deepest generation this realtor's own level lets them earn (FR-LVL-003). */
const withinLevelDepth = (realtor, generation) => {
  const max = realtor?.level?.max_generations_earnable;
  if (max === undefined || max === null) return true;
  return Number(generation) <= Number(max);
};

/**
 * Tiers the tree was never deep enough to reach.
 *
 * Worked example 10.2 is exactly this: a plan paying four tiers, a seller with
 * two ancestors, and 8% of the pool that belongs to a Gen 3 who does not exist.
 * The money is correctly retained as breakage either way — but with nothing
 * recorded, FR-ANL-004's report can only say that some of the pool went
 * unallocated, which is not a finding anybody can act on. "Forty percent of
 * last quarter's breakage was tiers with no ancestor in them" tells a company
 * its plan is configured deeper than its genealogy actually goes.
 *
 * Open-ended tiers are skipped deliberately: an open-ended tier makes no claim
 * about a particular ancestor existing, so there is nothing for it to be absent
 * from.
 *
 * @param {number} reached  the deepest generation an ancestor actually occupied
 */
const absentTiers = (rule, reached) => (rule?.tiers || [])
  .filter((tier) => Number(tier.generation) > reached)
  .map((tier) => ({
    realtor_id: null,
    role: ROLE.UPLINE,
    generation: Number(tier.generation),
    reason: EXCLUSION.ABSENT,
    compression: rule?.compression || COMPRESSION.NONE,
    note: 'no_ancestor_at_this_generation',
  }));

/**
 * Numbers the upline chain, applying compression.
 *
 * @param {object[]} ancestors  nearest-first, already read from the genealogy
 * @param {object} rule         the GENERATIONAL_OVERRIDE rule in force
 * @returns {{ uplines: object[], excluded: object[] }}
 */
const buildUplines = (ancestors, rule) => {
  const uplines = [];
  const excluded = [];
  const mode = rule?.compression || COMPRESSION.NONE;

  if (mode === COMPRESSION.DYNAMIC) {
    /**
     * Unqualified ancestors are removed from the chain entirely, then what
     * remains is numbered 1, 2, 3… So an unqualified direct sponsor does not
     * "lose Gen 1" — they cease to be in the ladder at all, and the person
     * above them becomes Gen 1.
     */
    let generation = 0;
    ancestors.forEach((ancestor) => {
      const { qualified, checks } = meetsQualification(ancestor, rule?.qualification);
      if (!qualified) {
        excluded.push({
          realtor_id: ancestor?.id ?? null,
          role: ROLE.UPLINE,
          generation: null,
          reason: EXCLUSION.UNQUALIFIED,
          compression: mode,
          qualification_checks: checks,
        });
        return;
      }
      generation += 1;
      if (!withinLevelDepth(ancestor, generation)) {
        excluded.push({
          realtor_id: ancestor?.id ?? null,
          role: ROLE.UPLINE,
          generation,
          reason: EXCLUSION.BEYOND_LEVEL_DEPTH,
          max_generations_earnable: ancestor?.level?.max_generations_earnable ?? null,
        });
        return;
      }
      uplines.push({ realtor: ancestor, role: ROLE.UPLINE, generation });
    });
    excluded.push(...absentTiers(rule, generation));
    return { uplines, excluded };
  }

  // NONE and ROLL_UP both number by raw genealogical distance; they differ only
  // in what happens to a tier whose occupant does not qualify.
  let pendingTiers = [];
  ancestors.forEach((ancestor, index) => {
    const generation = index + 1;
    const { qualified, checks } = meetsQualification(ancestor, rule?.qualification);

    if (!qualified || !withinLevelDepth(ancestor, generation)) {
      const reason = !qualified ? EXCLUSION.UNQUALIFIED : EXCLUSION.BEYOND_LEVEL_DEPTH;
      excluded.push({
        realtor_id: ancestor?.id ?? null,
        role: ROLE.UPLINE,
        generation,
        reason,
        compression: mode,
        ...(reason === EXCLUSION.UNQUALIFIED ? { qualification_checks: checks } : {}),
      });
      /**
       * Under ROLL_UP the vacated tier is carried upward and paid to the next
       * person who does qualify. Under NONE it is simply gone, and shows up in
       * the breakage report.
       */
      if (mode === COMPRESSION.ROLL_UP && tierFor(rule, generation)) pendingTiers.push(generation);
      return;
    }

    uplines.push({ realtor: ancestor, role: ROLE.UPLINE, generation });

    if (mode === COMPRESSION.ROLL_UP && pendingTiers.length) {
      /**
       * This ancestor earns their own tier plus every tier rolled up to them.
       * Recorded as extra participant entries at the vacated generation numbers
       * so the trace names which tier each amount came from — a realtor being
       * paid three tiers wants to see three lines, not one unexplained total.
       */
      pendingTiers.forEach((vacated) => {
        uplines.push({
          realtor: ancestor,
          role: ROLE.UPLINE,
          generation: vacated,
          rolled_up_from_generation: vacated,
          rolled_up_to_generation: generation,
        });
      });
      pendingTiers = [];
    }
  });

  // Tiers still pending at the top of the tree found nobody to roll up to.
  pendingTiers.forEach((generation) => excluded.push({
    realtor_id: null,
    role: ROLE.UPLINE,
    generation,
    reason: EXCLUSION.ABSENT,
    compression: mode,
    note: 'no_qualified_ancestor_above',
  }));

  excluded.push(...absentTiers(rule, ancestors.length));
  return { uplines, excluded };
};

/**
 * The whole participant set for a deal, before the status gate.
 *
 * @param {object} deal    { selling_realtor, referrer?, co_agents[] }
 * @param {object[]} ancestors  nearest-first upline chain of the seller
 * @param {object} plan
 */
const buildParticipants = (deal, ancestors, plan) => {
  const participants = [];
  const excluded = [];

  if (deal.selling_realtor) {
    participants.push({ realtor: deal.selling_realtor, role: ROLE.DIRECT, generation: null });
  }

  (deal.co_agents || []).forEach((agent) => participants.push({
    realtor: agent.realtor, role: ROLE.CO_AGENT, generation: null, split_weight: agent.split_weight ?? 1,
  }));

  /**
   * The referrer is a participant only when they are not already the seller.
   *
   * Always a realtor, never a client (§5.10) — a client-originated referral has
   * been resolved to an attributed realtor before it reaches here (§7.12), so
   * there is no code path in this engine that can produce a client entitlement.
   */
  if (deal.referrer && deal.referrer.id !== deal.selling_realtor?.id) {
    participants.push({ realtor: deal.referrer, role: ROLE.REFERRER, generation: null });
  }

  /**
   * The upline chain is built if ANY rule pays uplines — not only a
   * generational override.
   *
   * This used to look for a GENERATIONAL_OVERRIDE specifically, which was
   * correct while that was the only rule that reached up the tree. Rank
   * differential and matching bonuses also pay uplines, and with the old check
   * a plan built entirely from those produced no upline participants at all:
   * the rules were configured, the validator was happy, and every deal
   * silently paid the seller only.
   *
   * The tier list still comes from the generational rule where there is one,
   * because compression and qualification are its parameters; a plan without
   * one gets the raw chain and each rule decides who it pays.
   */
  const paysUpline = (plan.rules || []).filter((rule) => rule.enabled !== false
    && UPLINE_RULE_TYPES.includes(rule.type));

  if (paysUpline.length) {
    const generational = paysUpline.find((rule) => rule.type === RULE_TYPE.GENERATIONAL_OVERRIDE);
    const { uplines, excluded: uplineExclusions } = buildUplines(
      ancestors || [],
      // Without a generational rule there are no tiers to be absent from, so
      // the qualification and compression settings come from whichever upline
      // rule declares them, and default to paying the raw chain.
      generational || paysUpline[0],
    );
    participants.push(...uplines);
    excluded.push(...uplineExclusions);
  }

  /**
   * A co-broked sale divides the direct portion between the agents who shared
   * it (FR-INC-003), and the shares are computed HERE because this is the only
   * place that sees all of them at once.
   *
   * Each participant carries its own share and the entitlement stage applies it
   * to whatever their own rate produces. Allocated by largest remainder, so a
   * three-way split sums to exactly the pot rather than losing a kobo — a
   * commission that does not reconcile to the penny is one somebody has to
   * explain.
   */
  const coBroke = (plan.rules || []).find(
    (rule) => rule.type === RULE_TYPE.CO_BROKE_SPLIT && rule.enabled !== false,
  );
  if (coBroke) {
    const shares = coBrokeSplit(coBroke, participants);
    participants.forEach((participant) => {
      const share = shares.get(participant.realtor?.id);
      if (share !== undefined) participant.split_share = share;
    });
  }

  return { participants, excluded };
};

module.exports = { buildParticipants, buildUplines, meetsQualification, withinLevelDepth };

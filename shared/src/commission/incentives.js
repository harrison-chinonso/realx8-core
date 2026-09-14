const { asMinor, percentageOf, allocateByWeight } = require('../money');

/**
 * The incentives that are not a percentage of a sale (§7.12, FR-INC-*).
 *
 * Each of these was routed through the ordinary rate resolution before, which
 * meant a FAST_START rule paid its bonus on EVERY deal a realtor ever closed
 * and a RANK_ACHIEVEMENT paid its promotion bonus again on each sale. They read
 * as configured and behaved as a second commission line. The qualification is
 * the rule — without it the rule type is decoration.
 *
 * ── Why a pool share is NOT here as a per-deal rule ─────────────────────────
 *
 * POOL_SHARE distributes a periodic pot among qualifiers by production share.
 * That is a question about a PERIOD, not about a deal: the pot and everybody's
 * share of it are only known once the period has closed. Computing it inside a
 * per-deal calculation would either pay a share of a pot that is still filling,
 * or pay the same share again on every subsequent deal in the period. So
 * `distributePool` takes the closed period's production and is called by a
 * periodic job — see the note on it.
 */

const DAY = 24 * 60 * 60 * 1000;

/** Whole days between two dates, or null when either is unusable. */
const daysBetween = (from, to) => {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return Math.floor((end.getTime() - start.getTime()) / DAY);
};

/**
 * A one-off for a new realtor's first deals (FR-INC-001).
 *
 * Qualified on BOTH a window and a deal count where both are configured, and on
 * whichever is configured otherwise. A company that says "first 90 days" and a
 * company that says "first 3 deals" mean different things, and a company that
 * says both means both.
 *
 * @param {object} rule  { within_days?, first_n_deals?, value_type, value }
 * @param {object} participant
 * @param {object} context  { attribution_date, commissionable_base_minor }
 */
const fastStart = (rule, participant, context) => {
  const realtor = participant.realtor || {};
  const joined = realtor.joined_at ?? realtor.created_at ?? null;
  const closed = Number(realtor.deals_closed_before ?? realtor.deals_closed ?? 0);

  const within = Number(rule.within_days) || 0;
  const firstN = Number(rule.first_n_deals) || 0;

  const reasons = [];

  if (within > 0) {
    const age = joined === null ? null : daysBetween(joined, context.attribution_date);
    /**
     * An unknown joining date does NOT qualify.
     *
     * The alternative — treating a missing date as "new" — pays the bonus to
     * every realtor whose record predates the column, which on any existing
     * installation is all of them.
     */
    if (age === null) reasons.push('joining_date_unknown');
    else if (age > within) reasons.push(`joined_${age}_days_ago`);
  }

  if (firstN > 0 && closed >= firstN) reasons.push(`already_closed_${closed}`);

  if (reasons.length) {
    return {
      gross_minor: 0,
      trace: { rule_type: 'FAST_START', qualified: false, not_qualified_because: reasons },
    };
  }

  const flat = rule.value_type === 'FLAT_AMOUNT';
  return {
    gross_minor: flat
      ? asMinor(rule.value_minor ?? rule.value)
      : percentageOf(context.commissionable_base_minor, Number(rule.value) || 0),
    trace: {
      rule_type: 'FAST_START',
      qualified: true,
      value_type: rule.value_type,
      value: rule.value,
      within_days: within || null,
      first_n_deals: firstN || null,
      deals_closed_before: closed,
    },
  };
};

/**
 * A one-off on promotion (FR-INC-002).
 *
 * ── Paid once per rank, which is the whole difficulty ───────────────────────
 *
 * A promotion bonus is not a property of a deal, but it has to be paid through
 * one, because a deal is what creates a payable. So the rule pays on the FIRST
 * qualifying deal after the promotion and never again, and "never again" is
 * decided by what the realtor has already been paid — which the caller supplies
 * as `rank_bonuses_paid`. The engine stays pure and the record of what has been
 * paid stays where it belongs, in the ledger.
 */
const rankAchievement = (rule, participant, context) => {
  const realtor = participant.realtor || {};
  const rank = realtor.level?.code ?? realtor.level?.id ?? null;
  const achievedAt = realtor.rank_achieved_at ?? null;
  const alreadyPaid = realtor.rank_bonuses_paid || [];

  const reasons = [];
  if (rule.rank_code && String(rule.rank_code) !== String(rank)) {
    reasons.push(`rank_is_${rank}`);
  }
  if (rank === null) reasons.push('no_rank');
  if (alreadyPaid.map(String).includes(String(rank))) reasons.push('already_paid_for_this_rank');

  const within = Number(rule.within_days) || 0;
  if (within > 0) {
    const since = achievedAt === null ? null : daysBetween(achievedAt, context.attribution_date);
    if (since === null) reasons.push('promotion_date_unknown');
    else if (since > within) reasons.push(`promoted_${since}_days_ago`);
  }

  if (reasons.length) {
    return {
      gross_minor: 0,
      trace: { rule_type: 'RANK_ACHIEVEMENT', qualified: false, not_qualified_because: reasons },
    };
  }

  const flat = rule.value_type !== 'PERCENTAGE';
  return {
    gross_minor: flat
      ? asMinor(rule.value_minor ?? rule.value)
      : percentageOf(context.commissionable_base_minor, Number(rule.value) || 0),
    trace: {
      rule_type: 'RANK_ACHIEVEMENT',
      qualified: true,
      rank,
      achieved_at: achievedAt,
      value_type: rule.value_type,
      value: rule.value,
    },
  };
};

/**
 * How the direct portion divides between agents who shared the sale
 * (FR-INC-003).
 *
 * Returns a SHARE for each participant rather than an amount, because the
 * amount is whatever the direct rule produces and that is resolved per
 * participant — a co-agent on a different level may have a different rate, and
 * the split is of the pot, not of one person's entitlement.
 *
 * Allocated by largest remainder, so the shares sum to exactly one pot. Splitting
 * three ways by multiplying each by 1/3 loses a kobo, and a commission that does
 * not reconcile to the penny is a commission somebody has to explain.
 *
 * @returns {Map<any, number>} realtor id -> share of the pot, in minor units of
 *                             a notional 1,000,000 so the caller can scale.
 */
const SHARE_PRECISION = 1_000_000;

const coBrokeSplit = (rule, participants) => {
  const sharing = participants.filter(
    (participant) => participant.role === 'DIRECT' || participant.role === 'CO_AGENT',
  );
  if (sharing.length <= 1) return new Map();

  const weights = sharing.map((participant) => {
    const weight = participant.role === 'DIRECT'
      ? Number(participant.split_weight ?? rule.seller_weight ?? 1)
      : Number(participant.split_weight ?? 1);
    return Math.max(weight, 0);
  });

  if (!weights.some((weight) => weight > 0)) return new Map();

  const shares = allocateByWeight(SHARE_PRECISION, weights);
  return new Map(sharing.map((participant, index) => [
    participant.realtor?.id ?? index,
    shares[index] / SHARE_PRECISION,
  ]));
};

/**
 * Distribute a closed period's pot among its qualifiers (FR-INC-004).
 *
 * NOT a per-deal rule, and the distinction is not pedantic. The pot and each
 * realtor's share of it are only known once the period has closed; computing it
 * on a deal would pay a share of a pot still filling, and then pay it again on
 * the next deal in the same period. This is called once, by a periodic job,
 * with the production figures for the closed period.
 *
 * Qualification is a minimum production figure, because a pool shared among
 * everybody who sold anything is not an incentive.
 *
 * @param {number} potMinor
 * @param {object[]} producers  [{ realtor_id, production_minor }]
 * @param {object} rule         { minimum_production_minor?, equal_shares? }
 */
const distributePool = (potMinor, producers = [], rule = {}) => {
  const pot = asMinor(potMinor);
  const minimum = asMinor(rule.minimum_production_minor ?? 0);
  const qualifiers = producers.filter(
    (producer) => asMinor(producer.production_minor) >= minimum
      && asMinor(producer.production_minor) > 0,
  );

  if (pot <= 0 || !qualifiers.length) {
    return { allocations: [], unallocated_minor: pot, qualifiers: 0 };
  }

  /**
   * `equal_shares` exists because both designs are in use and they reward
   * opposite things: by production, the biggest producer takes most of the pot;
   * equally, the pot rewards reaching the threshold at all. A company choosing
   * one is choosing which behaviour it is paying for.
   */
  const weights = rule.equal_shares
    ? qualifiers.map(() => 1)
    : qualifiers.map((producer) => asMinor(producer.production_minor));

  const shares = allocateByWeight(pot, weights);

  return {
    allocations: qualifiers.map((producer, index) => ({
      realtor_id: producer.realtor_id,
      production_minor: asMinor(producer.production_minor),
      amount_minor: shares[index],
    })),
    unallocated_minor: 0,
    qualifiers: qualifiers.length,
    basis: rule.equal_shares ? 'EQUAL' : 'PRODUCTION',
  };
};

module.exports = { fastStart, rankAchievement, coBrokeSplit, distributePool, daysBetween };

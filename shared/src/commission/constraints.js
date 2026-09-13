const { asMinor, allocateByWeight } = require('../money');
const { RESOLUTION, SURPLUS, POOL_MODE, ROLE, RESIDUAL } = require('./vocabulary');

/**
 * The constraint phase (pipeline step 7): reconciling what everyone claims with
 * what the deal can pay.
 *
 * This is the half of §5.2 that makes requirement 4 a constraint problem rather
 * than a rate problem. The entitlement phase has already produced a list of
 * independent claims; nothing here changes a rate, and nothing here knows why a
 * claim is the size it is. It only decides how a total that does not fit is
 * made to fit — and, for a flat pool, what happens to a total that leaves room.
 */

/** Claims sum to this. */
const totalOf = (entitlements) => entitlements
  .reduce((total, entry) => total + asMinor(entry.gross_minor), 0);

const constrainedCopy = (entry, amountMinor, note) => ({
  ...entry,
  constrained_minor: amountMinor,
  trace: {
    ...entry.trace,
    constraint: { ...note, from_minor: entry.gross_minor, to_minor: amountMinor },
  },
});

/**
 * Everyone scaled by the same factor (FR-CAP-002 `PRORATE`, the default).
 *
 * Allocated by weight rather than multiplied-and-rounded, so the parts sum to
 * the pool exactly — see allocateByWeight. AC-001 checks precisely this: total
 * allocated equals the cap to the kobo, and each participant's trace carries
 * the factor that got them there.
 */
const prorate = (entitlements, poolMinor) => {
  const shares = allocateByWeight(poolMinor, entitlements.map((entry) => entry.gross_minor));
  const total = totalOf(entitlements);
  return entitlements.map((entry, index) => constrainedCopy(entry, shares[index], {
    strategy: RESOLUTION.PRORATE,
    pool_minor: poolMinor,
    claims_total_minor: total,
    // Reported for the reader's benefit, not used in the arithmetic — the
    // allocation is integer and exact, and a float factor here is a
    // description of it rather than an input to it.
    factor: total > 0 ? poolMinor / total : 0,
  }));
};

/**
 * The selling realtor is paid in full; the uplines share what is left
 * (FR-CAP-002 `PROTECT_DIRECT`).
 *
 * The structural argument for it: the direct seller is the participant whose
 * effort is least substitutable, and a company that prorates everyone equally
 * is cutting the person who actually made the sale in order to keep paying a
 * tree that did not.
 */
const protectDirect = (entitlements, poolMinor) => {
  const isDirect = (entry) => entry.role === ROLE.DIRECT || entry.role === ROLE.CO_AGENT;
  const direct = entitlements.filter(isDirect);
  const others = entitlements.filter((entry) => !isDirect(entry));

  const directTotal = totalOf(direct);

  /**
   * The pool does not even cover the direct seller. Protecting them fully would
   * breach the company's own cap, so the protection degrades to a prorate among
   * the direct earners and the uplines get nothing — the cap is the harder
   * constraint of the two.
   */
  if (directTotal >= poolMinor) {
    const shares = allocateByWeight(poolMinor, direct.map((entry) => entry.gross_minor));
    return [
      ...direct.map((entry, index) => constrainedCopy(entry, shares[index], {
        strategy: RESOLUTION.PROTECT_DIRECT,
        pool_minor: poolMinor,
        note: 'pool_below_direct_claim',
      })),
      ...others.map((entry) => constrainedCopy(entry, 0, {
        strategy: RESOLUTION.PROTECT_DIRECT,
        pool_minor: poolMinor,
        note: 'pool_exhausted_by_direct',
      })),
    ];
  }

  const remainder = poolMinor - directTotal;
  const shares = allocateByWeight(remainder, others.map((entry) => entry.gross_minor));
  return [
    ...direct.map((entry) => constrainedCopy(entry, asMinor(entry.gross_minor), {
      strategy: RESOLUTION.PROTECT_DIRECT, pool_minor: poolMinor, protected: true,
    })),
    ...others.map((entry, index) => constrainedCopy(entry, shares[index], {
      strategy: RESOLUTION.PROTECT_DIRECT,
      pool_minor: poolMinor,
      remainder_minor: remainder,
    })),
  ];
};

/**
 * Paid in configured order until the pool runs out (FR-CAP-002
 * `PRIORITY_ORDER`).
 *
 * The last participant to be reached takes whatever is left, which may be a
 * part of their claim or nothing at all. Deliberately harsh and deliberately
 * predictable: unlike proration, every participant either knows they were paid
 * in full or can see exactly where the money stopped.
 */
const priorityOrder = (entitlements, poolMinor) => {
  const ordered = [...entitlements].sort((a, b) => {
    const byPriority = (a.priority ?? 100) - (b.priority ?? 100);
    if (byPriority !== 0) return byPriority;
    // Stable within a priority: role rank, then generation, so two rules at the
    // same priority resolve the same way on every recalculation.
    const rank = { [ROLE.DIRECT]: 0, [ROLE.CO_AGENT]: 1, [ROLE.REFERRER]: 2, [ROLE.UPLINE]: 3 };
    return ((rank[a.role] ?? 9) - (rank[b.role] ?? 9))
      || ((Number(a.generation) || 0) - (Number(b.generation) || 0));
  });

  let remaining = poolMinor;
  const byId = new Map();
  ordered.forEach((entry, position) => {
    const claim = asMinor(entry.gross_minor);
    const paid = Math.max(Math.min(claim, remaining), 0);
    remaining -= paid;
    byId.set(entry, constrainedCopy(entry, paid, {
      strategy: RESOLUTION.PRIORITY_ORDER,
      pool_minor: poolMinor,
      position,
      pool_remaining_after_minor: remaining,
      partially_paid: paid > 0 && paid < claim,
    }));
  });

  // Returned in the ORIGINAL order; only the payment sequence was reordered.
  return entitlements.map((entry) => byId.get(entry));
};

/**
 * A flat pool with room left in it (FR-CAP-003).
 *
 * Arises whenever the tree is shallower than the plan assumes — worked example
 * 10.2, where there is no Gen 3 to take the 8% share. The money has to go
 * somewhere explicit, because the alternative is a pool that quietly pays out
 * less than it is configured to and a commission cost line nobody can reconcile.
 */
const applySurplus = (entitlements, poolMinor, policy) => {
  const allocated = totalOf(entitlements.map((entry) => ({ gross_minor: entry.constrained_minor })));
  const surplus = poolMinor - allocated;
  if (surplus <= 0) return { entitlements, breakage_minor: 0, surplus_minor: 0 };

  switch (policy) {
    case SURPLUS.REDISTRIBUTE_PRORATA: {
      const shares = allocateByWeight(poolMinor, entitlements.map((entry) => entry.constrained_minor));
      return {
        entitlements: entitlements.map((entry, index) => ({
          ...entry,
          constrained_minor: shares[index],
          trace: {
            ...entry.trace,
            surplus: { policy, surplus_minor: surplus, from_minor: entry.constrained_minor },
          },
        })),
        breakage_minor: 0,
        surplus_minor: surplus,
      };
    }

    case SURPLUS.REDISTRIBUTE_TO_DIRECT: {
      const directIndex = entitlements.findIndex((entry) => entry.role === ROLE.DIRECT);
      // No direct earner to give it to — a referral-only deal, say. Retained
      // rather than dropped, so the pool still reconciles.
      if (directIndex === -1) return { entitlements, breakage_minor: surplus, surplus_minor: surplus };
      return {
        entitlements: entitlements.map((entry, index) => (index === directIndex
          ? {
            ...entry,
            constrained_minor: entry.constrained_minor + surplus,
            trace: { ...entry.trace, surplus: { policy, surplus_minor: surplus } },
          }
          : entry)),
        breakage_minor: 0,
        surplus_minor: surplus,
      };
    }

    case SURPLUS.REDISTRIBUTE_TO_HOUSE_ACCOUNT:
      // Distinct from breakage in intent — the company still spends it, on a
      // house account — but identical in this phase: it is not allocated to any
      // participant. The ledger posting differs; see the caller.
      return { entitlements, breakage_minor: 0, surplus_minor: surplus, to_house_account_minor: surplus };

    case SURPLUS.BREAKAGE:
    default:
      return { entitlements, breakage_minor: surplus, surplus_minor: surplus };
  }
};

/**
 * Reconcile claims against the pool.
 *
 * @returns {{ entitlements, pool_minor, claims_total_minor, allocated_minor,
 *             breakage_minor, rejected? }}
 */
const applyConstraints = (entitlements, plan, poolMinor) => {
  const claims = totalOf(entitlements);

  /**
   * No ceiling: every claim stands as computed, and the pool is whatever the
   * rules produced. The company has declared it will pay what the structure
   * says, which is a legitimate — if nerve-wracking — position, and FR-SIM-004's
   * worst-case exposure report exists largely for plans in this mode.
   */
  if (poolMinor === null || poolMinor === undefined) {
    return {
      entitlements: entitlements.map((entry) => constrainedCopy(entry, asMinor(entry.gross_minor), {
        strategy: 'UNCAPPED',
      })),
      pool_minor: claims,
      claims_total_minor: claims,
      allocated_minor: claims,
      breakage_minor: 0,
    };
  }

  if (claims > poolMinor) {
    if (plan.resolution === RESOLUTION.REJECT) {
      /**
       * The deal does not post. Not an error to be swallowed — FR-CLC-007
       * requires the deal to be quarantined and surfaced, because a plan set to
       * REJECT is a company saying it wants a human to look before anything is
       * owed.
       */
      return {
        entitlements: [],
        pool_minor: poolMinor,
        claims_total_minor: claims,
        allocated_minor: 0,
        breakage_minor: 0,
        rejected: {
          reason: 'CLAIMS_EXCEED_POOL',
          claims_total_minor: claims,
          pool_minor: poolMinor,
          excess_minor: claims - poolMinor,
        },
      };
    }

    const constrained = plan.resolution === RESOLUTION.PROTECT_DIRECT
      ? protectDirect(entitlements, poolMinor)
      : plan.resolution === RESOLUTION.PRIORITY_ORDER
        ? priorityOrder(entitlements, poolMinor)
        : prorate(entitlements, poolMinor);

    const allocated = constrained.reduce((total, entry) => total + entry.constrained_minor, 0);
    return {
      entitlements: constrained,
      pool_minor: poolMinor,
      claims_total_minor: claims,
      allocated_minor: allocated,
      // PRIORITY_ORDER can leave the pool unexhausted only if a claim was zero;
      // any genuine remainder is the company's.
      breakage_minor: poolMinor - allocated,
    };
  }

  // Claims fit. Each participant keeps their full claim.
  let constrained = entitlements.map((entry) => constrainedCopy(entry, asMinor(entry.gross_minor), {
    strategy: 'WITHIN_POOL', pool_minor: poolMinor, claims_total_minor: claims,
  }));
  let breakage = 0;
  let surplusInfo = {};

  /**
   * A shortfall only means something in a FIXED pool. Under a percentage cap
   * the pool is a ceiling, not a budget: claims coming in under it is simply
   * the company paying less than its maximum, and there is no surplus to
   * dispose of. Applying a surplus policy there would invent money the plan
   * never promised.
   */
  const isFixedPool = plan.pool?.mode === POOL_MODE.FLAT
    || plan.pool?.mode === POOL_MODE.FLAT_PER_UNIT;

  if (isFixedPool && claims < poolMinor) {
    const result = applySurplus(constrained, poolMinor, plan.surplus || SURPLUS.BREAKAGE);
    constrained = result.entitlements;
    breakage = result.breakage_minor;
    surplusInfo = {
      surplus_minor: result.surplus_minor,
      ...(result.to_house_account_minor
        ? { to_house_account_minor: result.to_house_account_minor } : {}),
    };
  }

  const allocated = constrained.reduce((total, entry) => total + entry.constrained_minor, 0);
  return {
    entitlements: constrained,
    pool_minor: poolMinor,
    claims_total_minor: claims,
    allocated_minor: allocated,
    breakage_minor: breakage,
    ...surplusInfo,
  };
};

module.exports = { applyConstraints, prorate, protectDirect, priorityOrder, applySurplus, totalOf, RESIDUAL };

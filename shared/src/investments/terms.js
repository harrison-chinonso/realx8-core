const { asMinor } = require('../money');

/**
 * The terms of one subscription, fixed at the moment it is made.
 *
 * ── Why terms are copied and not referenced ─────────────────────────────────
 *
 * If a subscription read its rate from the opportunity, then editing the
 * opportunity would retroactively rewrite what every existing investor is owed
 * — including money already paid out, which would leave the ledger disagreeing
 * with the entitlement and no way to tell which was right. Copying the terms at
 * subscription is what makes an investor's contract theirs. The opportunity is
 * a template from that moment on.
 *
 * It is the same reason the promotions module versions a promotion rather than
 * mutating it, and the same reason commission entitlements carry the plan's
 * figures rather than a plan id.
 */

/** How often a return is released. */
const FREQUENCY = {
  AT_MATURITY: 'at_maturity',
  MONTHLY: 'monthly',
  QUARTERLY: 'quarterly',
};
const FREQUENCIES = Object.values(FREQUENCY);

/** Whether earned return itself earns. */
const BASIS = {
  SIMPLE: 'simple',
  COMPOUND: 'compound',
};
const BASES = Object.values(BASIS);

/** What an early exit costs. */
const PENALTY = {
  NONE: 'none',
  PERCENTAGE_OF_RETURN: 'percentage_of_return',
  FLAT_FEE: 'flat_fee',
  FORFEIT_ALL_RETURN: 'forfeit_all_return',
};
const PENALTIES = Object.values(PENALTY);

/**
 * How a year is counted.
 *
 * Stated, because a rate without a day-count convention is not a
 * specification — 30/360 and actual/365 give different answers on the same
 * money, and an investor who recomputes by hand will use one of them.
 */
const DAYS_IN_YEAR = 365;

const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

/**
 * Take the terms an opportunity is offering, ready to store on a subscription.
 *
 * Everything is normalised here rather than at the point of use, so a
 * subscription written today and read in three years cannot be interpreted
 * differently because a default changed in between.
 *
 * @param {object} plan  the opportunity
 * @returns {object} terms, safe to serialise onto the subscription
 */
const termsFrom = (plan = {}) => ({
  /** Annual, as a percentage. 12 means 12% a year. */
  rate_annual: Number(plan.return_rate) || 0,
  frequency: oneOf(plan.payout_frequency, FREQUENCIES, FREQUENCY.AT_MATURITY),
  // Simple unless a company deliberately chose otherwise, and disclosed it.
  basis: oneOf(plan.return_basis, BASES, BASIS.SIMPLE),
  tenor_days: Math.max(Number(plan.tenor_days) || 0, 0),
  days_in_year: DAYS_IN_YEAR,

  /*
   * Exit is refused by default. Silence should not grant a right to withdraw
   * early from money a company has committed to a development.
   */
  early_exit_allowed: plan.early_exit_allowed === true,
  lock_in_days: Math.max(Number(plan.lock_in_days) || 0, 0),
  penalty_type: oneOf(plan.penalty_type, PENALTIES, PENALTY.NONE),
  penalty_value: Number(plan.penalty_value) || 0,
});

/**
 * What the investor is told before they commit, in one sentence each.
 *
 * Generated from the same object the arithmetic uses, so the disclosure and the
 * money cannot disagree — the failure where a screen promises monthly and the
 * engine pays at maturity is not available.
 */
const describeTerms = (terms = {}) => {
  const frequency = {
    [FREQUENCY.AT_MATURITY]: 'paid once, at maturity',
    [FREQUENCY.MONTHLY]: 'paid monthly',
    [FREQUENCY.QUARTERLY]: 'paid quarterly',
  }[terms.frequency] || 'paid at maturity';

  const lines = [
    `${terms.rate_annual}% a year, ${terms.basis === BASIS.COMPOUND ? 'compounding' : 'simple'}, ${frequency}.`,
    `Your money is committed for ${terms.tenor_days} days.`,
  ];

  if (!terms.early_exit_allowed) {
    lines.push('It cannot be withdrawn early.');
  } else {
    if (terms.lock_in_days > 0) {
      lines.push(`No withdrawal in the first ${terms.lock_in_days} days.`);
    }
    lines.push({
      [PENALTY.NONE]: 'Early withdrawal carries no penalty.',
      [PENALTY.PERCENTAGE_OF_RETURN]: `Early withdrawal costs ${terms.penalty_value}% of the return earned.`,
      [PENALTY.FLAT_FEE]: `Early withdrawal carries a fee of ${terms.penalty_value}.`,
      [PENALTY.FORFEIT_ALL_RETURN]: 'Early withdrawal forfeits all return earned; capital is returned.',
    }[terms.penalty_type] || 'Early withdrawal carries no penalty.');
  }

  return lines;
};

/** Principal in minor units, whatever shape it arrives in. */
const principalOf = (subscription = {}) => asMinor(
  subscription.funded_minor ?? subscription.principal_minor ?? 0,
);

module.exports = {
  FREQUENCY, FREQUENCIES, BASIS, BASES, PENALTY, PENALTIES, DAYS_IN_YEAR,
  termsFrom, describeTerms, principalOf,
};

const { asMinor } = require('../money');
const { PENALTY } = require('./terms');
const { accruedAt, hasMatured, daysBetween } = require('./accrual');

/**
 * What an investor walks away with, and what it costs them to leave early.
 *
 * ── Why the figure is computed before it is agreed to ───────────────────────
 *
 * An early exit is the one moment in this feature where somebody loses money
 * they can see on their own screen. They are entitled to know exactly how much
 * before they confirm — capital, return earned, penalty, net — rather than
 * after, when the only remedy is a support ticket and a reversal.
 *
 * So this returns a quotation. Nothing here writes anything.
 */

/** Why an exit is refused, in the words the investor needs. */
const REFUSAL = {
  not_allowed: 'This investment cannot be withdrawn early. It is committed until maturity.',
  locked_in: (days) => `This investment cannot be withdrawn for the first ${days} days.`,
  not_funded: 'There is nothing to withdraw — this subscription has not been funded.',
  already_closed: 'This investment has already been closed.',
};

/**
 * Quote an exit.
 *
 * @param {object} terms         as stored on the subscription
 * @param {object} context       { principalMinor, fundedAt, asAt, paidMinor, status }
 * @returns {{ allowed, reason?, capital_minor, earned_minor, penalty_minor, net_minor, matured, lines[] }}
 */
const quoteExit = (terms = {}, context = {}) => {
  const capital = asMinor(context.principalMinor);
  const paid = asMinor(context.paidMinor);
  const asAt = context.asAt || new Date();

  const refuse = (reason, message) => ({
    allowed: false,
    reason,
    message,
    capital_minor: capital,
    earned_minor: 0,
    penalty_minor: 0,
    net_minor: 0,
    matured: false,
    lines: [],
  });

  if (['completed', 'cancelled', 'exited'].includes(context.status)) {
    return refuse('already_closed', REFUSAL.already_closed);
  }
  if (capital <= 0 || !context.fundedAt) {
    return refuse('not_funded', REFUSAL.not_funded);
  }

  const matured = hasMatured(terms, context.fundedAt, asAt);
  const { earned_minor: earnedTotal } = accruedAt(terms, {
    principalMinor: capital, fundedAt: context.fundedAt, asAt,
  });

  /*
   * At or past maturity this is not an early exit at all — it is the ordinary
   * end of the agreement, and no penalty applies however the plan is
   * configured. Treating a matured investment as an early withdrawal would
   * charge somebody for waiting the full term.
   */
  if (matured) {
    const outstanding = Math.max(earnedTotal - paid, 0);
    return {
      allowed: true,
      matured: true,
      capital_minor: capital,
      earned_minor: outstanding,
      penalty_minor: 0,
      net_minor: capital + outstanding,
      lines: [
        { label: 'Capital returned', amount_minor: capital },
        { label: 'Return still owed', amount_minor: outstanding },
      ],
    };
  }

  if (!terms.early_exit_allowed) return refuse('not_allowed', REFUSAL.not_allowed);

  const held = daysBetween(context.fundedAt, asAt);
  const lockIn = Math.max(Number(terms.lock_in_days) || 0, 0);
  if (lockIn > 0 && held < lockIn) {
    return refuse('locked_in', REFUSAL.locked_in(lockIn));
  }

  const outstanding = Math.max(earnedTotal - paid, 0);
  const penalty = penaltyOn(terms, { earnedMinor: outstanding });

  /*
   * A penalty can take the return but never the capital. Handing back less than
   * was put in turns a withdrawal into a loss, which is not what any of these
   * penalty types say and not something a company should be able to configure
   * by accident.
   */
  const charged = Math.min(penalty, outstanding);

  return {
    allowed: true,
    matured: false,
    capital_minor: capital,
    earned_minor: outstanding,
    penalty_minor: charged,
    net_minor: capital + outstanding - charged,
    lines: [
      { label: 'Capital returned', amount_minor: capital },
      { label: 'Return earned so far', amount_minor: outstanding },
      ...(charged > 0 ? [{ label: 'Early withdrawal penalty', amount_minor: -charged }] : []),
    ],
  };
};

/** What the configured penalty comes to, before it is capped at the return. */
const penaltyOn = (terms = {}, { earnedMinor = 0 } = {}) => {
  const earned = asMinor(earnedMinor);
  switch (terms.penalty_type) {
    case PENALTY.FORFEIT_ALL_RETURN:
      return earned;
    case PENALTY.PERCENTAGE_OF_RETURN:
      // Rounded UP, like the withholding in the commission engine: a penalty
      // that rounds down leaves the company carrying the fraction.
      return Math.ceil((earned * (Number(terms.penalty_value) || 0)) / 100);
    case PENALTY.FLAT_FEE:
      return asMinor(terms.penalty_value_minor ?? (Number(terms.penalty_value) || 0) * 100);
    case PENALTY.NONE:
    default:
      return 0;
  }
};

module.exports = { quoteExit, penaltyOn, REFUSAL };

const { asMinor } = require('../money');
const { FREQUENCY, BASIS, DAYS_IN_YEAR } = require('./terms');

/**
 * What an investment has earned, computed rather than typed in.
 *
 * ── Cumulative, never an increment ──────────────────────────────────────────
 *
 * Every function here answers "how much has this earned in total by date X",
 * and the caller subtracts what has already been paid. That contract is the
 * whole of the idempotency story: a scheduler that runs twice on Tuesday
 * computes the same total twice and the second run pays nothing, where an
 * incremental function would pay Tuesday twice and nobody would notice until an
 * investor's statement was reconciled by hand.
 *
 * It is the same shape as the commission vesting engine, deliberately — that
 * one settled the argument already.
 *
 * ── Integer minor units ─────────────────────────────────────────────────────
 *
 * The rest of this platform does money in kobo, and this module does too. The
 * investment service's DECIMAL columns read into JavaScript floats were the
 * single most dangerous thing in the FRD's findings: compounding a float
 * monthly for sixty months does not round, it drifts, in a direction nobody can
 * predict, on the one number an investor will check with a calculator.
 *
 * ── Pure ────────────────────────────────────────────────────────────────────
 *
 * No database, no clock of its own, no configuration lookup. Everything it
 * needs arrives as arguments, which is what makes it exhaustively testable and
 * what lets a disputed figure be reconstructed years later from the terms that
 * were stored rather than from today's settings.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days between two dates; negative spans clamp to zero. */
const daysBetween = (from, to) => {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  return Math.max(Math.floor((end.getTime() - start.getTime()) / MS_PER_DAY), 0);
};

/** How many days of a tenor have actually elapsed, never more than the tenor. */
const elapsedDays = (terms, { fundedAt, asAt }) => {
  const elapsed = daysBetween(fundedAt, asAt);
  const tenor = Math.max(Number(terms.tenor_days) || 0, 0);
  // Accrual stops at maturity. Money left in past its term does not keep
  // earning at the agreed rate — that is a new agreement, not this one.
  return tenor > 0 ? Math.min(elapsed, tenor) : elapsed;
};

/**
 * How many whole compounding periods have completed.
 *
 * Compounding happens ON the payout frequency, because that is the moment the
 * return becomes the investor's — a monthly plan that compounds does so
 * monthly, and a plan paying at maturity has nothing to compound onto.
 */
const PERIOD_DAYS = {
  [FREQUENCY.MONTHLY]: DAYS_IN_YEAR / 12,
  [FREQUENCY.QUARTERLY]: DAYS_IN_YEAR / 4,
};

/**
 * Cumulative return earned by a given date.
 *
 * @param {object} terms   as stored on the subscription — see terms.js
 * @param {object} context { principalMinor, fundedAt, asAt }
 * @returns {{ earned_minor, days, periods, basis, reason }}
 */
const accruedAt = (terms = {}, context = {}) => {
  const principal = asMinor(context.principalMinor);
  const rate = Number(terms.rate_annual) || 0;
  const perYear = Math.max(Number(terms.days_in_year) || DAYS_IN_YEAR, 1);

  if (principal <= 0) {
    return { earned_minor: 0, days: 0, periods: 0, basis: terms.basis, reason: 'not_funded' };
  }
  if (rate <= 0) {
    return { earned_minor: 0, days: 0, periods: 0, basis: terms.basis, reason: 'no_rate' };
  }
  if (!context.fundedAt) {
    // Not funded is not the same as funded today: a subscription with no money
    // against it has not started its tenor and earns nothing.
    return { earned_minor: 0, days: 0, periods: 0, basis: terms.basis, reason: 'not_funded' };
  }

  const days = elapsedDays(terms, context);
  if (days <= 0) {
    return { earned_minor: 0, days: 0, periods: 0, basis: terms.basis, reason: 'no_time_elapsed' };
  }

  if (terms.basis === BASIS.COMPOUND && PERIOD_DAYS[terms.frequency]) {
    const periodDays = PERIOD_DAYS[terms.frequency];
    const periods = Math.floor(days / periodDays);
    const periodRate = rate / 100 / (perYear / periodDays);

    /*
     * Compounded over COMPLETE periods only, then simple interest on the
     * remainder.
     *
     * Paying a part-period as though it had compounded would credit the
     * investor for a period that has not happened; ignoring it entirely would
     * quietly withhold days they have actually waited. Complete periods
     * compound, the tail accrues simply — which is what a bank statement does.
     */
    const grown = Math.round(principal * ((1 + periodRate) ** periods));
    const compoundedEarned = grown - principal;

    const tailDays = days - Math.floor(periods * periodDays);
    const tailEarned = Math.floor((grown * rate * tailDays) / (100 * perYear));

    return {
      earned_minor: Math.max(compoundedEarned + tailEarned, 0),
      days,
      periods,
      basis: BASIS.COMPOUND,
      reason: 'compounded',
    };
  }

  /*
   * Simple: principal × rate × days ÷ year.
   *
   * Floored rather than rounded. A fraction of a kobo that does not exist is
   * not owed, and flooring means the company never pays out more than it
   * computed — the direction of error that does not end in an unfunded
   * liability.
   */
  const earned = Math.floor((principal * rate * days) / (100 * perYear));

  return {
    earned_minor: Math.max(earned, 0),
    days,
    periods: 0,
    basis: BASIS.SIMPLE,
    reason: 'simple',
  };
};

/**
 * What is payable NOW, given what has already been paid.
 *
 * The subtraction the caller would otherwise do, kept here so that the
 * clamp at zero is not forgotten: a correction that reduces the funded amount
 * can make cumulative earnings fall below what has been paid, and the answer to
 * that is "nothing further is due", never a negative payout.
 */
const duePayoutMinor = (terms, context, paidMinor = 0) => {
  const { earned_minor: earned } = accruedAt(terms, context);
  return Math.max(earned - asMinor(paidMinor), 0);
};

/**
 * When the next release falls due.
 *
 * `at_maturity` has exactly one, on the maturity date. The periodic ones step
 * forward from the funding date, so a plan funded on the 3rd pays on the 3rd —
 * an investor should be able to predict the date without consulting anybody.
 */
const nextPayoutDate = (terms = {}, { fundedAt, asAt = new Date() } = {}) => {
  if (!fundedAt) return null;
  const funded = new Date(fundedAt);
  if (Number.isNaN(funded.getTime())) return null;

  const tenor = Math.max(Number(terms.tenor_days) || 0, 0);
  const maturity = new Date(funded.getTime() + tenor * MS_PER_DAY);

  if (terms.frequency === FREQUENCY.AT_MATURITY || !PERIOD_DAYS[terms.frequency]) {
    return maturity;
  }

  const periodDays = PERIOD_DAYS[terms.frequency];
  const elapsed = daysBetween(funded, asAt);
  const next = (Math.floor(elapsed / periodDays) + 1) * periodDays;
  const candidate = new Date(funded.getTime() + Math.round(next) * MS_PER_DAY);

  // Never past maturity: the last release is the maturity one, however the
  // periods happen to fall.
  return candidate > maturity ? maturity : candidate;
};

/**
 * The last moment a release actually fell due.
 *
 * ── Why accrual is measured to here, not to "now" ───────────────────────────
 *
 * A monthly investor is owed the return for the months that have FINISHED. On
 * day 100 of a monthly plan, three periods have closed and ten days of a fourth
 * have passed — and those ten days are not yet theirs to be paid, because they
 * were told monthly.
 *
 * Measuring to now would release a part-period early, every single run, which
 * both contradicts the terms and makes every subsequent figure a correction.
 * Measuring to the last boundary makes the amount owed naturally ZERO between
 * releases and exactly right on them, with no separate "is it due yet" test to
 * keep in step.
 *
 * At or past maturity the answer is maturity itself: the final release is
 * everything remaining, whenever the sweep happens to notice.
 */
const lastReleaseDate = (terms = {}, { fundedAt, asAt = new Date() } = {}) => {
  if (!fundedAt) return null;
  const funded = new Date(fundedAt);
  if (Number.isNaN(funded.getTime())) return null;

  const maturity = maturityDate(terms, fundedAt);
  const at = new Date(asAt);
  if (maturity && at.getTime() >= maturity.getTime()) return maturity;

  // At maturity only — nothing is released before it.
  if (terms.frequency === FREQUENCY.AT_MATURITY || !PERIOD_DAYS[terms.frequency]) return null;

  const periodDays = PERIOD_DAYS[terms.frequency];
  const elapsed = daysBetween(funded, at);
  const completed = Math.floor(elapsed / periodDays);
  if (completed <= 0) return null;

  return new Date(funded.getTime() + Math.round(completed * periodDays) * MS_PER_DAY);
};

/**
 * What is releasable now: accrued to the last boundary, less what has been paid.
 *
 * This is the figure a payout should use. `duePayoutMinor` accrues to the
 * moment asked about, which is what a STATEMENT wants — an investor should see
 * what they have earned to date even if it is not yet payable.
 */
const releasableMinor = (terms, { fundedAt, asAt = new Date(), principalMinor }, paidMinor = 0) => {
  const boundary = lastReleaseDate(terms, { fundedAt, asAt });
  if (!boundary) return 0;
  const { earned_minor: earned } = accruedAt(terms, { principalMinor, fundedAt, asAt: boundary });
  return Math.max(earned - asMinor(paidMinor), 0);
};

/** The date a subscription matures, or null if it has not been funded. */
const maturityDate = (terms = {}, fundedAt) => {
  if (!fundedAt) return null;
  const funded = new Date(fundedAt);
  if (Number.isNaN(funded.getTime())) return null;
  return new Date(funded.getTime() + (Math.max(Number(terms.tenor_days) || 0, 0)) * MS_PER_DAY);
};

/** Whether the tenor has run its course by a given date. */
const hasMatured = (terms, fundedAt, asAt = new Date()) => {
  const maturity = maturityDate(terms, fundedAt);
  if (!maturity) return false;
  const at = new Date(asAt);
  return !Number.isNaN(at.getTime()) && at.getTime() >= maturity.getTime();
};

module.exports = {
  accruedAt, duePayoutMinor, releasableMinor, lastReleaseDate,
  nextPayoutDate, maturityDate, hasMatured, daysBetween, elapsedDays,
};

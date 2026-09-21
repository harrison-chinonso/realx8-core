const crypto = require('crypto');
const { asMinor } = require('../money');

/**
 * Pairing what the bank says with what the ledger says (ACC-6.2).
 *
 * ── Suggestions, never decisions ────────────────────────────────────────────
 *
 * Nothing here matches anything. It scores candidates and hands them to a
 * person, because a wrong automatic match is invisible: the reconciliation
 * balances, both sides are used up, and the two transactions that were
 * actually swapped are never looked at again. A wrong SUGGESTION costs a
 * glance.
 *
 * The one exception the scoring allows is an exact reference match on an exact
 * amount, which is reported as `certain` — and even then the caller decides
 * whether to accept it in bulk.
 *
 * ── Realx8 starts with an advantage here ────────────────────────────────────
 *
 * Most receipts already carry the payer's own reference, taken from the proof
 * of payment when the buyer uploaded it. That is the same string the bank
 * prints in its narration, which makes reference matching unusually effective
 * on this platform compared with a general ledger that only has amounts and
 * dates to work with.
 */

/** How close in days still counts as the same movement. */
const DATE_TOLERANCE_DAYS = 5;

const daysBetween = (a, b) => Math.abs(
  (new Date(`${a}T00:00:00Z`) - new Date(`${b}T00:00:00Z`)) / 86400000,
);

/**
 * The comparable core of a reference.
 *
 * Banks pad, prefix and decorate: "TRF FRM KELVIN O/REF INV-0001" and
 * "INV-0001" are the same reference wearing a bank's formatting. Reducing both
 * to letters and digits and asking whether one contains the other catches that
 * without pretending to parse a narration.
 */
const normalise = (value) => String(value || '')
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, '');

const referenceMatches = (a, b) => {
  const left = normalise(a);
  const right = normalise(b);
  /*
   * Six characters, so that a short common fragment does not match everything.
   * "REF" appears in half a bank's narrations; "INV0001" does not.
   */
  if (left.length < 6 || right.length < 6) return false;
  return left.includes(right) || right.includes(left);
};

/**
 * Score one candidate against one statement line.
 *
 * @returns {{ score, reasons, certainty }} or null where the amounts differ —
 * an amount mismatch is not a weak match, it is a different transaction, and
 * scoring it at all would put noise in front of a person.
 */
const scoreCandidate = (line, candidate) => {
  const lineAmount = Math.abs(asMinor(line.amount_minor));
  const candidateAmount = Math.abs(asMinor(candidate.amount_minor));
  if (lineAmount !== candidateAmount) return null;

  /*
   * Direction has to agree too. A ₦500,000 receipt and a ₦500,000 payment on
   * the same day are the same number and opposite events, and matching one to
   * the other would balance the reconciliation while describing the company's
   * month backwards.
   */
  const lineIn = asMinor(line.amount_minor) > 0;
  const candidateIn = asMinor(candidate.amount_minor) > 0;
  if (lineIn !== candidateIn) return null;

  const reasons = ['the amount is the same'];
  let score = 50;

  const gap = candidate.entry_date && line.statement_date
    ? daysBetween(candidate.entry_date, line.statement_date)
    : null;

  if (gap === null) {
    // No date to compare. Not fatal, but not evidence either.
  } else if (gap === 0) {
    score += 30; reasons.push('the same day');
  } else if (gap <= 2) {
    score += 20; reasons.push(`${gap} day${gap === 1 ? '' : 's'} apart`);
  } else if (gap <= DATE_TOLERANCE_DAYS) {
    score += 10; reasons.push(`${gap} days apart`);
  } else {
    score -= 20; reasons.push(`${Math.round(gap)} days apart`);
  }

  const referenceHit = referenceMatches(line.reference, candidate.reference)
    || referenceMatches(line.description, candidate.reference)
    || referenceMatches(line.reference, candidate.memo)
    || referenceMatches(line.description, candidate.memo);

  if (referenceHit) {
    score += 40;
    reasons.push('the reference appears on both');
  }

  return {
    score,
    reasons,
    /*
     * "Certain" is the same amount, the same direction, within a few days AND
     * a reference that appears on both. Anything less is a suggestion, however
     * high it scores — two identical rent payments a week apart will always
     * score well and are exactly the pair a person needs to look at.
     */
    certainty: referenceHit && gap !== null && gap <= DATE_TOLERANCE_DAYS ? 'certain' : 'possible',
  };
};

/**
 * Rank the ledger entries that could be one statement line.
 *
 * Candidates already used by another line are excluded by the caller, which
 * holds the state; this stays a pure function of one line and a list.
 */
const suggestFor = (line, candidates, { limit = 5 } = {}) => candidates
  .map((candidate) => {
    const scored = scoreCandidate(line, candidate);
    return scored ? { ...scored, candidate } : null;
  })
  .filter(Boolean)
  .sort((a, b) => b.score - a.score)
  .slice(0, limit);

/**
 * A stable identifier for a statement line as the bank printed it.
 *
 * Date, amount and reference — enough that re-importing a month does not
 * double every movement in it, and coarse enough that a bank re-exporting the
 * same line with an extra space still matches. Two genuinely identical
 * transfers on one day collide, which is the accepted cost: that case is rarer
 * than the re-import, and a person can add the second by hand.
 */
const fingerprintOf = ({ statement_date: date, amount_minor: amount, reference, description }) => crypto
  .createHash('sha256')
  .update([date, asMinor(amount), normalise(reference) || normalise(description)].join('|'))
  .digest('hex')
  .slice(0, 48);

module.exports = {
  DATE_TOLERANCE_DAYS,
  normalise,
  referenceMatches,
  scoreCandidate,
  suggestFor,
  fingerprintOf,
};

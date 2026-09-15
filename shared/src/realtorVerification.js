const { q, tableExists } = require('./dialect');

/**
 * Whether a realtor has been verified, asked from outside user-service.
 *
 * ── Why this is one function and not four checks ────────────────────────────
 *
 * A realtor may EARN commission unverified — entitlements accrue exactly as
 * before — but may not be PAID. That rule has to hold at every door money can
 * leave by, and there are four of them: the realtor asking for a payout of one
 * commission, the realtor asking for a payout of their whole statement, an
 * administrator raising a debit note against a realtor, and the payout run
 * raising one on their behalf.
 *
 * Four separate checks would drift. The first one somebody forgets is not a
 * visible bug — it is a payment that goes out, and nothing anywhere says it
 * should not have.
 *
 * ── Why it reads the table directly ─────────────────────────────────────────
 *
 * `realtor_kyc` belongs to user-service, and this is called from
 * finance-service. Every service in this deployment shares one database and
 * already reads across that line the same way — finance reads `users` by raw
 * query in half a dozen places. An HTTP call between two services in the same
 * process would add a failure mode to a question that is one indexed row.
 *
 * ── The answer when the table is not there ──────────────────────────────────
 *
 * Verification is a feature that arrived after the commission engine. On a
 * database that predates it the table is missing, and the honest answer is that
 * verification is not in force here — so payment proceeds. Blocking every
 * payout on every older deployment because a table has not been created yet
 * would be a far worse failure than the one this guard exists to prevent.
 */

/** Cached per process: the table either exists for this deployment or it does not. */
let tablePresent = null;

const kycTableExists = async (sequelize) => {
  if (tablePresent === null) tablePresent = await tableExists(sequelize, 'realtor_kyc');
  return tablePresent;
};

/**
 * @returns {Promise<{ verified: boolean, status: string|null, enforced: boolean }>}
 *   `enforced` is false when this deployment has no verification table at all,
 *   which is the one case where an unverified realtor may still be paid.
 */
const realtorVerification = async (sequelize, realtorId) => {
  if (!realtorId) return { verified: false, status: null, enforced: true };

  if (!await kycTableExists(sequelize)) {
    return { verified: true, status: null, enforced: false };
  }

  const [rows] = await sequelize.query(
    `SELECT ${q(sequelize, 'status')} FROM ${q(sequelize, 'realtor_kyc')}
     WHERE ${q(sequelize, 'user_id')} = :realtorId
     ORDER BY ${q(sequelize, 'id')} DESC LIMIT 1`,
    { replacements: { realtorId } },
  );

  const status = rows?.[0]?.status ?? null;
  return { verified: status === 'approved', status, enforced: true };
};

/**
 * What to tell somebody who cannot be paid.
 *
 * Three different situations, and they need three different sentences: a
 * realtor who never submitted has to be told to submit, one who is waiting has
 * to be told to wait rather than resubmit, and one who was turned down has to
 * be sent to the reason. "Unverified" alone leaves all three of them guessing,
 * and the administrator reading it over their shoulder guessing too.
 */
const REASONS = {
  none: 'has not submitted their identity verification yet',
  pending: 'has submitted their identity verification but it has not been reviewed yet',
  rejected: 'had their identity verification rejected and has not resubmitted',
};

const verificationReason = (status) => REASONS[status || 'none'] || REASONS.none;

/** The message an administrator sees when a payout is refused. */
const staffBlockedMessage = (name, status) => `${name || 'That realtor'} ${verificationReason(status)}. `
  + 'An unverified realtor cannot be paid — approve their verification under '
  + 'User Management → Realtor → Realtor Verification first.';

/** The message the realtor themselves sees. */
const realtorBlockedMessage = (status) => {
  if (status === 'pending') {
    return 'Your identity verification is still being reviewed. You can request a payout once it is approved. '
      + 'Your commission keeps accruing in the meantime.';
  }
  if (status === 'rejected') {
    return 'Your identity verification was not accepted, so a payout cannot be requested yet. '
      + 'Update your documents under Profile → Verification and submit them again. '
      + 'Your commission is safe and keeps accruing.';
  }
  return 'You need to complete identity verification before requesting a payout. '
    + 'Go to Profile → Verification to submit your ID and proof of address. '
    + 'Your commission keeps accruing in the meantime.';
};

/**
 * The message a realtor sees when they try to share or refer.
 *
 * Its own wording rather than the payout one with words swapped: the two say
 * different things. A blocked payout is money waiting; a blocked referral is a
 * link they cannot hand out, which affects what they do next hour rather than
 * what they are owed.
 */
const realtorReferralBlockedMessage = (status) => {
  const tail = 'Until then you cannot share properties or refer clients.';
  if (status === 'pending') {
    return `Your identity verification is still being reviewed. ${tail}`;
  }
  if (status === 'rejected') {
    return 'Your identity verification was not accepted. Update your documents under '
      + `Profile → Verification and submit them again. ${tail}`;
  }
  return 'You need to complete identity verification first — go to Profile → Verification '
    + `and submit your ID and proof of address. ${tail}`;
};

/** Reset between tests; the table's existence is cached for the process. */
const resetVerificationCache = () => { tablePresent = null; };

module.exports = {
  realtorVerification,
  verificationReason,
  staffBlockedMessage,
  realtorBlockedMessage,
  realtorReferralBlockedMessage,
  resetVerificationCache,
};

const { QueryTypes } = require('sequelize');
const { realtorVerification } = require('./realtorVerification');
const { q } = require('./dialect');

/**
 * Which company a new account belongs to, and which realtor introduced them.
 *
 * ── Why this is shared rather than written twice ────────────────────────────
 *
 * Ordinary registration and Google sign-up both have to answer it, and they
 * have to answer it the SAME way — a client who arrives through a realtor's
 * shared link should be attributed to that realtor whether they type a password
 * or press "Continue with Google". Two implementations diverge the moment one
 * of them is fixed, and the divergence is invisible: nobody notices an
 * unattributed client until a realtor asks where their commission went.
 *
 * ── Every account belongs to a company ──────────────────────────────────────
 *
 * The database enforces it — `ck_users_company_scoped` allows a null company
 * only for a platform admin. Google sign-up did not know that: it created
 * clients with no company, the constraint refused every one, and the failure
 * surfaced as a generic "google_auth_failed" that said nothing about the cause.
 * Resolving the company BEFORE attempting to create is what turns that into an
 * answerable message.
 */

/** Normalises a code the way both entry points must: trimmed and upper-cased. */
const normaliseCode = (value) => String(value || '').trim().toUpperCase();

/**
 * Resolve the company from its referral code.
 *
 * @returns {Promise<{ ok, company, reason, message }>}
 */
const companyFromCode = async (sequelize, code) => {
  const wanted = normaliseCode(code);
  if (!wanted) {
    return {
      ok: false,
      reason: 'company_code_missing',
      message: 'A company code is needed to create an account. '
        + 'Use the link your company or agent sent you.',
    };
  }

  const [company] = await sequelize.query(
    `SELECT id, name, status FROM ${q(sequelize, 'companies')}
      WHERE UPPER(referral_code) = :code LIMIT 1`,
    { replacements: { code: wanted }, type: QueryTypes.SELECT },
  );

  if (!company) {
    return {
      ok: false,
      reason: 'company_code_invalid',
      message: 'That company code was not recognised. Check it with whoever sent you the link.',
    };
  }
  if (company.status === 'suspended') {
    return {
      ok: false,
      reason: 'company_suspended',
      message: 'That company account is currently suspended.',
    };
  }
  return { ok: true, company };
};

/**
 * The realtor whose link this person arrived through.
 *
 * ── Scoped to the company, deliberately ─────────────────────────────────────
 *
 * A code from another company — or a tampered URL — must not attach the account
 * elsewhere. Commission follows attribution, so an unscoped lookup would let
 * anybody claim introductions they did not make by editing a query string.
 *
 * ── An unknown code never blocks the sign-up ────────────────────────────────
 *
 * The account is still perfectly valid; it is simply not attributed. Refusing
 * would turn a stale link into a wall between somebody and the thing they were
 * trying to buy, which is a far worse outcome than an unattributed client.
 */
const realtorFromCode = async (sequelize, { code, companyId }) => {
  const wanted = normaliseCode(code);
  if (!wanted || !companyId) return null;

  const [realtor] = await sequelize.query(
    `SELECT id, name, company_id FROM ${q(sequelize, 'users')}
      WHERE UPPER(realtor_code) = :code AND type = 'realtor'
        AND company_id = :companyId AND deleted_at IS NULL
      LIMIT 1`,
    { replacements: { code: wanted, companyId }, type: QueryTypes.SELECT },
  ).catch(() => []);

  if (!realtor) return null;

  /*
   * An unverified realtor refers nobody.
   *
   * They cannot mint a share link at all, so in the ordinary case this never
   * fires. It exists for the link that was already out — shared before their
   * verification was rejected, or forwarded by somebody else — because a code
   * in circulation outlives the page that produced it.
   *
   * The buyer is NOT turned away. They followed a link in good faith and can
   * fix nothing; they register with the company, unattributed. It is the
   * realtor who loses the referral, which is the rule being applied.
   */
  const verification = await realtorVerification(sequelize, realtor.id);
  return verification.verified ? realtor : null;
};

/**
 * Both answers at once, for a sign-up.
 *
 * When no company code is supplied but a REALTOR code is, the realtor's own
 * company is used. That is the case that actually happens: a realtor shares a
 * property link carrying only their code, and the buyer who follows it should
 * not be asked for a company code they have never seen.
 */
const resolveSignup = async (sequelize, { companyCode, realtorCode }) => {
  const realtorWanted = normaliseCode(realtorCode);

  if (!normaliseCode(companyCode) && realtorWanted) {
    const [realtor] = await sequelize.query(
      `SELECT u.id, u.name, u.company_id, c.name AS company_name, c.status AS company_status
         FROM ${q(sequelize, 'users')} u
         JOIN ${q(sequelize, 'companies')} c ON c.id = u.company_id
        WHERE UPPER(u.realtor_code) = :code AND u.type = 'realtor' AND u.deleted_at IS NULL
        LIMIT 1`,
      { replacements: { code: realtorWanted }, type: QueryTypes.SELECT },
    ).catch(() => []);

    if (realtor) {
      if (realtor.company_status === 'suspended') {
        return { ok: false, reason: 'company_suspended', message: 'That company account is currently suspended.' };
      }
      /*
       * The company still resolves from the code — the buyer gets where they
       * were going — but an unverified realtor is not credited for them.
       */
      const verification = await realtorVerification(sequelize, realtor.id);
      return {
        ok: true,
        company: { id: realtor.company_id, name: realtor.company_name },
        realtor: verification.verified ? { id: realtor.id, name: realtor.name } : null,
      };
    }
    // The realtor code led nowhere, so fall through and complain about the
    // company code — which is the thing actually missing.
  }

  const resolved = await companyFromCode(sequelize, companyCode);
  if (!resolved.ok) return resolved;

  const realtor = await realtorFromCode(sequelize, {
    code: realtorCode, companyId: resolved.company.id,
  });

  return { ok: true, company: resolved.company, realtor };
};

module.exports = { resolveSignup, companyFromCode, realtorFromCode, normaliseCode };

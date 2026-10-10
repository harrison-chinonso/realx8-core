const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const { User } = require('../models');
const { sequelize } = require('../config/database');
const { resolveSignup, realtorFromCode } = require('../../../../shared/src/signupAttribution');
const { recordReferral, STATUS: REFERRAL_STATUS } = require('../../../../shared/src/referralRecord');
const { emailAvailability } = require('../../../../shared/src/emailIdentity');
const { BCRYPT_ROUNDS } = require('../../../../shared/src/passwordPolicy');
const billing = require('../../../../shared/src/billing');

/**
 * Finding — or creating — the account a social sign-in means.
 *
 * One body of rules for every provider (Google through passport, Apple from
 * the native app), so the two cannot drift: the same company-code pinning,
 * the same multi-company choice, the same availability checks and the same
 * referral trail. Each provider has its own id column and nothing else.
 *
 * @returns {Promise<
 *   { user } |
 *   { multi: true, accounts: number[] } |
 *   { refused: { message, reason } }
 * >}
 */
const PROVIDER_COLUMNS = { google: 'google_id', apple: 'apple_id' };

const findOrCreateSocialAccount = async ({
  provider, providerId, email: rawEmail, name, avatar = null, companyCode = null, realtorCode = null,
}) => {
  const column = PROVIDER_COLUMNS[provider];
  if (!column || !providerId) throw new Error(`Unknown social provider: ${provider}`);

  // Required lazily: authController requires this module.
  // eslint-disable-next-line global-require
  const { syncUserRoles } = require('../controllers/authController');

  const email = rawEmail ? String(rawEmail).toLowerCase() : null;
  const where = email
    ? { [Op.or]: [{ [column]: providerId }, { email }] }
    : { [column]: providerId };

  /**
   * Every account this identity could mean, not the first one.
   *
   * An address belongs to a person and a person may hold an account at
   * several companies, so `findOne` here was choosing between them by row
   * order — which meant a realtor with two agencies landed in whichever one
   * was created first, every time, with no way to reach the other.
   *
   * The provider has proved control of the address, which is why an account
   * may be ADDED to that identity below without a password: proving the
   * address is what the password requirement at registration stands in for.
   */
  const matches = await User.findAll({ where: { ...where, deleted_at: null }, order: [['id', 'ASC']] });

  /*
   * A company code pins the answer. Somebody following an agency's sign-up
   * link is saying which company they mean, whether or not they already have
   * an account elsewhere.
   */
  const pinned = companyCode
    ? await resolveSignup(sequelize, { companyCode, realtorCode })
    : null;
  if (pinned && !pinned.ok) return { refused: { message: pinned.message, reason: pinned.reason } };
  const pinnedCompanyId = pinned?.company?.id ?? null;

  let user = pinnedCompanyId != null
    ? matches.find((row) => Number(row.company_id) === Number(pinnedCompanyId)) || null
    : (matches.length === 1 ? matches[0] : null);

  /**
   * More than one account and nothing to choose between them. The caller
   * turns the candidates into a company choice; returned as a plain marker so
   * nothing downstream can mistake it for a decision that has been made.
   */
  if (!user && matches.length > 1 && pinnedCompanyId == null) {
    return { multi: true, accounts: matches.map((row) => row.id) };
  }

  const fallbackName = name || email || `${provider[0].toUpperCase()}${provider.slice(1)} User`;
  const create = async (companyId, realtorId) => {
    /*
     * Asked before every insert. `matches` skips soft-deleted rows while the
     * unique index on (email, company_id) covers them, so without this a
     * removed account turns into a bare constraint failure instead of a
     * sentence somebody can act on.
     */
    const availability = await emailAvailability(sequelize, { email, companyId, type: 'client' });
    if (!availability.ok) return { refused: { message: availability.message, reason: 'email_unavailable' } };

    /**
     * A random password it will never use. A social sign-in does not go
     * through one, and accounts no longer share a credential — copying
     * another company's hash would hand this company a password the person
     * never chose for it. The reset flow is where one comes from, if wanted.
     */
    // Held in the company's queue if it has lapsed or is full (shared/src/billing.js).
    const admission = await billing.canAdmitMember(sequelize, companyId);
    const created = await User.create({
      ...(admission.admit ? {} : { is_active: false, billing_hold: true }),
      name: fallbackName,
      email: email || `${providerId}@${provider}-oauth.local`,
      password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), BCRYPT_ROUNDS),
      type: 'client',
      [column]: providerId,
      avatar,
      company_id: companyId,
      // A client who arrived through an agent's link belongs to that agent,
      // whichever way they signed up.
      realtor_id: realtorId ?? null,
    });
    await syncUserRoles(created.id, ['client']);
    if (created.realtor_id) {
      await recordReferral(sequelize, {
        referrerId: created.realtor_id,
        referredUserId: created.id,
        companyId: created.company_id ?? null,
        linkCode: realtorCode || null,
        source: provider,
        status: REFERRAL_STATUS.REGISTERED,
      });
    }
    return { user: created };
  };

  // Known address, but not at the company being joined: another account for an existing person.
  if (!user && matches.length && pinnedCompanyId != null) {
    return create(pinnedCompanyId, pinned?.realtor?.id);
  }

  if (!user) {
    /**
     * A new account needs a company BEFORE it is created — the database
     * allows a null company only for a platform admin. Resolved here for the
     * path that had no code, where it produces the refusal explaining that
     * one was required.
     */
    const attribution = pinned || await resolveSignup(sequelize, { companyCode, realtorCode });
    if (!attribution.ok) return { refused: { message: attribution.message, reason: attribution.reason } };
    return create(attribution.company.id, attribution.realtor?.id);
  }

  let shouldSave = false;
  /*
   * Linked only if no other row already carries this id. The column is
   * unique, and a person with accounts at two companies reaches the second by
   * email — writing the id there too would fail on the index (removed rows
   * included) and turn a good sign-in into an error.
   */
  if (!user[column] && !(await User.count({ where: { [column]: providerId } }))) {
    user[column] = providerId;
    shouldSave = true;
  }
  if (!user.avatar && avatar) {
    user.avatar = avatar;
    shouldSave = true;
  }
  if (!user.name && name) {
    user.name = name;
    shouldSave = true;
  }
  /**
   * Attribute an existing account that has no agent yet. An account that
   * ALREADY has an agent is never reassigned — that would let a second link
   * quietly take another agent's client, and their commission with them.
   */
  if (!user.realtor_id && realtorCode && user.company_id) {
    const realtor = await realtorFromCode(sequelize, { code: realtorCode, companyId: user.company_id });
    if (realtor) {
      user.realtor_id = realtor.id;
      shouldSave = true;
      await recordReferral(sequelize, {
        referrerId: realtor.id,
        referredUserId: user.id,
        companyId: user.company_id ?? null,
        linkCode: realtorCode || null,
        source: provider,
        status: REFERRAL_STATUS.REGISTERED,
      });
    }
  }
  if (shouldSave) await user.save();

  return { user };
};

module.exports = { findOrCreateSocialAccount, PROVIDER_COLUMNS };

const { QueryTypes } = require('sequelize');
const { q, isDuplicateError } = require('./dialect');
const { realtorVerification } = require('./realtorVerification');

/**
 * The five characters a realtor's referral link is built from.
 *
 * ── Why it is issued here rather than at creation ───────────────────────────
 *
 * It used to be generated in exactly one place: the screen where an
 * administrator keys in a realtor by hand. Every other way of becoming one —
 * signing up through a company code, following an agent's link, joining a
 * second company from inside the app — produced a realtor with no code at all,
 * and the referral panel told them to "ask an administrator to generate one",
 * which is not something an administrator has a button for.
 *
 * Issuing it on demand fixes that for every path at once, including the ones
 * not written yet, because they all end up reading the code rather than
 * setting it.
 *
 * ── And only for a verified realtor ─────────────────────────────────────────
 *
 * A code is not a formality, it is an attribution: every client who registers
 * through it is credited to its holder for the life of their account, and the
 * commission follows. signupAttribution already refuses to credit an unverified
 * realtor, so a code issued before verification would be a link that works,
 * looks right, and silently attributes nobody — discovered weeks later by the
 * person who shared it.
 *
 * So the code comes into existence at the same moment it would start being
 * honoured. Before that this returns null, and the panel says why.
 */
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LENGTH = 5;
const ATTEMPTS = 20;

/** Excludes I, O, 0 and 1 — the pairs people mistype when reading a code aloud. */
const randomCode = () => {
  let code = '';
  for (let i = 0; i < LENGTH; i += 1) {
    code += CHARSET[Math.floor(Math.random() * CHARSET.length)];
  }
  return code;
};

const codeExists = async (sequelize, code, { transaction = null } = {}) => {
  const rows = await sequelize.query(
    `SELECT id FROM users WHERE UPPER(${q(sequelize, 'realtor_code')}) = :code LIMIT 1`,
    { replacements: { code }, type: QueryTypes.SELECT, transaction },
  );
  return rows.length > 0;
};

/** A code nothing else is using. Throws only if twenty draws all collide. */
const mintRealtorCode = async (sequelize, { transaction = null } = {}) => {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const code = randomCode();
    // eslint-disable-next-line no-await-in-loop
    if (!await codeExists(sequelize, code, { transaction })) return code;
  }
  throw new Error('Could not generate a unique realtor code');
};

/**
 * This realtor's code, issuing one if they have earned it and have none.
 *
 * Returns null rather than throwing for everybody it does not apply to — a
 * client, an unverified realtor, a missing row — because every caller is
 * reading a code in order to show it, and "there isn't one" is an answer they
 * all already handle.
 *
 * @returns {Promise<string|null>}
 */
const ensureRealtorCode = async (sequelize, userId, { transaction = null } = {}) => {
  if (!userId) return null;

  const [row] = await sequelize.query(
    `SELECT id, ${q(sequelize, 'realtor_code')} AS code, ${q(sequelize, 'type')} AS type
       FROM users WHERE id = :id AND deleted_at IS NULL LIMIT 1`,
    { replacements: { id: userId }, type: QueryTypes.SELECT, transaction },
  );

  if (!row || row.type !== 'realtor') return null;
  if (row.code) return row.code;

  const { verified } = await realtorVerification(sequelize, userId);
  if (!verified) return null;

  const code = await mintRealtorCode(sequelize, { transaction });
  try {
    await sequelize.query(
      `UPDATE users SET ${q(sequelize, 'realtor_code')} = :code WHERE id = :id`,
      { replacements: { code, id: userId }, type: QueryTypes.UPDATE, transaction },
    );
  } catch (error) {
    /*
     * Two requests from the same newly verified realtor can arrive together —
     * the referral page and the share button, say — draw different codes, and
     * race for the unique index. The loser reads back what the winner wrote
     * rather than failing: one code is the point, and which of the two it is
     * does not matter to anybody.
     */
    if (!isDuplicateError(error)) throw error;
    const [after] = await sequelize.query(
      `SELECT ${q(sequelize, 'realtor_code')} AS code FROM users WHERE id = :id LIMIT 1`,
      { replacements: { id: userId }, type: QueryTypes.SELECT, transaction },
    );
    return after?.code ?? null;
  }

  console.log(`[realtor] issued referral code ${code} to user ${userId} on verification`);
  return code;
};

module.exports = { ensureRealtorCode, mintRealtorCode };

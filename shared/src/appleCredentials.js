const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const { q } = require('./dialect');
const { appSecret } = require('./appSecret');
const { accountsForEmail } = require('./emailIdentity');
const { exchangeAuthorizationCode, revokeRefreshToken } = require('./appleTokens');

/**
 * Keeping, and revoking, a person's Sign in with Apple refresh token.
 *
 * Shared because two services end accounts: auth-service when somebody
 * deletes their own (Settings → delete my account) and user-service when an
 * administrator removes them. Either way, once a person has no account left
 * here, Apple must be told to sever the link (App Review 5.1.1(v)).
 *
 * Tokens live in apple_credentials (auth-service migration), one row per
 * Apple ID, encrypted with a key both services derive from the same secret.
 */

const TABLE = 'apple_credentials';
const key = () => crypto.createHash('sha256').update(`apple-credentials:${appSecret()}`).digest();

const encrypt = (plain) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
};

const decrypt = (stored) => {
  const [version, iv, tag, data] = String(stored || '').split(':');
  if (version !== 'v1' || !iv || !tag || !data) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null; // a different secret, or tampered: nothing usable to revoke with
  }
};

/**
 * Exchange a sign-in's authorisation code and keep the refresh token. One row
 * per Apple ID; a later sign-in replaces it with the newer token. Best effort:
 * logged, never thrown — it must not stop anybody signing in.
 */
const rememberAppleToken = async (sequelize, { sub, clientId, email, authorizationCode }) => {
  if (!authorizationCode || !sub) return;
  try {
    const refreshToken = await exchangeAuthorizationCode({ code: authorizationCode, clientId });
    if (!refreshToken) return;
    const table = q(sequelize, TABLE);
    const replacements = { sub, clientId, email: email ? String(email).toLowerCase() : null, token: encrypt(refreshToken) };
    const [existing] = await sequelize.query(`SELECT id FROM ${table} WHERE apple_sub = :sub LIMIT 1`,
      { replacements, type: QueryTypes.SELECT });
    await sequelize.query(
      existing
        ? `UPDATE ${table} SET client_id = :clientId, email = COALESCE(:email, email), refresh_token = :token,
            updated_at = NOW() WHERE apple_sub = :sub`
        : `INSERT INTO ${table} (apple_sub, client_id, email, refresh_token, created_at, updated_at)
            VALUES (:sub, :clientId, :email, :token, NOW(), NOW())`,
      { replacements, type: existing ? QueryTypes.UPDATE : QueryTypes.INSERT },
    );
  } catch (error) {
    console.error('[apple] could not keep the refresh token:', error.message);
  }
};

/**
 * Revoke Sign in with Apple when an account's removal leaves the person with
 * none. Accounts are per company and one Apple ID can stand for several, so
 * removing ONE is not the person leaving — their Apple sign-in still opens the
 * others. Matched by the Apple ids on any of the person's rows (removed ones
 * included) and by the address the token was kept under.
 *
 * Call AFTER the account is gone: revoking cannot be undone.
 *
 * @returns {Promise<string[]>} one outcome per Apple ID, for the audit log. Never throws.
 */
const revokeAppleIfLastAccount = async (sequelize, user) => {
  try {
    const email = String(user?.email || '').toLowerCase();
    if (!email) return [];
    if ((await accountsForEmail(sequelize, email)).length) return [];

    const table = q(sequelize, TABLE);
    const linked = await sequelize.query(
      'SELECT apple_id FROM users WHERE apple_id IS NOT NULL AND (id = :id OR LOWER(email) = :email)',
      { replacements: { id: user.id, email }, type: QueryTypes.SELECT },
    );
    const subs = linked.map((row) => row.apple_id);
    const rows = await sequelize.query(
      `SELECT id, client_id, refresh_token FROM ${table}
        WHERE LOWER(email) = :email${subs.length ? ' OR apple_sub IN (:subs)' : ''}`,
      { replacements: { email, subs }, type: QueryTypes.SELECT },
    );

    const outcomes = [];
    for (const row of rows) {
      const refreshToken = decrypt(row.refresh_token);
      const outcome = await revokeRefreshToken({ refreshToken, clientId: row.client_id });
      outcomes.push(outcome);
      // Kept when Apple could not be reached, for a retry; dropped once Apple has it or it is unusable.
      if (outcome === 'revoked' || !refreshToken) {
        await sequelize.query(`DELETE FROM ${table} WHERE id = :id`, { replacements: { id: row.id }, type: QueryTypes.DELETE });
      } else {
        console.warn(`[apple] token for an Apple ID not revoked (${outcome}); it remains for a retry`);
      }
    }
    return outcomes;
  } catch (error) {
    console.error('[apple] revoke failed:', error.message);
    return ['failed'];
  }
};

module.exports = { rememberAppleToken, revokeAppleIfLastAccount, encrypt, decrypt };

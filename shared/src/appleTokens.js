const jwt = require('jsonwebtoken');

/**
 * Sign in with Apple's REST side: turning an authorisation code into a
 * refresh token, and revoking it.
 *
 * ── Why it is needed at all ─────────────────────────────────────────────────
 *
 * Apple requires an app offering Sign in with Apple to revoke the person's
 * Apple tokens when they delete their account (App Review 5.1.1(v)), so the
 * link between the Apple ID and the app is actually severed. Revoking needs a
 * token, and the identity token used to sign in is not one Apple accepts for
 * that — so at sign-in the app's one-time authorisation code is exchanged for
 * a refresh token, which is kept (encrypted) for the day it is revoked.
 *
 * ── Credentials ─────────────────────────────────────────────────────────────
 *
 *   APPLE_TEAM_ID            (falls back to APNS_TEAM_ID — it is the same team)
 *   APPLE_SIGNIN_KEY_ID      the key's id
 *   APPLE_SIGNIN_KEY         the .p8 with Sign in with Apple enabled, raw or base64
 *
 * Without them the exchange is skipped and revocation reports "not
 * configured": signing in keeps working, and the gap is logged rather than
 * failing anybody's sign-in or deletion.
 */

const APPLE_AUDIENCE = 'https://appleid.apple.com';
const TOKEN_URL = 'https://appleid.apple.com/auth/token';
const REVOKE_URL = 'https://appleid.apple.com/auth/revoke';

const decode = (raw) => {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (value.startsWith('-----')) return value;
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
};

const credentials = () => {
  const teamId = process.env.APPLE_TEAM_ID || process.env.APNS_TEAM_ID;
  const keyId = process.env.APPLE_SIGNIN_KEY_ID;
  const key = decode(process.env.APPLE_SIGNIN_KEY);
  return teamId && keyId && key ? { teamId, keyId, key } : null;
};

const isConfigured = () => Boolean(credentials());

/**
 * The client secret Apple asks for: a short-lived ES256 JWT naming our team
 * and the app (`sub` = the bundle id the token was issued to). Made per call —
 * it is cheap, and a long-lived one would be one more secret lying around.
 */
const clientSecret = (clientId, creds = credentials()) => {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: creds.teamId, iat: now, exp: now + 5 * 60, aud: APPLE_AUDIENCE, sub: clientId },
    creds.key,
    { algorithm: 'ES256', keyid: creds.keyId },
  );
};

const form = (fields) => new URLSearchParams(Object.entries(fields).filter(([, v]) => v != null));

/**
 * Exchange the authorisation code from a sign-in for a refresh token.
 * @returns {Promise<string|null>} — null when not configured or refused; never throws.
 */
const exchangeAuthorizationCode = async ({ code, clientId }) => {
  const creds = credentials();
  if (!creds || !code || !clientId) return null;
  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        client_id: clientId,
        client_secret: clientSecret(clientId, creds),
        code,
        grant_type: 'authorization_code',
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.refresh_token) {
      console.warn(`[apple] code exchange refused (${response.status}): ${body.error || 'no refresh token'}`);
      return null;
    }
    return body.refresh_token;
  } catch (error) {
    console.warn('[apple] code exchange failed:', error.message);
    return null;
  }
};

/**
 * Revoke a refresh token. Apple answers 200 for a token that is already
 * revoked or unknown, so a 200 means "this app no longer holds access".
 * @returns {Promise<'revoked'|'not_configured'|'failed'>} — never throws.
 */
const revokeRefreshToken = async ({ refreshToken, clientId }) => {
  const creds = credentials();
  if (!creds) return 'not_configured';
  if (!refreshToken || !clientId) return 'failed';
  try {
    const response = await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        client_id: clientId,
        client_secret: clientSecret(clientId, creds),
        token: refreshToken,
        token_type_hint: 'refresh_token',
      }),
    });
    if (response.ok) return 'revoked';
    console.warn(`[apple] revoke refused (${response.status})`);
    return 'failed';
  } catch (error) {
    console.warn('[apple] revoke failed:', error.message);
    return 'failed';
  }
};

module.exports = {
  exchangeAuthorizationCode, revokeRefreshToken, clientSecret, isConfigured, APPLE_AUDIENCE,
};

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

/**
 * Verifying a Sign in with Apple identity token.
 *
 * The native app (Realx8-Mobile) asks iOS for a credential and sends the
 * identity token it gets back. That token is a JWT signed by Apple, and it
 * is the whole of the proof: nothing else the app sends is trusted. So every
 * claim that matters is checked here —
 *
 *   signature  against Apple's published keys (fetched, cached for an hour,
 *              refetched once if a token names a key we have not seen)
 *   iss        https://appleid.apple.com
 *   aud        one of OUR bundle ids (APPLE_CLIENT_IDS) — a token Apple issued
 *              to some other app must not sign anybody in here
 *   exp        not expired
 *   nonce      sha256 of the raw nonce the app sends alongside, so a token
 *              lifted from one sign-in cannot be replayed into another
 *
 * `email` is only taken as proof of the address when Apple says it verified
 * it. A private-relay address (…@privaterelay.appleid.com) is a real, working
 * address for this app and is treated like any other.
 */

const APPLE_ISSUER = 'https://appleid.apple.com';
const KEYS_URL = 'https://appleid.apple.com/auth/keys';
const KEY_TTL_MS = 60 * 60 * 1000;

const allowedClientIds = () => String(process.env.APPLE_CLIENT_IDS || 'com.realx8.app')
  .split(',').map((id) => id.trim()).filter(Boolean);

let keyCache = { keys: [], fetchedAt: 0 };

const fetchKeys = async () => {
  const response = await fetch(KEYS_URL);
  if (!response.ok) throw new Error(`Apple keys unavailable (${response.status})`);
  const body = await response.json();
  keyCache = { keys: Array.isArray(body?.keys) ? body.keys : [], fetchedAt: Date.now() };
  return keyCache.keys;
};

const keyFor = async (kid) => {
  const fresh = Date.now() - keyCache.fetchedAt < KEY_TTL_MS;
  let jwk = fresh ? keyCache.keys.find((key) => key.kid === kid) : null;
  // Apple rotates keys; an unknown kid earns exactly one refetch.
  if (!jwk) jwk = (await fetchKeys()).find((key) => key.kid === kid);
  if (!jwk) throw new Error('Apple signing key not found');
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
};

const sha256Hex = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/**
 * @returns {Promise<{ sub, clientId, email, emailVerified, isPrivateEmail }>} — throws
 *   on anything that does not verify.
 */
const verifyAppleIdentityToken = async (identityToken, rawNonce) => {
  if (!identityToken || typeof identityToken !== 'string') throw new Error('Missing identity token');
  if (!rawNonce || typeof rawNonce !== 'string') throw new Error('Missing nonce');

  const decoded = jwt.decode(identityToken, { complete: true });
  if (!decoded?.header?.kid) throw new Error('Malformed identity token');

  const claims = jwt.verify(identityToken, await keyFor(decoded.header.kid), {
    algorithms: ['RS256'],
    issuer: APPLE_ISSUER,
    audience: allowedClientIds(),
  });

  const expected = Buffer.from(sha256Hex(rawNonce));
  const given = Buffer.from(String(claims.nonce || ''));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new Error('Nonce mismatch');
  }
  if (!claims.sub) throw new Error('Identity token has no subject');

  const truthy = (value) => value === true || value === 'true';
  return {
    sub: String(claims.sub),
    // Which of our apps Apple issued it to — the client id it wants back when revoking.
    clientId: String(claims.aud),
    email: claims.email && truthy(claims.email_verified) ? String(claims.email).toLowerCase() : null,
    emailVerified: truthy(claims.email_verified),
    isPrivateEmail: truthy(claims.is_private_email),
  };
};

/** For tests: replace the key set without the network. */
const setAppleKeysForTesting = (keys) => { keyCache = { keys, fetchedAt: Date.now() }; };

module.exports = { verifyAppleIdentityToken, allowedClientIds, setAppleKeysForTesting, APPLE_ISSUER };

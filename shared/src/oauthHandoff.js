const crypto = require('crypto');
const { cache } = require('./cache');
const { TtlStore } = require('./ttlStore');

/**
 * Handing a Google sign-in back to the native app (Realx8-Mobile).
 *
 * ── Why the app cannot simply receive the tokens ─────────────────────────────
 *
 * Google refuses to sign in inside an embedded WebView, so the app runs the
 * flow in the system browser and is called back on its own URL scheme
 * (realx8://auth/callback). Any other app on an Android phone can register the
 * same scheme, so whatever is in that URL must be worthless to a stranger. The
 * web flow puts the access and refresh tokens in its callback URL; doing the
 * same here would give them to whichever app grabbed the link.
 *
 * ── What happens instead (PKCE, RFC 7636 in miniature) ──────────────────────
 *
 * 1. The app makes a random verifier and sends sha256(verifier) — the
 *    challenge — with /auth/google. It travels in the signed OAuth state.
 * 2. The callback stores the result it would have put in the URL under a
 *    random single-use code, beside the challenge, and sends only the code
 *    to the app's scheme.
 * 3. The app opens /auth/google/handoff?code=…&verifier=… in its own WebView.
 *    The code is redeemed once, only with the verifier that hashes to the
 *    challenge, and the WebView is redirected to the web callback page with
 *    the result — the same page and the same parameters the web flow uses.
 *
 * An app that steals the code has no verifier, and the real app's redemption
 * spends the code, so a stolen one is worthless either way.
 */

const TTL_SECONDS = 120;
const CHALLENGE = /^[0-9a-f]{64}$/;
const local = new TtlStore({ maxEntries: 5_000 });
const keyFor = (code) => `oauth:handoff:${code}`;

/**
 * Where a native sign-in may be sent back to. Exact matches only: a pattern
 * here would be an open redirect for sign-in results.
 */
const allowedNativeRedirects = () => String(process.env.MOBILE_OAUTH_REDIRECTS || 'realx8://auth/callback')
  .split(',').map((entry) => entry.trim()).filter(Boolean);

const isAllowedNativeRedirect = (url) => Boolean(url) && allowedNativeRedirects().includes(String(url));
const isChallenge = (value) => CHALLENGE.test(String(value || ''));

const sha256Hex = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/**
 * Store the callback's result and return the URL to send the browser to.
 *
 * Kept in-process AND in the shared cache (when there is one), so it survives
 * a Redis outage and works with CACHE_ENABLED=false. With several auth-service
 * replicas and no Redis, the redeem can land on a replica that never saw it —
 * the app then shows the sign-in page's "try again" error.
 */
const createHandoff = async ({ nativeRedirect, challenge, params }) => {
  const code = crypto.randomBytes(24).toString('base64url');
  const entry = { challenge, params };
  local.set(keyFor(code), entry, TTL_SECONDS);
  await cache.set(keyFor(code), entry, TTL_SECONDS);
  const url = new URL(nativeRedirect);
  url.searchParams.set('handoff', code);
  return url.toString();
};

/**
 * Redeem a code once. Returns the stored query parameters, or null for an
 * unknown, expired, spent or wrongly-verified code. The code is spent on ANY
 * redemption attempt, so it cannot be guessed at against the verifier.
 */
const redeemHandoff = async (code, verifier) => {
  if (!code || typeof code !== 'string' || code.length > 64) return null;
  const key = keyFor(code);
  const entry = local.get(key) ?? await cache.get(key);
  local.delete(key);
  await cache.del(key);
  if (!entry || !isChallenge(entry.challenge) || !verifier) return null;

  const given = Buffer.from(sha256Hex(verifier));
  const want = Buffer.from(entry.challenge);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  return entry.params;
};

module.exports = {
  createHandoff, redeemHandoff, isAllowedNativeRedirect, isChallenge, allowedNativeRedirects, TTL_SECONDS,
};

const crypto = require('crypto');

/**
 * Carrying the company and realtor codes through a Google round trip.
 *
 * ── Why `state` and not a query parameter ───────────────────────────────────
 *
 * Google redirects to a callback URL registered in advance and hands back
 * nothing that was added to the outbound request. `state` is the one field that
 * survives, and carrying application context is one of the two things it is
 * for — the other being CSRF protection, which the signature below also gives.
 *
 * ── Why it is signed ────────────────────────────────────────────────────────
 *
 * These codes decide which company an account joins and which agent earns
 * commission on everything they buy. Unsigned, anybody could paste a different
 * realtor code into the URL mid-flow and claim somebody else's introduction —
 * which is theft of a commission stream, not a cosmetic problem.
 *
 * The signature makes the state unforgeable without the server's secret, and
 * the timestamp stops one being captured and replayed weeks later.
 */

const MAX_AGE_SECONDS = 15 * 60;

const secret = () => process.env.JWT_SECRET
  || process.env.OAUTH_STATE_SECRET
  // Never a fixed fallback: a predictable secret is the same as no signature.
  // A random one per process means a state cannot outlive a restart, which is
  // an inconvenience rather than a hole.
  || crypto.randomBytes(32).toString('hex');

const PROCESS_SECRET = secret();

const sign = (payload) => crypto
  .createHmac('sha256', PROCESS_SECRET)
  .update(payload)
  .digest('base64url');

/**
 * Pack the codes into a state string.
 *
 * Returns an empty string when there is nothing to carry, so the OAuth request
 * simply has no state rather than an empty envelope.
 */
const buildSignupState = ({ companyCode, realtorCode, redirect } = {}) => {
  const body = {
    c: String(companyCode || '').trim().toUpperCase() || undefined,
    r: String(realtorCode || '').trim().toUpperCase() || undefined,
    // Where to send them afterwards — the property they were looking at.
    d: redirect || undefined,
    t: Math.floor(Date.now() / 1000),
  };
  if (!body.c && !body.r && !body.d) return '';

  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${payload}.${sign(payload)}`;
};

/**
 * Unpack it, refusing anything that has been altered or has gone stale.
 *
 * Never throws and never returns null: a bad state yields empty codes, so a
 * tampered URL degrades to "no attribution" rather than to a failed sign-in.
 * The person still gets their account; they simply are not credited to whoever
 * tried to claim them.
 */
const readSignupState = (state) => {
  const empty = { company_code: null, realtor_code: null, redirect: null };
  if (!state || typeof state !== 'string') return empty;

  const [payload, signature] = state.split('.');
  if (!payload || !signature) return empty;

  /**
   * timingSafeEqual, because comparing signatures with === leaks how much of a
   * guess was right through how long the comparison took. The window is small
   * and the fix is one function call.
   */
  const expected = sign(payload);
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return empty;

  let body;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return empty;
  }

  const age = Math.floor(Date.now() / 1000) - Number(body.t || 0);
  if (!Number.isFinite(age) || age < 0 || age > MAX_AGE_SECONDS) return empty;

  return {
    company_code: body.c || null,
    realtor_code: body.r || null,
    redirect: body.d || null,
  };
};

module.exports = { buildSignupState, readSignupState, MAX_AGE_SECONDS };

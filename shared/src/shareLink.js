const crypto = require('crypto');

/**
 * Sealed share links.
 *
 * A shared property or sign-up URL carries who it came from: the company, and
 * the realtor when a realtor shared it. That used to travel as plain query
 * parameters (?company_code=VG3G4&realtor_code=T25MU), which anyone could read
 * off the URL and edit — pointing a prospect at the wrong company, or
 * re-attributing a referral to themselves.
 *
 * The payload is now sealed with AES-256-GCM. GCM is authenticated, so a token
 * that has been altered by even one character fails to open rather than
 * decoding to something plausible. The result is base64url so it survives being
 * pasted into WhatsApp, SMS and email without escaping.
 *
 * This is not a bearer credential — it grants no access on its own. Everything
 * it carries is still re-validated server-side when an account is created; the
 * seal exists to stop tampering and to keep the link tidy.
 */

const MAGIC = 'v1';
const IV_BYTES = 12;   // GCM standard nonce length
const TAG_BYTES = 16;

/**
 * The link key is deliberately separate from JWT_SECRET where one is provided:
 * these tokens live in URLs pasted into chat apps and inboxes, so they have a
 * far wider blast radius than a session token and should be rotatable on their
 * own. It falls back to the JWT secret so existing deployments keep working
 * without new configuration.
 */
const keyFor = () => {
  const secret = process.env.SHARE_LINK_SECRET
    || process.env.JWT_SECRET
    || 'super-secret-key';
  return crypto.createHash('sha256').update(String(secret)).digest();
};

const b64urlEncode = (buf) => buf.toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b64urlDecode = (str) => {
  const padded = String(str).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
};

/**
 * Seal a payload into a URL-safe token.
 * Returns null rather than throwing — a link panel should degrade to the plain
 * link instead of failing the whole screen.
 */
const sealShareToken = (payload) => {
  try {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(), iv);
    const body = Buffer.concat([
      cipher.update(JSON.stringify({ ...payload, v: MAGIC }), 'utf8'),
      cipher.final(),
    ]);
    return b64urlEncode(Buffer.concat([iv, cipher.getAuthTag(), body]));
  } catch {
    return null;
  }
};

/** Open a sealed token. Returns null if it is missing, altered, or not ours. */
const openShareToken = (token) => {
  if (!token || typeof token !== 'string') return null;
  try {
    const raw = b64urlDecode(token);
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      keyFor(),
      raw.subarray(0, IV_BYTES),
    );
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));

    const plain = Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');

    const parsed = JSON.parse(plain);
    // Reject anything sealed under a different format so a future v2 payload
    // is never half-read by this decoder.
    return parsed && parsed.v === MAGIC ? parsed : null;
  } catch {
    // Wrong key, truncated paste, or a tampered token — all indistinguishable
    // on purpose, and all mean the same thing to the caller.
    return null;
  }
};

module.exports = { sealShareToken, openShareToken };

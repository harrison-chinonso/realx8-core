const crypto = require('crypto');
const { appSecret } = require('./appSecret');

/**
 * AES-256-GCM for API request and response bodies.
 *
 * ── WHAT THIS DOES AND DOES NOT PROTECT ─────────────────────────────────────
 *
 * Read this before treating it as a security control, because the honest
 * summary is narrower than "the payloads are encrypted" sounds:
 *
 *   It is NOT transport confidentiality. HTTPS already provides that, and it
 *   does it properly. If this deployment is served over plain HTTP, this module
 *   is not a substitute — fix the transport.
 *
 *   It does NOT hide anything from the logged-in user. Their browser must be
 *   able to encrypt and decrypt, so it holds the key; anyone willing to open
 *   devtools can read their own traffic. That is inherent to doing crypto in a
 *   page, not a gap here.
 *
 *   What it DOES do is raise the cost of talking to this API with a script, and
 *   keep payloads out of casual view — proxies, browser extensions, screen
 *   shares, and a network tab someone is looking over a shoulder at.
 *
 * The one property worth more than obfuscation: keys are derived PER SESSION
 * from a server-held secret, so a bundle-scraping attacker cannot decrypt
 * ANOTHER user's traffic. A single key shipped in the bundle would give that
 * away, which is why this does not do it for authenticated calls.
 *
 * Authorisation remains the JWT and the permission checks. Turning this off
 * changes what is readable, never who may do what.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;          // 96 bits, the GCM standard
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const INFO = 'realx8-payload-v1';

/** How the middleware behaves. Default OFF, so nothing changes on a restart. */
const MODES = ['off', 'permissive', 'strict'];

const mode = () => {
  const configured = String(process.env.PAYLOAD_ENCRYPTION_MODE || 'off').toLowerCase();
  return MODES.includes(configured) ? configured : 'off';
};

const secret = () => process.env.PAYLOAD_ENCRYPTION_SECRET
  // appSecret() rather than a literal fallback: see shared/src/appSecret.js.
  || appSecret();

/**
 * The key for one session.
 *
 * HKDF over a server-held secret and the session id, so:
 *   - the server needs to store nothing and survives a restart
 *   - each session's key is independent; one leaking tells you nothing about
 *     another
 *   - a key dies with its session, because the id is a JWT claim
 *
 * `sid` null derives the BOOTSTRAP key, the one the UI must know before anyone
 * has logged in — necessarily weaker, because it ships in the bundle. It is
 * used only for the handful of pre-login endpoints.
 */
const deriveKey = (sid) => Buffer.from(
  crypto.hkdfSync('sha256', secret(), Buffer.from(String(sid ?? 'bootstrap')), INFO, KEY_BYTES),
);

/** The bootstrap key as hex, for handing to the UI build. */
const bootstrapKeyHex = () => deriveKey(null).toString('hex');

/** A fresh session id. Not secret — it identifies a session, it does not authorise one. */
const newSessionId = () => crypto.randomBytes(16).toString('hex');

/**
 * Encrypts a JSON-serialisable value.
 *
 * Returns the envelope the wire carries. Everything is base64 in one object
 * rather than a packed binary string so that a failure is legible in a log
 * instead of being a wall of hex.
 */
const encrypt = (value, key) => {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value === undefined ? null : value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64'),
    // The GCM tag is what makes this tamper-evident; without it AES-CTR-style
    // bit-flipping would let a client edit a payload it cannot read.
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  };
};

/**
 * Decrypts an envelope, throwing on anything that is not exactly right.
 *
 * A wrong key, a truncated body or a flipped bit all surface here as the same
 * refusal, which is the correct behaviour: GCM verification failing means the
 * payload is not trustworthy, and there is no partial answer worth returning.
 */
const decrypt = (envelope, key) => {
  if (!envelope || typeof envelope !== 'object') throw new Error('not an encrypted envelope');
  const { iv, tag, data } = envelope;
  if (!iv || !tag || data === undefined) throw new Error('envelope is missing iv, tag or data');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(data, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8'));
};

/** Whether a parsed body looks like something this module produced. */
const isEnvelope = (body) => Boolean(
  body && typeof body === 'object' && !Array.isArray(body)
  && typeof body.iv === 'string' && typeof body.tag === 'string' && typeof body.data === 'string',
);

module.exports = {
  ALGORITHM, IV_BYTES, TAG_BYTES, KEY_BYTES, MODES,
  mode, deriveKey, bootstrapKeyHex, newSessionId,
  encrypt, decrypt, isEnvelope,
};

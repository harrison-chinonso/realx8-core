const crypto = require('crypto');
const { securityConfig } = require('./config');

/**
 * A signed header proving a request came from this application's own UI.
 *
 * ── WHAT THIS CAN AND CANNOT DO ──────────────────────────────────────────────
 *
 * The signature is computed in the browser, so the key has to be IN the
 * browser, which means anyone can read it out of the JavaScript bundle and
 * forge the header. That is not a flaw in the implementation; it is inherent to
 * signing on the client, and it is true of the Java original this is modelled
 * on — whose config object exposes the secret to the frontend by design.
 *
 * So this is OBFUSCATION, not authentication. What it genuinely buys:
 *
 *   - a script hitting the API with no header at all is refused, which stops
 *     the casual case
 *   - the timestamp bounds replay to a short window
 *   - the nonce and per-request signature mean one captured header cannot be
 *     reused for a different method or path
 *
 * What it must never be asked to do: stand in for authorisation. Every endpoint
 * behind it is still gated by the JWT and its permissions, and removing this
 * header changes nothing about who may do what. If it is ever the only thing
 * protecting an endpoint, that endpoint is unprotected.
 */

const SEPARATOR = '|';
const VERSION = 'v1';

const allowed = (reason) => ({ blocked: false, reason });
const blocked = (reason) => ({ blocked: true, reason });

/**
 * The signed payload. Binds the signature to the method and path, so a header
 * captured from a GET cannot authorise a DELETE.
 */
const signaturePayload = ({ appId, timestamp, nonce, method, path }) => [
  appId, String(timestamp), nonce, String(method).toUpperCase(), path,
].join(SEPARATOR);

const sign = (payload, secret, algorithm) => crypto
  .createHmac(algorithm, secret)
  .update(payload)
  .digest('base64');

/** Mints a header. Used by the UI, and by this repo's own test scripts. */
const generateFrontendHeader = ({ method, path, timestamp, nonce } = {}) => {
  const config = securityConfig().frontendHeader;
  if (!config.secret) return null;

  const stamp = timestamp ?? Math.floor(Date.now() / 1000);
  const salt = nonce ?? crypto.randomBytes(16).toString('hex');
  const signature = sign(
    signaturePayload({ appId: config.appId, timestamp: stamp, nonce: salt, method, path }),
    config.secret,
    config.algorithm,
  );

  return [VERSION, config.appId, String(stamp), salt, signature].join(SEPARATOR);
};

const validateFrontendHeader = (req) => {
  const config = securityConfig().frontendHeader;
  if (!config.enabled) return allowed('validation disabled');

  /**
   * No secret configured means the header cannot be verified.
   *
   * Refusing every request would take the API down the moment this ships
   * without the variable set, and pretending to validate would be worse than
   * not validating — so it passes, loudly.
   */
  if (!config.secret) {
    console.warn('[security] SECURITY_FRONTEND_SECRET is unset — frontend header not verified');
    return allowed('no secret configured');
  }

  const headerValue = req.headers[config.headerName];
  if (!headerValue) return blocked(`missing ${config.headerName}`);

  const parts = String(headerValue).split(SEPARATOR);
  if (parts.length !== 5) return blocked('malformed header');

  const [version, appId, timestampRaw, nonce, signature] = parts;
  if (version !== VERSION) return blocked(`unsupported version: ${version}`);
  if (appId !== config.appId) return blocked('unknown application id');

  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp)) return blocked('invalid timestamp');
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (ageSeconds > config.timeoutSeconds) {
    return blocked(`header expired (${ageSeconds}s old, limit ${config.timeoutSeconds}s)`);
  }

  const expected = sign(
    signaturePayload({
      appId: config.appId,
      timestamp,
      nonce,
      method: req.method,
      // The path the signature was computed over, without the /api prefix the
      // edge strips, so the UI and the server agree on one string.
      path: req.securityPath || req.path,
    }),
    config.secret,
    config.algorithm,
  );

  /**
   * Constant-time comparison.
   *
   * A plain === leaks how much of the signature matched through its timing,
   * which is enough to forge one byte at a time. The length check first is
   * because timingSafeEqual throws on a length mismatch.
   */
  const provided = Buffer.from(signature);
  const computed = Buffer.from(expected);
  if (provided.length !== computed.length || !crypto.timingSafeEqual(provided, computed)) {
    return blocked('signature mismatch');
  }

  return allowed('signature valid');
};

module.exports = { generateFrontendHeader, validateFrontendHeader, signaturePayload, VERSION };

const jwt = require('jsonwebtoken');
const {
  mode, deriveKey, encrypt, decrypt, isEnvelope,
} = require('../shared/src/payloadCrypto');
const rateLimit = require('./security/rateLimit');
const { integrationPaths } = require('./security/integrations');

/**
 * Request and response body encryption, as middleware.
 *
 * See shared/src/payloadCrypto.js for what this protects — the short version is
 * that it raises the cost of scripting against this API and keeps payloads out
 * of casual view, and that it is NOT a replacement for HTTPS.
 *
 * ── Rollout ──────────────────────────────────────────────────────────────────
 *
 * PAYLOAD_ENCRYPTION_MODE:
 *
 *   off         (default) nothing happens at all. A restart changes no
 *               behaviour, which is the point of the default.
 *   permissive  encrypted bodies are decrypted and responses are encrypted for
 *               clients that asked for it, but a PLAINTEXT request is still
 *               accepted. This is the mode to deploy in: the UI and the API can
 *               be rolled out in either order, and a cached old bundle keeps
 *               working.
 *   strict      a plaintext body on an eligible route is refused.
 *
 * Going to strict before every client is updated locks out anything still
 * sending plaintext — including the mobile clients and server-to-server callers
 * if any exist. permissive first, then strict once the logs are quiet.
 */

/**
 * Routes that must never be touched.
 *
 * These are not exemptions for convenience; each would BREAK if a body were
 * rewritten:
 *
 *   uploads are multipart — the body is a stream consumed by multer, not JSON,
 *   and there is nothing here to encrypt without buffering whole files
 *
 *   the assistant streams tokens as they generate; encrypting the response
 *   would mean buffering it whole, which defeats streaming
 *
 *   downloads and share links are opened by the BROWSER directly, not by fetch,
 *   so nothing on the page can decrypt them
 */
const NEVER_ENCRYPT = () => [
  '/uploads/**',
  /**
   * A client fetching its own key cannot decrypt the reply with the key it is
   * asking for. Protected by the token and by HTTPS like everything else.
   */
  '/auth/session-key',
  '/health',
  '/assistant/stream/**',
  '/assistant/**/stream',
  '/share/brand/**',
  '/public/**',
  '**/download',
  '**/export',
  /**
   * Integration callbacks speak their own format, not ours.
   *
   * Paystack posts its own JSON and signs the RAW body; encrypting our reply
   * or expecting an envelope from them would break the callback outright.
   * These endpoints are authenticated by the provider's signature instead.
   */
  ...integrationPaths(),
];

/** The header a client sets to say "I sent an envelope and can read one back". */
const CLIENT_HEADER = 'x-payload-encryption';
/** The header the server sets when a response body is an envelope. */
const SERVER_HEADER = 'X-Payload-Encrypted';

/**
 * The session id this request's key comes from.
 *
 * DECODED, not verified — deliberately, and it is not a hole:
 *
 * This middleware makes no trust decision. The sid only SELECTS which key to
 * use, and a forged sid selects a key the forger cannot compute, so their
 * envelope fails GCM verification and their request is refused. Authenticating
 * the token is verifyToken's job and it still happens, after this.
 *
 * Verifying here instead would mean duplicating auth-service's secret
 * resolution (which reads the settings table) into the edge, for no gain.
 */
const sessionIdFor = (req) => {
  const [scheme, token] = String(req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  try {
    return jwt.decode(token)?.sid || null;
  } catch {
    return null;
  }
};

const eligible = (req) => {
  if (req.method === 'OPTIONS') return false;
  const path = req.securityPath || req.path;
  if (rateLimit.matchesAny(path, NEVER_ENCRYPT())) return false;
  // Multipart is caught by content type as well as by path, because an upload
  // route added later should not silently start being mangled.
  const contentType = String(req.headers['content-type'] || '');
  if (contentType.startsWith('multipart/')) return false;
  return true;
};

/**
 * Decrypts the request body and arranges for the response to be encrypted.
 *
 * Mounted AFTER the body parsers — the envelope is itself JSON, so express.json
 * parses it and this reads it out of req.body.
 */
const payloadCrypto = () => (req, res, next) => {
  const active = mode();
  if (active === 'off' || !eligible(req)) return next();

  const clientOptedIn = String(req.headers[CLIENT_HEADER] || '').toLowerCase() === 'on';
  const bodyIsEnvelope = isEnvelope(req.body);

  if (!bodyIsEnvelope && !clientOptedIn) {
    /**
     * A plaintext client.
     *
     * In permissive mode it is served as it always was. In strict mode it is
     * refused — but only when it actually SENT something. A GET has no body to
     * encrypt, so refusing it would break every read for no benefit.
     */
    const hasBody = req.body && Object.keys(req.body).length > 0;
    if (active === 'strict' && hasBody) {
      return res.status(400).json({
        message: 'This endpoint requires an encrypted payload.',
        reason: 'payload_encryption_required',
      });
    }
    return next();
  }

  const key = deriveKey(sessionIdFor(req));

  if (bodyIsEnvelope) {
    try {
      req.body = decrypt(req.body, key);
      req.payloadWasEncrypted = true;
    } catch (error) {
      /**
       * The common cause is a stale key: the UI held a session key, the token
       * was refreshed, and the sid moved on. 400 with a distinct reason so the
       * client can re-fetch its key and retry rather than showing the user a
       * generic failure.
       */
      console.warn(`[payload] could not decrypt — path=${req.securityPath || req.path} `
        + `sid=${sessionIdFor(req) ? 'present' : 'absent'}: ${error.message}`);
      return res.status(400).json({
        message: 'The request payload could not be decrypted. Sign in again if this persists.',
        reason: 'payload_decryption_failed',
      });
    }
  }

  /**
   * Encrypt the response by wrapping res.json.
   *
   * Only res.json: res.send with a Buffer is a file, res.end is a stream, and
   * neither should be rewritten. Anything this application returns as JSON goes
   * through res.json.
   */
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    try {
      res.set(SERVER_HEADER, '1');
      return originalJson(encrypt(body, key));
    } catch (error) {
      /**
       * Send the plaintext rather than failing the request.
       *
       * The work already happened and the client is entitled to the answer; an
       * encryption bug must not turn a successful operation into an error the
       * user sees. It is logged loudly instead, and the missing header tells
       * the client to read it as plaintext.
       */
      console.error('[payload] response encryption failed, sending plaintext:', error.message);
      res.removeHeader(SERVER_HEADER);
      return originalJson(body);
    }
  };

  return next();
};

module.exports = { payloadCrypto, NEVER_ENCRYPT, CLIENT_HEADER, SERVER_HEADER };

const { securityConfig } = require('./config');
const { isAllowedCorsOrigin } = require('../../shared/src/appOrigin');

/**
 * The single authority for cross-origin access.
 *
 * Property-driven, so widening it is a deploy-config change that shows up in a
 * diff rather than an annotation somebody added to one controller. Modelled on
 * the Spring CorsConfig, with the same central rule: nothing may quietly widen
 * the allow-list behind this module's back.
 *
 * ── The credentials rule ─────────────────────────────────────────────────────
 *
 * `Access-Control-Allow-Origin: *` together with
 * `Access-Control-Allow-Credentials: true` is a session-theft primitive: any
 * site the user visits could call this API with their cookies attached. The
 * combination is therefore impossible here — credentials are forced OFF
 * whenever the effective origin list is a bare wildcard, whatever
 * CORS_ALLOW_CREDENTIALS says. That is a refusal, not a preference.
 */

/**
 * Request headers a browser may send.
 *
 * An explicit list rather than `*`, so adding a header the server reads is a
 * deliberate act. `*` would also silently disable credentials in modern
 * browsers, which is a confusing way to discover the rule above.
 */
const DEFAULT_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'Accept',
  'Accept-Language',
  'Origin',
  'X-Requested-With',
  // This application's signed frontend header — see frontendHeader.js.
  'X-Realx8-Auth',
  // Device identity, echoed back by the fingerprint filter.
  'X-Device-Fingerprint',
  'X-Device-Status',
  'X-Request-Id',
  'Idempotency-Key',
];

/** Response headers a browser may read. */
const DEFAULT_EXPOSED_HEADERS = [
  // Without this, a CORS download loses its filename.
  'Content-Disposition',
  'X-Device-Status',
  'X-Device-Fingerprint',
  'X-Request-Id',
  'Retry-After',
  'RateLimit-Limit',
  'RateLimit-Remaining',
  'RateLimit-Reset',
];

/** A pattern entry such as `https://*.vercel.app`, matched against an origin. */
const originMatches = (origin, pattern) => {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return origin === pattern;
  const body = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .split('*').join('[^.]*');
  return new RegExp(`^${body}$`).test(origin);
};

/**
 * The cors() options for this deployment.
 *
 * With CORS_ALLOWED_ORIGINS unset, origin decisions fall back to the shared
 * appOrigin allow-list this backend already used — so locking down is opt-in
 * per environment and nothing breaks the moment this module lands.
 */
const corsOptions = () => {
  const config = securityConfig().cors;
  const configured = config.allowedOrigins;
  const wildcard = configured.includes('*');

  /**
   * Credentials and a wildcard cannot coexist. Announced at startup rather
   * than discovered when a cookie silently stops being sent.
   */
  const allowCredentials = wildcard ? false : config.allowCredentials;
  if (wildcard) {
    console.warn('[security] CORS_ALLOWED_ORIGINS contains "*" — credentials are disabled '
      + 'while that holds. Name the real UI origins to allow credentialed requests.');
  }

  return {
    origin: (origin, callback) => {
      /**
       * A request with NO Origin is not a cross-origin request.
       *
       * Same-origin fetches, server-to-server calls and mobile clients send
       * none, and CORS has nothing to say about them — it is a browser
       * protection, not an access control. Blocking them here would break
       * every non-browser caller while stopping no attack, because anything
       * that can omit the header was never subject to CORS in the first place.
       * Non-browser traffic is handled by the automated-tool filter instead.
       */
      if (!origin) return callback(null, true);

      if (configured.length) {
        if (configured.some((pattern) => originMatches(origin, pattern))) {
          return callback(null, true);
        }
        return callback(new Error(`CORS: origin ${origin} is not allow-listed`));
      }

      // Unconfigured: defer to the allow-list this deployment already had.
      if (isAllowedCorsOrigin(origin)) return callback(null, true);
      return callback(new Error(`CORS: origin ${origin} is not allow-listed`));
    },
    methods: config.allowedMethods,
    allowedHeaders: config.allowedHeaders.length ? config.allowedHeaders : DEFAULT_ALLOWED_HEADERS,
    exposedHeaders: config.exposedHeaders.length ? config.exposedHeaders : DEFAULT_EXPOSED_HEADERS,
    credentials: allowCredentials,
    maxAge: config.maxAge,
    // 204 for preflight: some older browsers choke on a 200 with no body.
    optionsSuccessStatus: 204,
  };
};

module.exports = {
  corsOptions,
  originMatches,
  DEFAULT_ALLOWED_HEADERS,
  DEFAULT_EXPOSED_HEADERS,
};

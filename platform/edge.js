/**
 * The edge: everything that happens to a request before it reaches a service.
 *
 * Lifted out of services/api-gateway so the composed server and the standalone
 * gateway apply byte-identical CORS, rate limiting and session rules. When the
 * backend is one deploy this runs in-process; when it is nine, it runs in the
 * gateway. Neither can drift.
 */

const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { verifyToken, optionalAuth } = require('../shared/src/middleware/auth');
const { corsOptions: buildCorsOptions } = require('./security/cors');
const {
  securityContext, automatedToolFilter, frontendHeaderFilter,
  deviceFingerprintFilter, rateLimitFilter,
} = require('./security/filters');
const { isIntegrationPath } = require('./security/integrations');
const { sessionGuard } = require('./sessionGuard');

/** `/api/users` and `/users` are the same route; the frontend uses the former. */
const normalizePath = (path) => (path.startsWith('/api/') ? path.slice(4) : path);

/**
 * Endpoints that must work WITHOUT a bearer token. Each is guarded by its own
 * credential in auth-service (an OTP, a signed reset token, a 2FA temp token or
 * a refresh token), so the session check here would only ever block the very
 * users these flows exist for.
 */
const PUBLIC_PATHS = [
  '/auth/login',
  /*
   * The second half of a sign-in, for somebody who belongs to more than one
   * company. Public for exactly the reason /auth/login is — the caller has no
   * session yet, because choosing the company is how they get one.
   *
   * It is not unguarded: it carries a signed company_token that names the only
   * accounts the password it was issued for actually opened, and it can reach
   * no other. Behind the session check it would have refused every user it
   * exists for, which is what it did — "Missing bearer token", on the one
   * screen where nobody can have a bearer token.
   */
  '/auth/login/company',
  // Signing in with a 6-digit passcode. Public for the same reason /auth/login
  // is: the caller has no session yet — that is the point of signing in.
  '/auth/passcode/login',
  '/auth/register',
  '/auth/refresh',
  '/auth/logout',              // takes a refreshToken; must work once the access token has expired
  '/auth/forgot-password',
  '/auth/verify-reset-otp',    // middle step of the password reset — the user has no session yet
  '/auth/reset-password',
  '/auth/2fa/verify',
  '/auth/2fa/forced-setup',    // login-time 2FA enrolment, authenticated by temp_token
  '/auth/2fa/forced-verify',
  '/auth/google',
  '/auth/google/callback',
  '/roles',
  '/health',
  '/settings/platform-name',
];

/** Works without auth, but uses the token when present (e.g. company theming). */
const OPTIONAL_AUTH_PATHS = [
  '/settings/appearance',
];

/**
 * CORS now comes from platform/security/cors.js, which is property-driven and
 * refuses the wildcard-plus-credentials combination outright. Kept as a getter
 * so the options are read once at startup, after cred.env has loaded.
 */
const corsOptions = buildCorsOptions();

/**
 * Request-shaping middleware, in order.
 *
 * helmet's crossOriginResourcePolicy is relaxed because /uploads serves images
 * that Realx8-Ui embeds from another origin — the same relaxation
 * user-service applies to its own responses today.
 */
const edgeMiddleware = () => [
  // CORS first: a preflight must be answered before anything can refuse it,
  // or the browser reports a CORS failure for what was really a 403.
  cors(corsOptions),
  helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }),
  morgan('dev'),
  // Establishes req.securityPath and req.clientIp for everything below.
  securityContext(normalizePath),
  /**
   * The pre-auth filters, cheapest first.
   *
   * Both run BEFORE the session check on purpose: a request that is not from
   * this application should be refused without spending a token verification
   * on it, and the reason it is refused should not depend on whether its token
   * happened to be valid.
   *
   * The blanket express-rate-limit that used to sit here is gone. It counted
   * every request against one per-IP bucket, which meant a busy dashboard and
   * a password-guessing script shared a limit — see security/rateLimit.js for
   * the layered replacement, applied after auth so it can count per user too.
   */
  automatedToolFilter(),
  frontendHeaderFilter(),
];

/**
 * The filters that need to know WHO is calling, applied after the auth gate.
 *
 * Device fingerprinting binds a device to a user, and the rate limiter counts
 * per user and per endpoint as well as per IP — neither can do its job before
 * the token has been read.
 */
const postAuthMiddleware = () => [
  deviceFingerprintFilter(),
  rateLimitFilter(),
  /**
   * The one-session rule's request half: keeps the live session from lapsing
   * while it is in use, and refuses a token whose session has been replaced.
   */
  sessionGuard(),
];

/**
 * The session check. Runs once, at the edge, for every prefix — a service is
 * never reachable without having passed through it, in either deployment shape.
 */
const authGate = () => (req, res, next) => {
  const normalizedPath = normalizePath(req.path);

  /**
   * Integration callbacks carry no session, and cannot.
   *
   * A payment provider posting a webhook has no user and no token; requiring
   * one would mean the callback is refused and the payment is never recorded.
   * They authenticate by the provider's own signature INSIDE the handler
   * instead — see security/integrations.js, which states that obligation.
   */
  if (isIntegrationPath(normalizedPath)) return next();
  // /share/brand/:token is public (a prospect resolving a shared link has no
  // account); /share/token, which mints one, stays behind auth.
  if (PUBLIC_PATHS.includes(normalizedPath)
    || normalizedPath.startsWith('/uploads/')
    || normalizedPath.startsWith('/public/')
    || normalizedPath.startsWith('/share/brand/')) {
    return next();
  }
  if (OPTIONAL_AUTH_PATHS.includes(normalizedPath)) {
    return optionalAuth(req, res, next);
  }
  return verifyToken(req, res, next);
};

module.exports = {
  normalizePath,
  corsOptions,
  edgeMiddleware,
  postAuthMiddleware,
  authGate,
  PUBLIC_PATHS,
  OPTIONAL_AUTH_PATHS,
};

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
const rateLimit = require('express-rate-limit');
const { isAllowedCorsOrigin } = require('../shared/src/appOrigin');
const { verifyToken, optionalAuth } = require('../shared/src/middleware/auth');

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

const corsOptions = {
  origin: (origin, callback) => {
    // Requests with no origin (mobile apps, curl, server-to-server) are allowed.
    if (!origin) return callback(null, true);
    // Same allowlist for every deployment shape, so there is one list of known
    // hosts. This stays deliberately looser than the rule for emailed links.
    if (isAllowedCorsOrigin(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
};

/**
 * Request-shaping middleware, in order.
 *
 * helmet's crossOriginResourcePolicy is relaxed because /uploads serves images
 * that Realx8-Ui embeds from another origin — the same relaxation
 * user-service applies to its own responses today.
 */
const edgeMiddleware = () => [
  cors(corsOptions),
  helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }),
  morgan('dev'),
  rateLimit({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
    limit: Number(process.env.RATE_LIMIT_MAX || 500),
  }),
];

/**
 * The session check. Runs once, at the edge, for every prefix — a service is
 * never reachable without having passed through it, in either deployment shape.
 */
const authGate = () => (req, res, next) => {
  const normalizedPath = normalizePath(req.path);
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
  authGate,
  PUBLIC_PATHS,
  OPTIONAL_AUTH_PATHS,
};

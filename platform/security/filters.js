const { securityConfig } = require('./config');
const { clientIp } = require('./clientIp');
const { detectAutomatedTool } = require('./automatedToolDetection');
const { validateFrontendHeader } = require('./frontendHeader');
const { generateFingerprint, registerDevice, isValidDeviceSession } = require('./deviceFingerprint');
const rateLimit = require('./rateLimit');
const { integrationPaths, isIntegrationPath, integrationsSkipRateLimit } = require('./integrations');

/**
 * The request filters, in the order they run.
 *
 * Each mirrors one of the Spring OncePerRequestFilter classes, with the same
 * shape: work out whether to skip, decide, and either refuse with a plain JSON
 * body or continue.
 *
 * ── Two departures from the originals, both deliberate ───────────────────────
 *
 * 1. They do NOT fail open on an internal error. Every one of the Java filters
 *    catches its own exception and then calls `sendBlockedResponse`, which
 *    despite the "fail open" comment above it actually refuses the request —
 *    so a bug in detection became a total outage. Here an unexpected error is
 *    logged and the request CONTINUES, which is what those comments intended.
 *
 * 2. The skip-lists are path patterns, not `uri.contains(...)`. Containment
 *    made an entry like "/bet" exempt every path with those characters in it.
 */

/**
 * Paths every filter skips: preflight, health probes, and static assets.
 *
 * ── The platform's liveness probe belongs here ───────────────────────────────
 *
 * A hosting platform checks the container is alive with a plain HTTP request
 * from its own agent — Render uses Go's HTTP client, which the tool filter
 * correctly identifies as not-a-browser and refused with 403. The consequence
 * is not a blocked attacker: it is the platform concluding a perfectly healthy
 * service is down, and restarting it or failing the deploy.
 *
 * `/` is included because that is the default probe path when none is
 * configured, and it was the one actually being refused in production
 * (`HEAD / 403 ... ua="Go-http-client/1.1"`). Nothing is given away by it —
 * there is no route at `/`, so the probe gets the 404 it is happy with.
 */
const ALWAYS_SKIP = () => [
  '/',
  '/health',
  '/favicon.ico',
  '/uploads/**',
  /**
   * Extra probe paths for this deployment, comma-separated.
   *
   * Platforms differ and some are configured to check an arbitrary path; when
   * that happens the symptom is a service that looks unhealthy for no visible
   * reason, so it is worth being able to fix without a code change.
   */
  ...String(process.env.HEALTH_CHECK_PATHS || '')
    .split(',').map((entry) => entry.trim()).filter(Boolean),
];

/**
 * Additionally skipped by the browser-shaped checks — the tool filter, the
 * frontend header and fingerprinting.
 *
 * These are reached by something that is legitimately not this application's
 * UI in a browser: a prospect opening a shared link before they have an
 * account, and the public property pages a link leads to.
 */
const NON_UI_PATHS = () => [
  '/share/brand/**',
  '/public/**',
  /**
   * Inbound traffic from the services we integrate with — payment webhooks,
   * OAuth redirects, delivery receipts. None of it comes from a browser
   * running our page, so every browser-shaped check would refuse it and a
   * payment confirmation would silently never arrive.
   *
   * See security/integrations.js, including what an exempt endpoint owes in
   * return: it must verify the provider's own signature, because the path is
   * reachable by anyone.
   */
  ...integrationPaths(),
];

const skip = (req, extra = []) => {
  if (req.method === 'OPTIONS') return true;
  const path = req.securityPath || req.path;
  return rateLimit.matchesAny(path, [...ALWAYS_SKIP(), ...extra]);
};

/** One refusal shape, so a client can handle them uniformly. */
const refuse = (res, { status, message, reason, headers = {} }) => {
  res.status(status);
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...headers,
  });
  return res.json({ message, reason });
};

/**
 * Establishes the path the rest of the stack reasons about.
 *
 * `/api/users` and `/users` are the same route, and the signed frontend header
 * is computed over one of them — so the prefix is stripped once, here, and
 * every filter and the HMAC agree on the same string.
 */
const securityContext = (normalizePath) => (req, res, next) => {
  req.securityPath = normalizePath(req.path);
  req.clientIp = clientIp(req);
  next();
};

/** Refuses tools pretending to be browsers. */
const automatedToolFilter = () => (req, res, next) => {
  if (skip(req, NON_UI_PATHS())) return next();
  try {
    const result = detectAutomatedTool(req);
    if (!result.blocked) return next();

    console.warn(`[security] tool blocked — ip=${req.clientIp} path=${req.securityPath} `
      + `ua="${req.headers['user-agent'] || ''}" reason=${result.reason}`);
    return refuse(res, {
      status: 403,
      message: 'This request must come from the Realx8 web application.',
      reason: result.reason,
    });
  } catch (error) {
    // Genuinely fail open — see the note at the top of this file.
    console.error('[security] tool detection errored, allowing request:', error.message);
    return next();
  }
};

/** Refuses requests without a valid signed header from our own UI. */
const frontendHeaderFilter = () => (req, res, next) => {
  if (skip(req, NON_UI_PATHS())) return next();
  try {
    const result = validateFrontendHeader(req);
    if (!result.blocked) return next();

    console.warn(`[security] frontend header rejected — ip=${req.clientIp} `
      + `path=${req.securityPath} reason=${result.reason}`);
    return refuse(res, {
      status: 403,
      message: 'This request must come from the Realx8 web application.',
      reason: result.reason,
    });
  } catch (error) {
    console.error('[security] frontend header validation errored, allowing request:', error.message);
    return next();
  }
};

/**
 * Records which device a request came from.
 *
 * Runs AFTER the auth gate, because it needs to know who the user is to bind a
 * device to them. It does not refuse a request: a new browser is a normal event
 * and there is no approval screen to send anyone to, so an unrecognised device
 * is recorded and flagged on the response rather than turned away.
 */
const deviceFingerprintFilter = () => (req, res, next) => {
  // Integration callers have no device and no user to bind one to; recording a
  // "device" per provider IP would fill the per-user cap with noise.
  if (skip(req, integrationPaths())) return next();
  try {
    const config = securityConfig().devices;
    if (!config.enabled) return next();

    const fingerprint = generateFingerprint(req);
    req.deviceFingerprint = fingerprint;
    res.set('X-Device-Fingerprint', fingerprint);

    const userId = req.user?.id;
    if (!userId) return next();

    if (isValidDeviceSession(userId, fingerprint)) {
      res.set('X-Device-Status', 'KNOWN');
      return next();
    }

    const registration = registerDevice(userId, fingerprint, req);
    res.set('X-Device-Status', registration.requiresApproval ? 'REQUIRES_APPROVAL' : 'TRUSTED');
    if (registration.requiresApproval) {
      console.warn(`[security] device needs review — user=${userId} `
        + `fingerprint=${fingerprint} reason=${registration.reason}`);
    }
    return next();
  } catch (error) {
    console.error('[security] device fingerprinting errored, allowing request:', error.message);
    return next();
  }
};

/**
 * The layered rate limiter.
 *
 * Also runs after the auth gate, so the per-user and per-endpoint counters have
 * a user. The per-IP and login counters do not need one and apply regardless.
 */
const rateLimitFilter = () => (req, res, next) => {
  if (skip(req)) return next();
  /**
   * Integration callbacks keep their rate limit by DEFAULT.
   *
   * A provider retrying a webhook is bursty and legitimate, but an exempt path
   * is open to anyone, so the limit is the only thing bounding an abusive
   * caller. Providers call from a small stable set of addresses and the limit
   * is per IP, so this is rarely the thing that needs relaxing — but
   * INTEGRATION_EXEMPT_RATE_LIMIT=true is there when it is.
   */
  if (integrationsSkipRateLimit() && isIntegrationPath(req.securityPath || req.path)) return next();
  try {
    const verdict = rateLimit.check({
      path: req.securityPath,
      ip: req.clientIp,
      userId: req.user?.id ?? null,
    });
    if (!verdict) return next();

    console.warn(`[security] rate limited — ip=${req.clientIp} path=${req.securityPath} `
      + `scope="${verdict.scope}" count=${verdict.count}/${verdict.limit}`);
    return refuse(res, {
      status: 429,
      message: `Too many ${verdict.scope}. Try again in ${verdict.retryAfterSeconds} seconds.`,
      reason: 'rate_limited',
      headers: {
        'Retry-After': String(verdict.retryAfterSeconds),
        'RateLimit-Limit': String(verdict.limit ?? ''),
        'RateLimit-Remaining': '0',
        'RateLimit-Reset': String(verdict.retryAfterSeconds),
      },
    });
  } catch (error) {
    console.error('[security] rate limiting errored, allowing request:', error.message);
    return next();
  }
};

module.exports = {
  securityContext,
  automatedToolFilter,
  frontendHeaderFilter,
  deviceFingerprintFilter,
  rateLimitFilter,
  ALWAYS_SKIP,
  NON_UI_PATHS,
};

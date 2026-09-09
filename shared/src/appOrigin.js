/**
 * Where the web app is actually being used, for links inside outgoing email.
 *
 * The base URL is taken from the browser that triggered the action (its Origin
 * header) rather than a hardcoded env value, so a link in an email always
 * points back at the host the user is really on — localhost, a rotating
 * cloudflare tunnel, or the production domain — with no redeploy.
 *
 * Trusting a client-supplied header to build a link that is then EMAILED to a
 * third party is the whole risk here: spoof the header on a public endpoint
 * (registration is public) and the app would mail a realtor a link to your
 * site. So an origin is only used if it clears isTrustedOrigin() below.
 */

const isProduction = () => process.env.NODE_ENV === 'production';

/** Exact origins named by config — always trusted. */
const configuredOrigins = () => (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/**
 * Preview/tunnel hosts used while developing. These wildcards are fine for
 * CORS, but ANYONE can register a name under them, so they are not a basis for
 * a link we put in someone's inbox. Outside production they keep the tunnel
 * workflow working; in production only configured origins count.
 */
const PREVIEW_HOST_PATTERNS = [
  /^https?:\/\/[a-z0-9-]+\.trycloudflare\.com$/,
  /^https?:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(cloudflareaccess\.com|pages\.dev|workers\.dev)$/,
  /^https?:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app$/,
];

/** Local dev servers. Never a CORS concern — only ever a link-base in dev. */
const LOCAL_HOST_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
];

/** Whether an origin may be used as the base for an emailed link. */
const isTrustedOrigin = (origin) => {
  if (!origin || typeof origin !== 'string') return false;

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  // Reject anything that is not plain web traffic (javascript:, data:, ...).
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  // Compare the normalised origin so "https://x.test/" and trailing junk match.
  const normalised = parsed.origin;
  if (configuredOrigins().includes(normalised)) return true;
  if (!isProduction() && [...PREVIEW_HOST_PATTERNS, ...LOCAL_HOST_PATTERNS].some((re) => re.test(normalised))) return true;
  return false;
};

/**
 * The app origin behind a request, or null when there is nothing trustworthy.
 *
 * Origin is set by the browser on the cross-origin calls this API receives.
 * Referer is a fallback for the rare same-origin request that omits Origin.
 */
const originFromRequest = (req) => {
  if (!req || typeof req.get !== 'function') return null;

  const origin = req.get('origin');
  if (isTrustedOrigin(origin)) return new URL(origin).origin;

  const referer = req.get('referer');
  if (referer) {
    try {
      const candidate = new URL(referer).origin;
      if (isTrustedOrigin(candidate)) return candidate;
    } catch {
      // Malformed Referer — ignore it.
    }
  }
  return null;
};

/**
 * Absolute link into the web app.
 *
 * Prefers the origin of the request that triggered this action; falls back to
 * FRONTEND_URL for anything with no browser behind it (jobs, scripts). Returns
 * null when neither is available, and callers pass that straight through as
 * actionUrl — which drops the button rather than emailing a broken link.
 */
const appUrl = (path = '', req = null) => {
  const base = originFromRequest(req) || String(process.env.FRONTEND_URL || '').replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/${String(path).replace(/^\/+/, '')}`;
};

/**
 * Whether an origin may call the API (CORS).
 *
 * Deliberately more permissive than isTrustedOrigin: a preview host being
 * allowed to CALL the API is not the same as it being allowed to appear as a
 * link in someone's inbox. Loosening this would widen who can talk to the API;
 * tightening it would break the Vercel/tunnel deployments that rely on it.
 */
const isAllowedCorsOrigin = (origin) => {
  if (!origin) return true; // curl, server-to-server, mobile apps
  if (configuredOrigins().includes(origin)) return true;
  // Preview hosts only — localhost reaches the API via CORS_ORIGIN, exactly as
  // it did before this list was shared.
  return PREVIEW_HOST_PATTERNS.some((re) => re.test(origin));
};

module.exports = { appUrl, originFromRequest, isTrustedOrigin, isAllowedCorsOrigin };

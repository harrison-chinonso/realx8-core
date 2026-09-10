/**
 * One place to read the security switches, so every filter agrees about what is
 * on and nothing is decided twice from a differently-spelled env var.
 *
 * Everything is env-driven and every default is stated here rather than at each
 * use, so `npm run security:config` can print the effective posture.
 */

const csv = (value, fallback = '') => String(value ?? fallback)
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
};

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * User-Agent fragments that identify a tool rather than a browser.
 *
 * Matched case-insensitively as substrings, so `curl` catches `curl/8.4.0`.
 */
const DEFAULT_TOOL_AGENTS = [
  'postmanruntime', 'insomnia', 'curl', 'wget', 'python-requests', 'httpie',
  'axios/', 'node-fetch', 'undici', 'go-http-client', 'java/', 'okhttp',
  'apache-httpclient', 'libwww-perl', 'restsharp', 'paw/', 'thunder client',
  'bruno', 'scrapy', 'phantomjs', 'headlesschrome', 'puppeteer', 'playwright',
  'selenium', 'httrack', 'nikto', 'sqlmap', 'nmap', 'masscan', 'zgrab',
];

/** Headers that only a tool sends. Presence alone is decisive. */
const DEFAULT_TOOL_HEADERS = [
  'postman-token', 'x-postman-id', 'x-postman-session-id',
  'x-insomnia-request-id', 'x-curl-version', 'x-thunder-client',
];

/** Proxy-ish headers; several at once is a signal, one is not. */
const DEFAULT_SUSPICIOUS_HEADERS = [
  'via', 'forwarded', 'x-forwarded-host', 'x-forwarded-server',
  'x-proxy-id', 'proxy-connection', 'x-anonymous',
];

const securityConfig = () => ({
  // ── CORS ────────────────────────────────────────────────────────────────
  cors: {
    // Empty means "fall back to the shared appOrigin allow-list", which is what
    // this deployment already used. A bare '*' is honoured but forces
    // credentials off — see cors.js.
    allowedOrigins: csv(process.env.CORS_ALLOWED_ORIGINS || process.env.CORS_ORIGIN),
    allowedMethods: csv(process.env.CORS_ALLOWED_METHODS, 'GET,POST,PUT,PATCH,DELETE,OPTIONS'),
    allowedHeaders: csv(process.env.CORS_ALLOWED_HEADERS),
    exposedHeaders: csv(process.env.CORS_EXPOSED_HEADERS),
    allowCredentials: bool(process.env.CORS_ALLOW_CREDENTIALS, true),
    maxAge: num(process.env.CORS_MAX_AGE, 3600),
  },

  // ── automated tool detection ────────────────────────────────────────────
  automatedTools: {
    enabled: bool(process.env.SECURITY_BLOCK_TOOLS_ENABLED, true),
    /**
     * Strict mode additionally requires the request to LOOK like a browser —
     * a recognised User-Agent plus Accept, Accept-Language and Accept-Encoding.
     * It is the difference between "no known tool" and "a real browser", and it
     * is what stops a tool simply removing its User-Agent to get through.
     */
    strict: bool(process.env.SECURITY_BLOCK_TOOLS_STRICT, true),
    whitelistIps: csv(process.env.SECURITY_BLOCK_TOOLS_WHITELIST),
    toolAgents: csv(process.env.SECURITY_BLOCK_TOOLS_USER_AGENTS).length
      ? csv(process.env.SECURITY_BLOCK_TOOLS_USER_AGENTS)
      : DEFAULT_TOOL_AGENTS,
    toolHeaders: DEFAULT_TOOL_HEADERS,
    suspiciousHeaders: DEFAULT_SUSPICIOUS_HEADERS,
  },

  // ── device fingerprinting ───────────────────────────────────────────────
  devices: {
    enabled: bool(process.env.SECURITY_DEVICE_FINGERPRINT_ENABLED, true),
    sessionTimeoutSeconds: num(process.env.SECURITY_DEVICE_SESSION_TIMEOUT, 24 * 60 * 60),
    /**
     * Whether a device nobody has seen before is trusted on sight.
     *
     * True by default, and deliberately: this system has no device-approval
     * screen, so trusting nothing would lock every user out of every new
     * browser with no way back in. What fingerprinting buys here is the record
     * and the per-user device cap, not a second factor.
     */
    trustNewDevices: bool(process.env.SECURITY_DEVICE_TRUST_NEW, true),
    maxDevicesPerUser: num(process.env.SECURITY_DEVICE_MAX_PER_USER, 10),
  },

  // ── frontend header (HMAC) ──────────────────────────────────────────────
  frontendHeader: {
    enabled: bool(process.env.SECURITY_FRONTEND_HEADER_ENABLED, true),
    headerName: (process.env.SECURITY_FRONTEND_HEADER_NAME || 'x-realx8-auth').toLowerCase(),
    appId: process.env.SECURITY_FRONTEND_APP_ID || 'realx8-ui',
    secret: process.env.SECURITY_FRONTEND_SECRET || '',
    timeoutSeconds: num(process.env.SECURITY_FRONTEND_HEADER_TIMEOUT, 300),
    algorithm: process.env.SECURITY_FRONTEND_HEADER_ALGORITHM || 'sha256',
  },

  // ── rate limiting ───────────────────────────────────────────────────────
  rateLimit: {
    enabled: bool(process.env.SECURITY_RATE_LIMIT_ENABLED, true),
    // Requests per minute.
    ipDefault: num(process.env.SECURITY_RATE_LIMIT_IP, 300),
    ipLogin: num(process.env.SECURITY_RATE_LIMIT_IP_LOGIN, 10),
    userDefault: num(process.env.SECURITY_RATE_LIMIT_USER, 240),
    userPayment: num(process.env.SECURITY_RATE_LIMIT_USER_PAYMENT, 20),
    endpointDefault: num(process.env.SECURITY_RATE_LIMIT_ENDPOINT, 120),
    /**
     * What to do when the limiter itself errors.
     *
     * Fail OPEN: a bug in the counter must not take the API down. The counters
     * are in-process and cannot fail on a network, so this is a guard against
     * programming errors rather than infrastructure.
     */
    failOpen: bool(process.env.SECURITY_RATE_LIMIT_FAIL_OPEN, true),
  },
});

module.exports = { securityConfig, csv, bool, num, DEFAULT_TOOL_AGENTS };

/**
 * Prints the effective security posture, the way this process will actually
 * behave once it starts.
 *
 * The switches in platform/security are spread across a dozen environment
 * variables, most of which have a default that applies when they are unset. So
 * "what is turned on here" cannot be answered by reading cred.env — an absent
 * line usually means ON, and the failure it causes (every request refused with
 * 403, or nothing verified at all) looks nothing like a configuration mistake
 * from the outside.
 *
 * This reads the SAME securityConfig() the filters read, so what it prints is
 * what will happen rather than a second description of it that can drift.
 *
 * Run it wherever you are about to deploy:  npm run security:config
 */
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

/**
 * What the cache is configured to do, read BEFORE anything below can change it.
 *
 * The session rule lives in shared/src/sessionRegistry, and requiring that
 * pulls in the cache, which opens a Redis connection as a side effect of being
 * loaded. A report must not do that: it would announce the connection in the
 * middle of the output and then hold the process open after the last line.
 *
 * So the real values are captured here and the cache is switched off for the
 * lifetime of this script only. Nothing else reads CACHE_ENABLED — the session
 * settings below come from their own variables — so the report is unaffected.
 */
const cacheEnabled = String(process.env.CACHE_ENABLED ?? 'true').toLowerCase() !== 'false';
const redisUrl = process.env.REDIS_URL;
process.env.CACHE_ENABLED = 'false';

const { securityConfig } = require('../platform/security/config');
const { trustProxy } = require('../platform/security/clientIp');
const { integrationPaths, integrationsSkipRateLimit } = require('../platform/security/integrations');
const { mode: payloadMode } = require('../shared/src/payloadCrypto');
const sessionRegistry = require('../shared/src/sessionRegistry');

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const OFF = '\x1b[0m';

/** Collected as we go, printed at the end where they cannot be scrolled past. */
const warnings = [];
const warn = (headline, consequence) => warnings.push({ headline, consequence });

const heading = (title) => {
  const rule = '─'.repeat(Math.max(0, 62 - title.length));
  console.log(`\n${BOLD}── ${title} ${rule}${OFF}`);
};

const onOff = (value) => (value ? `${GREEN}on${OFF}` : `${DIM}off${OFF}`);
const row = (label, value, note = '') => {
  console.log(`  ${label.padEnd(30)}${value}${note ? `\n  ${' '.repeat(30)}${DIM}${note}${OFF}` : ''}`);
};

const config = securityConfig();

console.log(`\n${BOLD}Realx8 security posture${OFF}`);
console.log(`${DIM}from cred.env and the defaults in platform/security/config.js${OFF}`);

// ── Client IP ────────────────────────────────────────────────────────────────
heading('Client IP');
row('TRUST_PROXY', onOff(trustProxy()),
  trustProxy()
    ? 'X-Forwarded-For is believed — correct ONLY behind a proxy that rewrites it'
    : 'X-Forwarded-For is ignored; the socket address is used');

if (trustProxy()) {
  warn('TRUST_PROXY is on',
    'If this process is NOT actually behind a proxy that overwrites X-Forwarded-For, '
    + 'any caller can choose their own rate-limit bucket and step around the '
    + 'tool-detection IP allow-list by adding a header.');
}

// ── CORS ─────────────────────────────────────────────────────────────────────
heading('CORS');
const origins = config.cors.allowedOrigins;
const wildcard = origins.includes('*');
row('Allowed origins', origins.length ? origins.join(', ') : `${DIM}(shared appOrigin list)${OFF}`,
  origins.length ? '' : 'CORS_ALLOWED_ORIGINS is unset, so shared/src/appOrigin.js decides');
row('Credentials', onOff(config.cors.allowCredentials && !wildcard),
  wildcard && config.cors.allowCredentials
    ? 'forced off: wildcard origin and credentials cannot be combined'
    : '');
row('Max age', `${config.cors.maxAge}s`);

if (wildcard) {
  warn('CORS allows any origin ("*")',
    'Credentials are forced off, so the UI cannot send its session — a wildcard '
    + 'is almost never what a browser app wants. Name the UI origins instead.');
}

// ── Automated tool detection ─────────────────────────────────────────────────
heading('Automated tool detection');
row('Enabled', onOff(config.automatedTools.enabled));
row('Strict (browser-shaped)', onOff(config.automatedTools.strict),
  config.automatedTools.strict
    ? 'a recognised User-Agent plus Accept, Accept-Language and Accept-Encoding are required'
    : 'named tools and tool headers are still blocked');
row('Known tool agents', `${config.automatedTools.toolAgents.length} pattern(s)`);
row('IP allow-list', config.automatedTools.whitelistIps.length
  ? config.automatedTools.whitelistIps.join(', ')
  : `${DIM}(empty)${OFF}`);

if (config.automatedTools.enabled && config.automatedTools.strict) {
  warn('Tool blocking is strict',
    'curl, Postman, mobile apps and server-to-server callers are refused with 403 '
    + 'on every non-integration route. Add their IPs to '
    + 'SECURITY_BLOCK_TOOLS_WHITELIST rather than turning this off.');
}

// ── Frontend header ──────────────────────────────────────────────────────────
heading('Frontend request signature');
const fh = config.frontendHeader;
const verifying = fh.enabled && Boolean(fh.secret);
row('Enabled', onOff(fh.enabled));
row('Actually verifying', verifying ? `${GREEN}yes${OFF}` : `${RED}no${OFF}`,
  verifying ? '' : 'no secret configured — the header is accepted unchecked');
row('Header name', fh.headerName);
row('App id', fh.appId, 'must equal the UI\'s VITE_FRONTEND_APP_ID');
row('Secret', fh.secret ? `${DIM}set (${fh.secret.length} chars)${OFF}` : `${RED}unset${OFF}`);
row('Freshness window', `${fh.timeoutSeconds}s`);

if (fh.enabled && !fh.secret) {
  warn('SECURITY_FRONTEND_SECRET is unset',
    'The filter is enabled but verifies nothing, so this protection is not in '
    + 'effect. Set it here and to the same value as the UI\'s VITE_FRONTEND_SECRET.');
}
if (verifying) {
  warn('The signature must match the UI exactly',
    `Realx8-Ui must send app id "${fh.appId}" signed with the same secret, or EVERY `
    + 'request is refused with 403. Mismatch here looks like a total outage.');
}

// ── Device fingerprinting ────────────────────────────────────────────────────
heading('Device fingerprinting');
row('Enabled', onOff(config.devices.enabled));
row('Trust new devices', onOff(config.devices.trustNewDevices),
  config.devices.trustNewDevices
    ? 'an unseen device is recorded and allowed — there is no approval screen'
    : '');
row('Max devices per user', String(config.devices.maxDevicesPerUser));
row('Device session timeout', `${config.devices.sessionTimeoutSeconds}s`);

if (config.devices.enabled && !config.devices.trustNewDevices) {
  warn('SECURITY_DEVICE_TRUST_NEW is off',
    'This product has no device-approval flow, so a user on a new browser has no '
    + 'way to get in. Leave it on unless an approval path exists.');
}

// ── Rate limiting ────────────────────────────────────────────────────────────
heading('Rate limiting (per minute)');
row('Enabled', onOff(config.rateLimit.enabled));
row('Per IP', String(config.rateLimit.ipDefault));
row('Per IP, login', String(config.rateLimit.ipLogin), 'the password-guessing bound');
row('Per user', String(config.rateLimit.userDefault));
row('Per user, payment', String(config.rateLimit.userPayment));
row('Per endpoint', String(config.rateLimit.endpointDefault));
row('On limiter error', config.rateLimit.failOpen ? 'allow' : 'refuse');

warn('Rate-limit counters are in-process',
  'With N instances behind a load balancer the effective limits are roughly N x '
  + 'these numbers, because each process counts on its own.');

// ── Integration callbacks ────────────────────────────────────────────────────
heading('Integration callbacks');
const paths = integrationPaths();
row('Exempt paths', `${paths.length} pattern(s)`);
paths.forEach((p) => console.log(`  ${' '.repeat(30)}${DIM}${p}${OFF}`));
row('Rate limited', onOff(!integrationsSkipRateLimit()),
  integrationsSkipRateLimit()
    ? 'exempt from the limit as well — nothing bounds an abusive caller'
    : 'the limit still applies, which is the only bound on an open path');

if (integrationsSkipRateLimit()) {
  warn('INTEGRATION_EXEMPT_RATE_LIMIT is on',
    'Exempt paths are reachable by anyone. Without a rate limit there is nothing '
    + 'bounding a caller who has found one.');
}
warn('Exempt does not mean trusted',
  'Each exempt endpoint must verify the provider\'s own signature '
  + '(x-paystack-signature, verif-hash, stripe-signature) itself. Until it does, '
  + 'the URL is unauthenticated and writable by the public.');

// ── Payload encryption ───────────────────────────────────────────────────────
heading('Payload encryption');
const pMode = payloadMode();
row('Mode', pMode === 'off' ? `${DIM}off${OFF}` : `${GREEN}${pMode}${OFF}`,
  {
    off: 'inert — bodies are plain JSON',
    permissive: 'encrypted and plaintext bodies both accepted (the rollout mode)',
    strict: 'a plaintext body on a non-exempt route is refused',
  }[pMode] || '');
row('Secret', process.env.PAYLOAD_ENCRYPTION_SECRET
  ? `${DIM}set${OFF}`
  : `${YELLOW}falling back to JWT_SECRET${OFF}`);

if (pMode === 'strict') {
  warn('Payload encryption is strict',
    'Any client still sending plaintext is locked out. Confirm the logs show no '
    + 'plaintext callers before leaving it here; permissive is the safe rollout mode.');
}
if (pMode !== 'off' && !process.env.PAYLOAD_ENCRYPTION_SECRET) {
  warn('PAYLOAD_ENCRYPTION_SECRET is unset',
    'Keys derive from JWT_SECRET, so rotating the JWT secret silently re-keys every '
    + 'payload at the same moment. Separate them in production.');
}

// ── Single session ───────────────────────────────────────────────────────────
heading('One session per user');
row('Enabled', onOff(sessionRegistry.isEnabled()));
row('Inactivity window', `${Math.round(sessionRegistry.inactivitySeconds() / 60)} min`,
  'also the wait before a user who closed the browser can sign in again');
row('Registry', redisUrl ? 'Redis' : `${YELLOW}in-process${OFF}`,
  redisUrl ? '' : 'each instance keeps its own, so the rule is per-instance');

if (sessionRegistry.isEnabled() && !redisUrl) {
  warn('Single session without Redis',
    'The registry is in-process, so with more than one instance a user can hold '
    + 'one session per instance and the rule does not hold.');
}

// ── Cache ────────────────────────────────────────────────────────────────────
heading('Cache');
row('Enabled', onOff(cacheEnabled));
row('Backend', redisUrl ? `Redis ${DIM}(${redisUrl})${OFF}` : `${YELLOW}in-process${OFF}`);
row('Key prefix', process.env.CACHE_PREFIX || 'realx8');

if (cacheEnabled && !redisUrl) {
  warn('Caching without Redis',
    'Each instance caches on its own, so an eviction on one is invisible to the '
    + 'others until the TTL lapses. Fine on a single instance; check it before scaling out.');
}

// ── What to look at ──────────────────────────────────────────────────────────
console.log(`\n${BOLD}── Worth checking ${'─'.repeat(46)}${OFF}\n`);
if (!warnings.length) {
  console.log(`  ${GREEN}Nothing flagged.${OFF}\n`);
} else {
  warnings.forEach(({ headline, consequence }, index) => {
    console.log(`  ${YELLOW}${index + 1}.${OFF} ${BOLD}${headline}${OFF}`);
    console.log(`     ${consequence.replace(/(.{1,72})(\s|$)/g, '$1\n     ').trimEnd()}\n`);
  });
}

console.log(`${DIM}  These are observations about the posture, not errors — several are the`);
console.log(`  intended setting. Verify the whole layer end to end with: npm run verify:security${OFF}\n`);

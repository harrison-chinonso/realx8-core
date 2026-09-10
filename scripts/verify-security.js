/**
 * The security layer, against a RUNNING server: only this application's UI
 * gets through, and the things that legitimately are not the UI still do.
 *
 * Start the API first (npm run dev), then: npm run verify:security
 * Point it elsewhere with VERIFY_BASE_URL.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const BASE = process.env.VERIFY_BASE_URL
  || `http://localhost:${process.env.PORT || 3000}/api`;
const { generateFrontendHeader } = require('../platform/security/frontendHeader');

const ORIGIN = 'http://localhost:5173';

/** The headers a real browser sends. */
const browserHeaders = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  Origin: ORIGIN,
  'Content-Type': 'application/json',
};

/** A request shaped exactly like one from the UI, signature included. */
const asUi = async (method, path, body) => {
  const signature = generateFrontendHeader({ method, path });
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...browserHeaders,
      'X-Realx8-Auth': signature,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null; try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
};

/** Whatever headers you give it, and nothing else. */
const raw = async (method, path, headers = {}, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null; try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json, headers: res.headers };
};

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits out a login rate-limit left over from a PREVIOUS run.
 *
 * This script deliberately exhausts the login limiter to prove it works, so
 * running it twice inside a minute would otherwise fail its own first check —
 * reporting a broken API when the limiter is simply doing its job.
 */
const waitOutLoginCooldown = async () => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const probe = await asUi('POST', '/auth/login', { identifier: 'cooldown-probe@example.com', password: 'x' });
    if (probe.status !== 429) return;
    const seconds = Number(probe.body?.message?.match(/(\d+) seconds/)?.[1]) || 20;
    console.log(`  (login limiter still cooling down from a previous run — waiting ${seconds + 2}s)`);
    await sleep((seconds + 2) * 1000);
  }
};

(async () => {
  await waitOutLoginCooldown();

  console.log('\n── The UI gets through ──────────────────────────────────────────');

  const ui = await asUi('POST', '/auth/login', { identifier: 'nobody@example.com', password: 'x' });
  check('A browser-shaped, signed request reaches the API',
    ui.status === 401 && /invalid credentials/i.test(ui.body?.message || ''),
    `${ui.status}: ${ui.body?.message} — reached the handler, which rejected the credentials`);

  console.log('\n── Automated tools are refused ──────────────────────────────────');

  const noUa = await raw('POST', '/auth/login', {}, { identifier: 'a', password: 'b' });
  check('No User-Agent is refused',
    noUa.status === 403, `${noUa.status}: ${noUa.body?.reason}`);

  const curl = await raw('POST', '/auth/login', { 'User-Agent': 'curl/8.4.0' }, { identifier: 'a', password: 'b' });
  check('curl is refused', curl.status === 403, `${curl.status}: ${curl.body?.reason}`);

  const postman = await raw('POST', '/auth/login', {
    'User-Agent': 'PostmanRuntime/7.36.0', 'Postman-Token': 'abc-123',
  }, { identifier: 'a', password: 'b' });
  check('Postman is refused by its own header',
    postman.status === 403 && /postman/i.test(postman.body?.reason || ''),
    `${postman.status}: ${postman.body?.reason}`);

  const fakedUa = await raw('POST', '/auth/login', {
    'User-Agent': browserHeaders['User-Agent'],
  }, { identifier: 'a', password: 'b' });
  check('A faked browser User-Agent without browser headers is refused',
    fakedUa.status === 403, `${fakedUa.status}: ${fakedUa.body?.reason}`);

  console.log('\n── The signed header is required ────────────────────────────────');

  const unsigned = await raw('POST', '/auth/login', browserHeaders, { identifier: 'a', password: 'b' });
  check('A perfect browser impersonation without the signature is refused',
    unsigned.status === 403 && /missing/i.test(unsigned.body?.reason || ''),
    `${unsigned.status}: ${unsigned.body?.reason}`);

  const wrongSig = await raw('POST', '/auth/login', {
    ...browserHeaders, 'X-Realx8-Auth': 'v1|realx8-ui|9999999999|deadbeef|bm90LWEtc2lnbmF0dXJl',
  }, { identifier: 'a', password: 'b' });
  check('A forged signature is refused',
    wrongSig.status === 403, `${wrongSig.status}: ${wrongSig.body?.reason}`);

  // A signature minted for one path must not authorise another.
  const crossPath = await fetch(`${BASE}/invoices`, {
    method: 'GET',
    headers: { ...browserHeaders, 'X-Realx8-Auth': generateFrontendHeader({ method: 'POST', path: '/auth/login' }) },
  });
  check('A signature minted for a different path is refused',
    crossPath.status === 403, `${crossPath.status}`);

  console.log('\n── Public paths stay reachable ──────────────────────────────────');

  // A prospect opening a shared link is not our UI and has no signature.
  const shared = await raw('GET', '/share/brand/not-a-real-token', { 'User-Agent': 'curl/8.4.0' });
  check('A shared brand link works without a browser or a signature',
    shared.status !== 403, `${shared.status} — not blocked by the UI-only filters`);

  const health = await raw('GET', '/health', {});
  check('Health checks work with no headers at all',
    health.status !== 403, `${health.status}`);

  console.log('\n── Rate limiting ────────────────────────────────────────────────');

  let limited = null;
  for (let i = 0; i < 14; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const attempt = await asUi('POST', '/auth/login', { identifier: 'nobody@example.com', password: 'x' });
    if (attempt.status === 429) { limited = { attempt: i + 1, ...attempt }; break; }
  }
  check('Repeated login attempts are rate limited',
    Boolean(limited), limited ? `429 on attempt ${limited.attempt}: ${limited.body?.message}` : 'never limited');

  console.log('\n── Integration callbacks get through ────────────────────────────');

  /**
   * A payment webhook looks exactly like what the tool filter exists to refuse:
   * a server User-Agent, no browser headers, no signed header, no session. It
   * must still reach the application, or payment confirmations are silently
   * dropped and an invoice is never marked paid.
   */
  const webhookHeaders = {
    'User-Agent': 'PaystackWebhook/1.0',
    'x-paystack-signature': 'deadbeef',
  };
  const webhook = await raw('POST', '/webhooks/paystack', webhookHeaders, { event: 'charge.success' });
  check('A payment webhook is not refused by the browser-shaped filters',
    webhook.status !== 403,
    `${webhook.status} — 404 only means no webhook route is defined yet; 403 would mean blocked`);

  const oauth = await raw('GET', '/auth/google/callback', { 'User-Agent': 'curl/8.4.0' });
  check('An OAuth callback is not refused', oauth.status !== 403, `${oauth.status}`);

  const notExempt = await raw('POST', '/invoices', webhookHeaders, {});
  check('The SAME script-shaped request to a normal route is still refused',
    notExempt.status === 403,
    `${notExempt.status} — the exemption is scoped to integration paths, not widened for everyone`);

  console.log('\n── CORS ─────────────────────────────────────────────────────────');

  const preflight = await fetch(`${BASE}/auth/login`, {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,x-realx8-auth',
    },
  });
  check('Preflight from the UI origin is allowed, and is not blocked by the filters',
    preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === ORIGIN,
    `${preflight.status} allow-origin=${preflight.headers.get('access-control-allow-origin')} `
      + `allow-credentials=${preflight.headers.get('access-control-allow-credentials')}`);

  const foreign = await fetch(`${BASE}/auth/login`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'POST' },
  });
  check('Preflight from an unlisted origin gets no allow-origin header',
    !foreign.headers.get('access-control-allow-origin'),
    `allow-origin=${foreign.headers.get('access-control-allow-origin') || 'absent'}`);

  console.log(`\n  ${pass}/${pass + fail} passed.\n`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error('ABORTED:', error.message); process.exit(1); });

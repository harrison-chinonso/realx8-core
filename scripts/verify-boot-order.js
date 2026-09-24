/**
 * The port opens before the migrations, and nothing is served until after.
 *
 * ── The deploy this exists to stop failing ──────────────────────────────────
 *
 * start() used to await every service's migrations and then listen. On a
 * hosted platform that is not slow, it is broken: the host watches for a bound
 * port and kills whatever has not opened one inside its scan window. Measured
 * on Render, user-service alone took 59 seconds and the boot passed two and a
 * half minutes before finance had finished — so the port was never opened and
 * the deploy timed out with the process perfectly healthy and most of the way
 * through its work.
 *
 * ── Why this cannot just be "listen first" ──────────────────────────────────
 *
 * Opening the port announces a service that can be routed to. If it answered
 * normally while migrations ran, a request would read a table mid-ALTER — a
 * far worse failure than a slow deploy, and an intermittent one.
 *
 * So there are two states now, not one, and both have to hold:
 *
 *   listening, not ready   the port is open, /health says 503 "starting",
 *                          every other route says 503 with a Retry-After
 *   listening and ready    everything serves
 *
 * This asserts both against the real server.js, by stubbing the migration step
 * so the window between them can be held open and observed. Without the stub
 * the window is a few hundred milliseconds on a laptop and untestable.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const PORT = Number(process.env.VERIFY_BOOT_PORT || 3999);
process.env.PORT = String(PORT);

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

/*
 * The migration step, replaced before server.js requires it, so this script
 * never touches a database. The gate is what is under test; how long the real
 * migrations take is not.
 */
let releaseMigrations;
const migrationsHeld = new Promise((resolve) => { releaseMigrations = resolve; });

const boot = require('../platform/boot');
boot.bootstrapServices = async () => migrationsHeld;
boot.runReadyHooks = () => {};

const { generateFrontendHeader } = require('../platform/security/frontendHeader');

/**
 * Shaped like the web application, signature included.
 *
 * Unsigned, the edge answers 403 before the readiness gate is ever reached —
 * which is correct behaviour and a useless test: it would pass whether the
 * gate existed or not. The signed path is the one a real caller takes, and the
 * one the gate has to stand in.
 */
const ask = async (pathname) => {
  const signedPath = pathname.startsWith('/api') ? pathname.slice(4) : pathname;
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json',
      'Accept-Language': 'en-GB,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      Origin: 'http://localhost:5173',
      'X-Realx8-Auth': generateFrontendHeader({ method: 'GET', path: signedPath }),
    },
  });
  let body = null; try { body = await res.json(); } catch { /* no body */ }
  return { status: res.status, retryAfter: res.headers.get('retry-after'), body };
};

/** The port being open at all is the thing the platform waits for. */
const waitForPort = async (deadlineMs = 20000) => {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      await ask('/health');
      return Date.now();
    } catch {
      await new Promise((r) => { setTimeout(r, 100); });
    }
  }
  return null;
};

(async () => {
  const started = Date.now();
  const { start } = require('../server');
  start();

  console.log('\n── While the migrations are still running ──────────────────────\n');

  const openedAt = await waitForPort();
  check('The port opens without waiting for them',
    openedAt !== null, openedAt ? `open after ${openedAt - started}ms` : 'never opened');
  if (openedAt === null) { process.exit(1); }

  const healthEarly = await ask('/health');
  check('...and health says so rather than claiming to be ok',
    healthEarly.status === 503 && healthEarly.body?.status === 'starting',
    `${healthEarly.status} ${healthEarly.body?.status}`);

  const routeEarly = await ask('/api/settings/platform-name');
  check('A real route is refused, not served from a half-migrated schema',
    routeEarly.status === 503 && routeEarly.body?.reason === 'starting',
    `${routeEarly.status} ${routeEarly.body?.message || ''}`);
  check('...and tells the caller when to come back',
    routeEarly.retryAfter === '15', String(routeEarly.retryAfter));

  console.log('\n── Once they finish ────────────────────────────────────────────\n');

  releaseMigrations();
  await new Promise((r) => { setTimeout(r, 400); });

  const healthLate = await ask('/health');
  check('Health flips to ok', healthLate.status === 200 && healthLate.body?.status === 'ok',
    `${healthLate.status} ${healthLate.body?.status}`);

  const routeLate = await ask('/api/settings/platform-name');
  check('...and routes are served rather than refused',
    routeLate.status !== 503, String(routeLate.status));

  console.log(`\n  ${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(1); });

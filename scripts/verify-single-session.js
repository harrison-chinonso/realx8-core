/**
 * The one-session-per-user rule.
 *
 * Exercises the registry, the request-path guard and the sign-in refusal
 * against a real Redis. It deliberately does NOT touch the development
 * database: the rule lives entirely in the session registry and the middleware,
 * so driving those directly tests the actual logic rather than a re-creation
 * of it.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

process.env.CACHE_PREFIX = 'verifysession';
process.env.SINGLE_SESSION_ENABLED = 'true';
delete process.env.CACHE_ENABLED;

const express = require('express');
const jwt = require('jsonwebtoken');

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const registry = require('../shared/src/sessionRegistry');
  const { cache } = require('../shared/src/cache');
  await sleep(700);
  await cache.delByPrefix('');

  console.log('\n── The rule ─────────────────────────────────────────────────────');

  const USER = 4242;
  await registry.endSession(USER);

  let verdict = await registry.canSignIn(USER);
  check('With no session, signing in is allowed', verdict.allowed === true);

  await registry.startSession(USER, { sid: 'sid-first', ip: '10.0.0.1', userAgent: 'Chrome' });
  verdict = await registry.canSignIn(USER);
  check('While a session is live, a second sign-in is refused',
    verdict.allowed === false && verdict.existing.sid === 'sid-first',
    `blocked by session started ${verdict.existing?.startedAt}`);

  check('The refusal carries what the user needs to act on',
    Boolean(verdict.existing.lastSeenAt) && verdict.existing.ip === '10.0.0.1',
    `last seen ${verdict.existing.lastSeenAt} from ${verdict.existing.ip}`);

  console.log('\n── Signing out releases the hold immediately ────────────────────');
  await registry.endSession(USER);
  verdict = await registry.canSignIn(USER);
  check('After signing out, the next sign-in is allowed at once', verdict.allowed === true);

  console.log('\n── Inactivity releases it without signing out ───────────────────');
  process.env.SESSION_INACTIVITY_MINUTES = String(2 / 60); // 2 seconds
  await registry.startSession(USER, { sid: 'sid-brief' });
  check('The session is live immediately after sign-in',
    (await registry.canSignIn(USER)).allowed === false);
  await sleep(2600);
  check('Once it goes idle past the window it lapses, and sign-in is allowed',
    (await registry.canSignIn(USER)).allowed === true,
    'this is the "except the old session is logged out by inactivity" case');

  console.log('\n── Activity keeps a session alive ───────────────────────────────');
  process.env.SESSION_INACTIVITY_MINUTES = String(3 / 60); // 3 seconds
  await registry.startSession(USER, { sid: 'sid-busy' });
  // Touch across a span longer than the window; it must not lapse mid-use.
  for (let i = 0; i < 4; i += 1) {
    await sleep(1000);
    await registry.touchSession(USER, 'sid-busy');
  }
  check('A session in continuous use does not expire mid-work',
    (await registry.canSignIn(USER)).allowed === false,
    'touching re-arms the TTL even when the timestamp is throttled');

  await sleep(3400);
  check('...but the same session lapses once the activity stops',
    (await registry.canSignIn(USER)).allowed === true);

  console.log('\n── Users are independent ────────────────────────────────────────');
  process.env.SESSION_INACTIVITY_MINUTES = '30';
  await registry.startSession(4242, { sid: 'a' });
  await registry.startSession(9999, { sid: 'b' });
  check('One user\'s session does not block another user',
    (await registry.canSignIn(9999)).allowed === false
    && (await registry.activeSession(4242)).sid === 'a'
    && (await registry.activeSession(9999)).sid === 'b',
    'each user has their own entry');
  await registry.endSession(9999);

  console.log('\n── The request path ─────────────────────────────────────────────');

  const SECRET = 'session-test-secret';
  process.env.JWT_SECRET = SECRET;
  const { sessionGuard } = require('../platform/sessionGuard');

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const [, token] = String(req.headers.authorization || '').split(' ');
    if (token) { try { req.user = jwt.verify(token, SECRET); } catch { /* anonymous */ } }
    req.securityPath = req.path;
    next();
  });
  app.use(sessionGuard());
  app.get('/thing', (req, res) => res.json({ ok: true }));
  app.post('/webhooks/paystack', (req, res) => res.json({ webhook: true }));
  const server = await new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
  const port = server.address().port;

  const callAs = async (sid, userId = 4242, path2 = '/thing') => {
    const token = jwt.sign({ id: userId, sid }, SECRET);
    const res = await fetch(`http://127.0.0.1:${port}${path2}`, {
      method: path2.startsWith('/webhooks') ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(path2.startsWith('/webhooks') ? { body: '{}' } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  let r = await callAs('a');
  check('The live session is served normally', r.status === 200 && r.body.ok === true);

  r = await callAs('an-older-sid');
  check('A superseded session is signed out with a clear reason',
    r.status === 401 && r.body.reason === 'session_superseded',
    `${r.status} ${r.body?.reason}`);

  // A token with no sid predates the feature and must keep working.
  const legacy = jwt.sign({ id: 4242 }, SECRET);
  const legacyRes = await fetch(`http://127.0.0.1:${port}/thing`, {
    headers: { Authorization: `Bearer ${legacy}` },
  });
  check('A token issued before this feature is NOT signed out',
    legacyRes.status === 200,
    'deploying this must not sign every existing user out');

  // No registry entry at all — a restart, or Redis lost — must not lock anyone out.
  await registry.endSession(4242);
  r = await callAs('a');
  check('With the registry empty, requests are allowed, not refused',
    r.status === 200,
    'fail-open: losing the cache must never sign every user out at once');

  r = await callAs('anything', 4242, '/webhooks/paystack');
  check('Integration callbacks are never judged as sessions',
    r.status === 200 && r.body.webhook === true);

  console.log('\n── Expiry is independent of the one-session rule ────────────────');

  /**
   * The bug this covers: both behaviours were one switch, so turning off
   * "only one session at a time" also turned off all session tracking — and
   * nothing ever expired, however long it sat idle, while a comment claimed
   * the opposite.
   */
  process.env.SINGLE_SESSION_ENABLED = 'false';
  process.env.SESSION_INACTIVITY_MINUTES = String(2 / 60);
  await registry.endSession(USER);
  await registry.startSession(USER, { sid: 'sid-independent' });

  check('With the one-session rule OFF, a session is still recorded',
    (await registry.activeSession(USER))?.sid === 'sid-independent',
    'tracking follows SESSION_INACTIVITY_ENABLED, not SINGLE_SESSION_ENABLED');
  check('...and a second sign-in is allowed, which is what OFF means',
    (await registry.canSignIn(USER)).allowed === true);
  check('An active session is valid',
    (await registry.sessionState(USER, 'sid-independent')).reason === 'ok');

  await sleep(2600);
  const lapsed = await registry.sessionState(USER, 'sid-independent');
  check('Once idle past the window the session is EXPIRED, with the rule off',
    lapsed.valid === false && lapsed.reason === 'expired',
    `reason=${lapsed.reason} — this did not happen at all before`);

  check('A lapsed session never blocks a fresh sign-in',
    (await registry.canSignIn(USER)).allowed === true,
    'being refused entry by your own abandoned session is the lockout to avoid');

  console.log('\n── Losing the cache must not sign everyone out ──────────────────');
  await cache.delByPrefix('session:user:');
  const forgotten = await registry.sessionState(USER, 'sid-independent');
  check('A record the cache has lost is "unknown", and allowed',
    forgotten.valid === true && forgotten.reason === 'unknown',
    'expiry is decided by comparing timestamps, not by a key having vanished');

  console.log('\n── Activity cannot outpace the write throttle ───────────────────');
  process.env.SESSION_INACTIVITY_MINUTES = String(2 / 60);
  check('The touch interval never exceeds the window',
    registry.touchIntervalMs() <= (registry.inactivitySeconds() * 1000) / 2,
    `window ${registry.inactivitySeconds()}s -> touch every ${registry.touchIntervalMs() / 1000}s; `
      + 'a fixed 60s throttle expired sessions that were in continuous use');

  process.env.SESSION_INACTIVITY_MINUTES = '30';
  process.env.SINGLE_SESSION_ENABLED = 'true';

  console.log('\n── The kill switch ─────────────────────────────────────────────');
  process.env.SINGLE_SESSION_ENABLED = 'false';
  await registry.startSession(4242, { sid: 'x' });
  check('SINGLE_SESSION_ENABLED=false allows concurrent sign-ins',
    (await registry.canSignIn(4242)).allowed === true);
  process.env.SINGLE_SESSION_ENABLED = 'true';

  server.close();
  await cache.delByPrefix('');
  await cache.disconnect();
  console.log(`\n  ${pass}/${pass + fail} passed.\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ABORTED:', e); process.exit(1); });

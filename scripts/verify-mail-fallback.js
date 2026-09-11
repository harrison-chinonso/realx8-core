/**
 * SMTP port fallback.
 *
 * Runs against the REAL mail host configured in settings, because the whole
 * point of this feature is behaviour that only appears against a real network:
 * a port that refuses, a port that accepts TCP and then never speaks, and one
 * that works.
 *
 * It sends nothing. verify() completes the handshake and the login, which is
 * what "this port works" means, without putting anything in an inbox.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });
process.env.CACHE_PREFIX = 'verifymail';

const mysql = require('mysql2/promise');

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

(async () => {
  const mail = require('../shared/src/mailTransport');

  console.log('\n── The candidate list ───────────────────────────────────────────');
  check('The configured port is tried first',
    mail.candidatePorts(465)[0] === 465, JSON.stringify(mail.candidatePorts(465)));
  check('Fallbacks follow it, without repeating it',
    JSON.stringify(mail.candidatePorts(587)) === JSON.stringify([587, 2525, 465]),
    JSON.stringify(mail.candidatePorts(587)));
  check('An unset port falls back to the defaults',
    JSON.stringify(mail.candidatePorts(null)) === JSON.stringify([587, 2525, 465]));
  check('465 is treated as implicit TLS, others as STARTTLS',
    mail.isImplicitTls(465) === true && mail.isImplicitTls(2525) === false);

  process.env.SMTP_FALLBACK_PORTS = '2525,587';
  check('SMTP_FALLBACK_PORTS overrides the defaults, so a new relay needs no code change',
    JSON.stringify(mail.candidatePorts(25)) === JSON.stringify([25, 2525, 587]),
    JSON.stringify(mail.candidatePorts(25)));
  delete process.env.SMTP_FALLBACK_PORTS;

  console.log('\n── Failure classification ───────────────────────────────────────');
  check('A refused connection is worth trying another port for',
    mail.isConnectionFailure({ code: 'ECONNREFUSED' }) === true);
  check('A stalled greeting is too',
    mail.isConnectionFailure({ message: 'Greeting never received' }) === true);
  check('A rejected login is NOT — every port would reject it identically',
    mail.isConnectionFailure({ message: 'Invalid login: 535 Authentication failed' }) === false,
    'retrying would only add failed logins against the account');

  // ── Against the real relay ────────────────────────────────────────────────
  const db = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  const [rows] = await db.query(
    "SELECT `key`,`value` FROM settings WHERE `key` LIKE 'mail_%' AND company_id IS NULL",
  );
  await db.end();
  const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  if (!cfg.mail_host || !cfg.mail_username || !cfg.mail_password) {
    console.log('\n  SMTP is not configured in settings — skipping the live checks.\n');
    console.log(`  ${pass}/${pass + fail} passed.\n`);
    process.exit(fail ? 1 : 0);
  }

  const { cache } = require('../shared/src/cache');
  await new Promise((r) => setTimeout(r, 700));
  await cache.delByPrefix('mail:port:');

  const base = { host: cfg.mail_host, user: cfg.mail_username, pass: cfg.mail_password };

  console.log('\n── Against the real relay ───────────────────────────────────────');

  // Point it at a port that does not work here, and see it recover.
  const started = Date.now();
  const first = await mail.resolveTransport({ ...base, port: 465 });
  first.transport.close();
  check('A blocked configured port falls back to one that works',
    Number.isInteger(first.port) && first.cached === false,
    `configured 465 -> using ${first.port}, found in ${Date.now() - started}ms`);

  const cachedAt = Date.now();
  const second = await mail.resolveTransport({ ...base, port: 465 });
  second.transport.close();
  const elapsed = Date.now() - cachedAt;
  check('The working port is remembered, so discovery is paid once',
    second.cached === true && second.port === first.port && elapsed < 1000,
    `${elapsed}ms on the second call, against ${Date.now() - started}ms the first time`);

  /**
   * Rediscovery must find A working port — not necessarily the SAME one.
   *
   * This assertion originally required the same port twice and failed against
   * the real relay: 587 worked on the first pass and stalled on the second,
   * so discovery moved on to 2525. That is the feature behaving correctly on a
   * network whose blocking is intermittent, which is precisely the condition
   * fallback exists for. Pinning the expectation to one port would have been
   * asserting that the network is reliable.
   */
  await cache.delByPrefix('mail:port:');
  const rediscovered = await mail.resolveTransport({ ...base, port: 465 });
  rediscovered.transport.close();
  check('Clearing the cache re-runs discovery and still finds a usable port',
    rediscovered.cached === false && mail.candidatePorts(465).includes(rediscovered.port),
    `found ${rediscovered.port}${rediscovered.port === first.port ? '' : ` (the earlier ${first.port} had stopped answering)`}`);

  console.log('\n── Bad credentials stop early ───────────────────────────────────');
  const authStart = Date.now();
  let refused = false;
  try {
    const bad = await mail.resolveTransport({ ...base, pass: 'not-the-password', port: first.port });
    bad.transport.close();
  } catch (error) {
    refused = /invalid login|authentication/i.test(error.message);
  }
  check('A rejected login fails fast instead of walking every port',
    refused && Date.now() - authStart < 6000,
    `refused in ${Date.now() - authStart}ms`);

  await cache.delByPrefix('mail:port:');
  await cache.disconnect();
  console.log(`\n  ${pass}/${pass + fail} passed.\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ABORTED:', e); process.exit(1); });

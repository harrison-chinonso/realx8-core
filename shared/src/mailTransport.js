const { cache } = require('./cache');

/**
 * One SMTP transport for the whole backend, with port fallback.
 *
 * ── The problem this solves ─────────────────────────────────────────────────
 *
 * A mail host that works in one environment can be unreachable in another for
 * reasons that have nothing to do with this application: hosting providers,
 * office networks and cloud egress rules routinely block or black-hole the
 * SMTP submission ports. Measured on one developer machine against Brevo:
 * 465 refused a TCP connection outright, 587 accepted the connection and then
 * never sent its greeting, and 2525 answered in 309ms. Same credentials, same
 * host, same code — only the port differed.
 *
 * That made a working mail configuration an environment-specific accident, and
 * fixing it meant editing a setting per environment and knowing to suspect the
 * port at all. Here the port is a LIST: the configured one first, then the
 * usual alternatives, and the first that actually works is used and remembered.
 *
 * ── Why the discovered port is cached ───────────────────────────────────────
 *
 * A failing port costs seconds — a refused connection is fast, a black-holed
 * one burns the whole connect timeout. Paying that on every email would add
 * those seconds to every request that sends one. The working port is therefore
 * cached, so discovery happens once per environment rather than once per
 * message.
 *
 * The cache key includes the host, the user AND the candidate list, so
 * changing any of them naturally produces a different key — a settings change
 * cannot leave a stale port behind, and there is no eviction to remember to
 * wire up.
 */

/**
 * Ports tried when the configured one does not work, in order.
 *
 *   587   the standard submission port, STARTTLS
 *   2525  the widely-supported alternative, for networks that block 587 —
 *         Brevo, SendGrid, Mailgun and Postmark all listen here
 *   465   implicit TLS, still common and sometimes the only one open
 *
 * Overridable per deployment with SMTP_FALLBACK_PORTS, so an environment with
 * an unusual relay does not need a code change either.
 */
const DEFAULT_FALLBACK_PORTS = [587, 2525, 465];

const parsePorts = (value) => String(value ?? '')
  .split(',')
  .map((entry) => Number(String(entry).trim()))
  .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);

const fallbackPorts = () => {
  const configured = parsePorts(process.env.SMTP_FALLBACK_PORTS);
  return configured.length ? configured : DEFAULT_FALLBACK_PORTS;
};

/**
 * The ports to try, configured one first.
 *
 * Deduplicated, so a configured 587 is not attempted twice, and so the list
 * stays short — every extra entry is a potential timeout on first use.
 */
const candidatePorts = (configuredPort) => {
  const primary = Number(configuredPort);
  const ordered = Number.isInteger(primary) && primary > 0
    ? [primary, ...fallbackPorts()]
    : fallbackPorts();
  return [...new Set(ordered)];
};

/** 465 is implicit TLS; everything else upgrades with STARTTLS. */
const isImplicitTls = (port) => Number(port) === 465;

/**
 * Timeouts.
 *
 * DISCOVERY is deliberately tighter than a normal send. Trying three ports at
 * the full connect timeout could outlast the API gateway's own limit and turn
 * "your password reset is on its way" into a 504. Once a port is known, the
 * usual, more forgiving timeouts apply — a slow-but-working relay should not
 * be abandoned.
 */
const DISCOVERY_TIMEOUTS = { connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 8000 };
const SEND_TIMEOUTS = { connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 12000 };

/** How long a working port is trusted before it is re-checked. */
const PORT_CACHE_SECONDS = 6 * 60 * 60;

const cacheKey = (host, user, ports) => `mail:port:${host}:${user}:${ports.join('-')}`;

const buildTransport = (nodemailer, { host, port, user, pass, timeouts }) => nodemailer.createTransport({
  host,
  port: Number(port),
  secure: isImplicitTls(port),
  auth: { user, pass },
  ...timeouts,
});

/**
 * Whether a failure is worth trying another port for.
 *
 * A refused or silent connection is a network problem and the next port may
 * well work. A rejected login or a refused recipient is not — the other ports
 * would reject it identically, so retrying only multiplies the delay and, for
 * authentication failures, the number of failed logins the provider records
 * against the account.
 */
const isConnectionFailure = (error) => {
  const code = String(error?.code || '');
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EDNS'].includes(code)) {
    return true;
  }
  // nodemailer reports a stalled greeting as a plain timeout without a code.
  return /timed?\s*out|greeting never received|connection closed/i.test(String(error?.message || ''));
};

/**
 * Finds a port that actually connects and authenticates.
 *
 * verify() rather than a bare socket check: a port that accepts TCP but whose
 * relay refuses these credentials is not a working port, and discovering that
 * during a real send would lose the message.
 */
const discoverPort = async (nodemailer, { host, user, pass, ports }) => {
  const failures = [];

  for (const port of ports) {
    const transport = buildTransport(nodemailer, {
      host, port, user, pass, timeouts: DISCOVERY_TIMEOUTS,
    });
    try {
      // eslint-disable-next-line no-await-in-loop
      await transport.verify();
      transport.close();
      if (failures.length) {
        console.log(`[mail] port ${port} works; ${failures.join(', ')} did not`);
      }
      return port;
    } catch (error) {
      failures.push(`${port} (${error.message})`);
      transport.close();
      // An authentication failure is not about the port — the credentials are
      // wrong everywhere, and hammering the remaining ports would just add
      // failed logins against the account.
      if (!isConnectionFailure(error)) {
        console.error(`[mail] port ${port} reachable but rejected: ${error.message}`);
        throw error;
      }
    }
  }

  throw Object.assign(
    new Error(`No usable SMTP port for ${host}. Tried ${failures.join('; ')}`),
    { code: 'ECONNECTION' },
  );
};

/**
 * A transport ready to send, on a port known to work.
 *
 * Returns the port too, so a caller can log which one was actually used —
 * otherwise "mail works here but not there" stays a mystery.
 */
const resolveTransport = async ({ host, port, user, pass }) => {
  // eslint-disable-next-line global-require
  const nodemailer = require('nodemailer');
  const ports = candidatePorts(port);
  const key = cacheKey(host, user, ports);

  const cached = await cache.get(key);
  if (cached && ports.includes(Number(cached))) {
    return {
      transport: buildTransport(nodemailer, { host, port: cached, user, pass, timeouts: SEND_TIMEOUTS }),
      port: Number(cached),
      cached: true,
    };
  }

  const working = await discoverPort(nodemailer, { host, user, pass, ports });
  await cache.set(key, working, PORT_CACHE_SECONDS);
  return {
    transport: buildTransport(nodemailer, { host, port: working, user, pass, timeouts: SEND_TIMEOUTS }),
    port: working,
    cached: false,
  };
};

/**
 * Sends a message, falling back to another port if the connection fails.
 *
 * The retry is bounded to ONE rediscovery: if the cached port has stopped
 * working the cache is dropped and the list is re-walked once. Looping further
 * would mean a mail outage becoming a slow request rather than a fast failure.
 */
const sendMail = async ({ host, port, user, pass, message, label = 'mail' }) => {
  if (!host || !user || !pass) {
    return { sent: false, reason: 'smtp_not_configured' };
  }

  const attempt = async (allowRediscovery) => {
    const resolved = await resolveTransport({ host, port, user, pass });
    try {
      const info = await resolved.transport.sendMail(message);
      return { sent: true, messageId: info.messageId, port: resolved.port, response: info.response };
    } catch (error) {
      // A cached port that has stopped working: forget it and try the list
      // again. Only worth doing once, and only for connection failures.
      if (allowRediscovery && resolved.cached && isConnectionFailure(error)) {
        console.warn(`[${label}] port ${resolved.port} stopped working (${error.message}) — rediscovering`);
        await cache.del(cacheKey(host, user, candidatePorts(port)));
        return attempt(false);
      }
      throw error;
    } finally {
      resolved.transport.close();
    }
  };

  return attempt(true);
};

/**
 * Works out the usable port at boot, in the background.
 *
 * Discovery is only slow the FIRST time — but "the first time" would otherwise
 * be a real user waiting on a password-reset email while three ports are
 * tried. Doing it at startup moves that cost to a moment when nobody is
 * waiting, so by the time anyone asks for mail the answer is already cached.
 *
 * Deliberately not awaited by the caller and it never throws: mail being
 * unreachable is not a reason to refuse to start the API. A failure here is
 * logged and the next real send will simply discover for itself.
 */
const warmMailPort = async (sequelize) => {
  try {
    const { QueryTypes } = require('sequelize');
    const { q } = require('./dialect');
    /**
     * Quoted per engine, not with backticks.
     *
     * key and value are reserved words that must be quoted to be read at all,
     * and MySQL and Postgres quote them differently — each rejecting the
     * other's. A literal backtick here is a syntax error on Postgres, which is
     * how this warmed fine in development and logged
     * `syntax error at or near ","` on every production boot.
     */
    const rows = await sequelize.query(
      `SELECT ${q(sequelize, 'key')}, ${q(sequelize, 'value')} FROM settings
        WHERE ${q(sequelize, 'key')} IN ('mail_host','mail_port','mail_username','mail_password')
          AND company_id IS NULL`,
      { type: QueryTypes.SELECT },
    );
    const cfg = Object.fromEntries(rows.map((row) => [row.key, row.value]));

    const host = cfg.mail_host || process.env.SMTP_HOST;
    const user = cfg.mail_username || process.env.SMTP_USER;
    const pass = cfg.mail_password || process.env.SMTP_PASS;
    if (!host || !user || !pass) return;

    const port = Number(cfg.mail_port || process.env.SMTP_PORT || 587);
    const resolved = await resolveTransport({ host, port, user, pass });
    resolved.transport.close();
    if (resolved.port !== port) {
      console.log(`[mail] configured port ${port} is not usable here — using ${resolved.port}. `
        + 'Set mail_port to that value to skip this check on future boots.');
    }
  } catch (error) {
    console.warn(`[mail] could not determine a working SMTP port at boot: ${error.message}`);
  }
};

module.exports = {
  sendMail,
  warmMailPort,
  resolveTransport,
  candidatePorts,
  isImplicitTls,
  isConnectionFailure,
  DEFAULT_FALLBACK_PORTS,
  SEND_TIMEOUTS,
  DISCOVERY_TIMEOUTS,
};

/**
 * Brings the enabled services' databases up, one at a time.
 *
 * Sequential on purpose. Every service runs `sequelize.sync()` plus its own
 * migrations against the SAME MySQL database, and several touch tables another
 * service owns (auth-service adds a column to `companies`; property- and
 * finance-service sync with `alter: true`). Run concurrently — which is what
 * happens when they are nine separate deploys booting at once — those DDL
 * statements race. In one process we can simply order them, which is strictly
 * safer than today.
 *
 * Registry order is boot order; user-service is first because it owns the
 * tables the rest read.
 */

const { withBootLock } = require('../shared/src/bootLock');

/** How long a service may migrate before the boot says what it is waiting on. */
const STALL_REPORT_MS = 30_000;

/**
 * Names what a stalled migration is waiting on (Postgres only).
 *
 * A boot that hangs used to print "[boot] user: migrating" and nothing else
 * until the platform timed the deploy out — on Render, with the old instance
 * still serving, typically a DDL statement waiting for a table lock that a
 * live transaction holds. pg_stat_activity knows exactly which: this prints
 * every waiting statement in the database and the session blocking it, so the
 * next stall explains itself in the deploy log.
 *
 * Best effort and read-only. It never throws and never touches a session.
 */
const reportStall = async (sequelize, serviceName, startedAt, logger) => {
  try {
    if (sequelize?.getDialect?.() !== 'postgres') return;
    const waiting = await sequelize.query(
      `SELECT w.pid, w.wait_event_type, w.wait_event,
              ROUND(EXTRACT(EPOCH FROM now() - w.query_start)) AS waited_s,
              LEFT(REGEXP_REPLACE(w.query, '\\s+', ' ', 'g'), 160) AS query,
              b.pid AS blocker_pid, b.state AS blocker_state, b.application_name AS blocker_app,
              ROUND(EXTRACT(EPOCH FROM now() - b.xact_start)) AS blocker_xact_s,
              LEFT(REGEXP_REPLACE(b.query, '\\s+', ' ', 'g'), 160) AS blocker_query
         FROM pg_stat_activity w
         LEFT JOIN LATERAL unnest(pg_blocking_pids(w.pid)) AS bp(pid) ON TRUE
         LEFT JOIN pg_stat_activity b ON b.pid = bp.pid
        WHERE w.datname = current_database() AND cardinality(pg_blocking_pids(w.pid)) > 0`,
      { type: sequelize.QueryTypes?.SELECT || 'SELECT' },
    );
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (!waiting.length) {
      logger.warn(`[boot] ${serviceName}: still migrating after ${elapsed}s — nothing is blocked on a lock, so it is slow rather than stuck.`);
      return;
    }
    logger.warn(`[boot] ${serviceName}: still migrating after ${elapsed}s — ${waiting.length} statement(s) waiting on a lock:`);
    waiting.forEach((row) => {
      logger.warn(`[boot]   pid ${row.pid} waiting ${row.waited_s}s (${row.wait_event_type}/${row.wait_event}): ${row.query}`);
      logger.warn(`[boot]     blocked by pid ${row.blocker_pid} (${row.blocker_state}, transaction open ${row.blocker_xact_s}s, `
        + `${row.blocker_app || 'no application name'}): ${row.blocker_query}`);
    });
    logger.warn('[boot]   An "idle in transaction" blocker is a session that opened a transaction and never finished it; '
      + 'ending it (SELECT pg_terminate_backend(<pid>)) releases the lock.');
  } catch (error) {
    logger.warn(`[boot] ${serviceName}: still migrating, and could not read pg_stat_activity (${error.message}).`);
  }
};

const bootstrapServices = async (
  services,
  /*
   * onProgress is optional and defaults to doing nothing, so every existing
   * caller — and every test — keeps working untouched.
   */
  { logger = console, onProgress = () => {} } = {},
) => {
  const migrate = async () => {
    let done = 0;
    for (const { service, module: serviceModule } of services) {
      const started = Date.now();
      logger.info(`[boot] ${service.name}: migrating`);
      /*
       * Reported as well as logged. The port is open during all of this now,
       * so /health is being asked "are you ready" by a platform that will give
       * up if the answer never changes — and "no" is far less useful than
       * "no, finance, 6 of 8". On a free instance this loop runs for minutes,
       * and that is the difference between watching a deploy and guessing.
       */
      onProgress({ service: service.name, done, total: services.length });
      const watchdog = setInterval(
        () => reportStall(serviceModule.sequelize || sequelize, service.name, started, logger),
        STALL_REPORT_MS,
      );
      watchdog.unref?.();
      try {
        // Deliberately serial — see the note above.
        // eslint-disable-next-line no-await-in-loop
        await serviceModule.bootstrap();
      } finally {
        clearInterval(watchdog);
      }
      done += 1;
      logger.info(`[boot] ${service.name}: ready in ${Date.now() - started}ms`);
    }
    onProgress({ service: null, done, total: services.length });
  };

  /**
   * …and serial ACROSS PROCESSES too, which the ordering above cannot achieve
   * on its own.
   *
   * The note at the top of this file explains why these statements must not
   * race. It is right, and it was only half enforced: within one process the
   * loop orders them, but nothing stopped a SECOND process migrating at the
   * same time — nodemon restarting mid-boot, a rolling deploy, or the split
   * shape where all nine services start as separate deployments.
   *
   * Observed, on a developer machine, within one minute of each other:
   *
   *     [boot] failed: Deadlock found when trying to get lock
   *     [boot] failed: Can't DROP 'properties_ibfk_1'
   *
   * Two unrelated-looking errors, one cause, and neither reproducible on a
   * quiet machine. The lock is taken against the first service's connection —
   * they all share one database, so any of them names the same lock.
   *
   * See shared/src/bootLock.js, including why failing to take it still boots.
   */
  const first = services[0];
  const sequelize = first?.module?.sequelize
    || (() => {
      try {
        // eslint-disable-next-line global-require
        return require(`../services/${first.service.dir}/src/config/database`).sequelize;
      } catch {
        return null;
      }
    })();

  if (!sequelize) {
    logger.warn('[boot] no connection to lock against — migrating without the cross-process lock.');
    return migrate();
  }

  return withBootLock(sequelize, migrate, { logger });
};

/** Post-listen hooks (cron jobs, schedulers) — only after the port is open. */
const runReadyHooks = (services, { logger = console } = {}) => {
  services.forEach(({ service, module: serviceModule }) => {
    if (typeof serviceModule.onReady !== 'function') return;
    try {
      serviceModule.onReady();
    } catch (error) {
      // A scheduler failing to arm must not take the API down with it.
      logger.error(`[boot] ${service.name} onReady failed: ${error.message}`);
    }
  });
};

module.exports = { bootstrapServices, runReadyHooks };

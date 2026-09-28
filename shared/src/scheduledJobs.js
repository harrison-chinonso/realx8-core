/**
 * Whether this process should run the scheduled jobs.
 *
 * ── Why a flag at all ───────────────────────────────────────────────────────
 *
 * The timers are started by whichever service owns them, which means EVERY
 * instance runs all of them. One instance is fine. Two instances is two
 * accrual runs, two reminder sweeps and two reactivation checks a day, which
 * is the moment horizontal scaling stops being free.
 *
 * The jobs themselves are written to survive that — accrual is idempotent by
 * arithmetic, the schedule job by a unique index, the reactivation notices by
 * the table they now record into. So a second instance is not dangerous. It is
 * simply wasted work, doubled database load at the same minute of the day, and
 * one more thing to reason about when something runs twice.
 *
 * With this flag the shape everybody wants becomes configuration rather than a
 * rewrite: run the web instances with RUN_SCHEDULED_JOBS=off and exactly one
 * worker with it on, and the timers fire once no matter how wide the web tier
 * is scaled.
 *
 * ── Default on, deliberately ────────────────────────────────────────────────
 *
 * An unset variable keeps today's behaviour, so a single-instance deployment
 * that knows nothing about this keeps working. The failure to avoid is the
 * other way round: defaulting to off would silently stop accruals and payment
 * reminders on every existing deployment the moment this shipped, and nothing
 * would report it — the jobs would just never run.
 */
const OFF = new Set(['off', 'false', '0', 'no']);

const schedulersEnabled = () => !OFF.has(
  String(process.env.RUN_SCHEDULED_JOBS ?? 'on').trim().toLowerCase(),
);

/**
 * Starts a job, or says why it did not.
 *
 * The log line matters: a worker that was supposed to run the crons and is
 * quietly not running them looks exactly like a worker that is running them
 * and finding nothing to do. One line at boot tells the two apart.
 */
const startIfEnabled = (name, start, logger = console) => {
  if (!schedulersEnabled()) {
    logger.info(`[cron] ${name} not started — RUN_SCHEDULED_JOBS is off for this instance`);
    return false;
  }
  start();
  return true;
};

module.exports = { schedulersEnabled, startIfEnabled };

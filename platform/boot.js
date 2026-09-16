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

const bootstrapServices = async (services, { logger = console } = {}) => {
  const migrate = async () => {
    for (const { service, module: serviceModule } of services) {
      const started = Date.now();
      logger.info(`[boot] ${service.name}: migrating`);
      // Deliberately serial — see the note above.
      // eslint-disable-next-line no-await-in-loop
      await serviceModule.bootstrap();
      logger.info(`[boot] ${service.name}: ready in ${Date.now() - started}ms`);
    }
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

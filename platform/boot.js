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

const bootstrapServices = async (services, { logger = console } = {}) => {
  for (const { service, module: serviceModule } of services) {
    const started = Date.now();
    logger.info(`[boot] ${service.name}: migrating`);
    // Deliberately serial — see the note above.
    // eslint-disable-next-line no-await-in-loop
    await serviceModule.bootstrap();
    logger.info(`[boot] ${service.name}: ready in ${Date.now() - started}ms`);
  }
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

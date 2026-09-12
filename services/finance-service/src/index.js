require('dotenv').config({ path: require('path').resolve(__dirname, '../../../cred.env') });
const express = require('express');
const { syncEnums } = require('../../../shared/src/enumSync');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { isEmbedded } = require('../../../platform/runtime');
const { isMySQL } = require('../../../shared/src/dialect');
const { connectDatabase } = require('./config/database');
const logger = require('./config/logger');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const routes = require('./routes');
const { payloadCrypto } = require('../../../platform/payloadCrypto');

const app = express();
const PORT = Number(process.env.PORT || 3006);

// Composed into Realx8-Core's single process, the edge already applied these to
// the shared request — installing a second cors layer here would overwrite the
// origin it negotiated. Deployed on its own, this service owns them.
if (!isEmbedded()) {
  app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || '*', credentials: true }));
  app.use(helmet());
  app.use(morgan('dev'));
}
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
/**
 * Payload decryption, mounted here rather than at the gateway.
 *
 * It has to sit after express.json, because the encrypted envelope IS json and
 * this reads it out of req.body. Body parsing happens per service in this
 * codebase, so this is where the parsed body first exists — and mounting it
 * here means a service running REMOTELY behind the gateway proxy decrypts its
 * own traffic, instead of the gateway having to parse and re-serialise every
 * proxied body.
 *
 * Inert unless PAYLOAD_ENCRYPTION_MODE is set. See platform/payloadCrypto.js.
 */
app.use(payloadCrypto());
app.get('/health', (req, res) => res.json({ service: 'services/finance-service', status: 'ok' }));
app.use('/', routes);
app.use(notFound);
app.use(errorHandler);

/**
 * Connect, migrate, sync. Idempotent, and identical in both deployment shapes —
 * standalone it runs from start() below; composed, Realx8-Core's server.js calls
 * it directly so every service's DDL runs in a defined order instead of racing.
 */
const bootstrap = async () => {
  await connectDatabase();
  const models = require('./models');
  // Purely a MySQL housekeeping step: there is no equivalent mess to clean up
  // on a Postgres database, which was never built by the older migrations.
  if (isMySQL(models.sequelize)) {
    await require('./migrations/dropDuplicateIndexes')(models.sequelize);
  }

  /**
   * These two run on BOTH engines, unlike the rest of this folder.
   *
   * The gate that used to wrap them assumed a Postgres database is always a
   * fresh one that sync() builds correctly from the models. That is not true
   * of this deployment: the production Postgres database was populated by
   * copying the MySQL data across, so it carries the old vocabulary and the old
   * index layout, and neither is something sync() will reconcile —
   *
   *   - sync() will not add values to a Postgres enum TYPE that already exists,
   *     which is why `pending` rows produced
   *     `invalid input value for enum ...: "pending"` in production and nothing
   *     at all in development
   *   - sync({ alter: true }) does not retrofit the per-company unique indexes
   *     onto tables that already exist, so the reference and payment-reference
   *     guarantees were simply absent there
   *
   * Both migrations now speak both engines — see shared/src/dialect.js — and
   * both are idempotent, so running them everywhere is the safe direction.
   */
  await require('./migrations/migrateCommissionLifecycle')(models.sequelize);

  await models.sequelize.sync({ alter: true });
  /**
   * Postgres will not add values to an enum TYPE that already exists, so a
   * value added to a model never reaches the database and the first row to use
   * it fails in production while development is clean. This reconciles every
   * model's enums with the database — see shared/src/enumSync.js.
   */
  await syncEnums(models.sequelize);

  /**
   * After sync, because it replaces indexes sync itself maintains — running it
   * first would have sync put the old global unique index straight back.
   */
  await require('./migrations/enforceReferenceUniqueness')(models.sequelize);

  /**
   * After sync, so the column is certainly there on a database whose invoices
   * table predates it. Both engines: the rows that need it are the old ones,
   * and those are in production.
   */
  await require('./migrations/backfillInvoiceProperty')(models.sequelize);
};

/**
 * Background jobs. Split out of the listen callback so they start at the same
 * point in the lifecycle either way: once the port is open, never during
 * migrations. Composed, server.js calls this after its own listen.
 */
const onReady = () => {
  // The daily schedule sweep (FRD 9.4) — timing statuses, default fees,
  // reminders and invoice expiry. Idempotent and safe to re-run.
  require('./utils/scheduleJob').startScheduleJob();
};

const start = async () => {
  try {
    await bootstrap();
    app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      onReady();
    });
  } catch (error) {
    logger.error(error.stack || error.message);
    process.exit(1);
  }
};

if (require.main === module) {
  start();
}

module.exports = { app, bootstrap, onReady, start };

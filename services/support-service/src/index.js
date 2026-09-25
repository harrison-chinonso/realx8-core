require('dotenv').config({ path: require('path').resolve(__dirname, '../../../cred.env') });
const express = require('express');
const { syncEnums } = require('../../../shared/src/enumSync');
const { syncIfSchemaChanged } = require('../../../shared/src/syncIfSchemaChanged');
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
const { createAuditor } = require('../../../shared/src/audit');

const app = express();
const PORT = Number(process.env.PORT || 3008);

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
/**
 * The audit trail, recorded for this service's own routes.
 *
 * Mounted per service rather than once at the edge, and that is not an
 * oversight. Split into nine deployments the edge runs inside the gateway,
 * which holds no database connection — an audit trail that only existed in the
 * single-process shape would be missing exactly when the deployment is most
 * complicated. Here, a service records its own activity in both shapes, into
 * the one `audit_logs` table they all share.
 *
 * After payloadCrypto, because an encrypted body is not readable until it has
 * been opened, and before the routes, so the body it copies is the one that was
 * sent rather than whatever a handler left behind. See shared/src/audit.js.
 */
app.use(createAuditor(require('./config/database').sequelize).auditMiddleware());
app.get('/health', (req, res) => res.json({ service: 'services/support-service', status: 'ok' }));
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
  if (isMySQL(models.sequelize)) {
    await require('./migrations/dropDuplicateIndexes')(models.sequelize);
  }
  await syncIfSchemaChanged(models.sequelize, { serviceName: 'support-service', logger });
  /**
   * Postgres will not add values to an enum TYPE that already exists, so a
   * value added to a model never reaches the database and the first row to use
   * it fails in production while development is clean. This reconciles every
   * model's enums with the database — see shared/src/enumSync.js.
   */
  await syncEnums(models.sequelize);
};

const start = async () => {
  try {
    await bootstrap();
    app.listen(PORT, () => logger.info(`Server running on port ${PORT}`));
  } catch (error) {
    logger.error(error.stack || error.message);
    process.exit(1);
  }
};

if (require.main === module) {
  start();
}

module.exports = { app, bootstrap, start };

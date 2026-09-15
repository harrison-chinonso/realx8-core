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
const { createAuditor } = require('../../../shared/src/audit');

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
   * The commission engine's own tables — plans, versions, entitlements, ledger.
   *
   * Created by an explicit migration rather than by sync() from models, because
   * the ledger and the entitlement lines carry uniqueness that IS the
   * idempotency guarantee (FR-CLC-002), and sync({ alter: true }) is exactly
   * what has proved unreliable about retrofitting indexes onto existing tables.
   */
  await require('./migrations/createCommissionEngine')(models.sequelize);

  /**
   * After sync, so the column is certainly there on a database whose invoices
   * table predates it. Both engines: the rows that need it are the old ones,
   * and those are in production.
   */
  await require('./migrations/backfillInvoiceProperty')(models.sequelize);

  /**
   * After sync too, which is what adds receipts.rejection_reason — this only
   * carries the existing data into it.
   */
  await require('./migrations/splitReceiptRejectionReason')(models.sequelize);

  /**
   * After sync, because sync is what maintains this constraint and running
   * first would let it put the cascade straight back.
   */
  await require('./migrations/relaxReceiptPaymentCascade')(models.sequelize);

  /**
   * After sync, which owns the column's type — running first would let sync
   * put the old three-name ENUM back.
   */
  await require('./migrations/openCommissionRuleLevels')(models.sequelize);

  /**
   * Credit and debit notes gained an approval lifecycle; the enum has to carry
   * the new states before any note can be raised into one.
   */
  await require('./migrations/addNoteApprovalStates')(models.sequelize);

  /**
   * The platform's default reminder schedule, and the reminders already sent
   * under the old two-column tracking.
   */
  await require('./migrations/seedReminderSchedules')(models.sequelize);

  /**
   * The document-number counter's table, created here rather than lazily on
   * first use.
   *
   * It is DDL, and DDL while a transaction is open invalidates that
   * transaction — so a payment that raises a debit note for an overpayment
   * inside its own transaction would fail on whichever run happened to be the
   * first since the table appeared. Doing it at boot means every document
   * afterwards is pure DML.
   */
  await require('../../../shared/src/documentSequence').ensureTable(models.sequelize);
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

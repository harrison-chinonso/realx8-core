require('dotenv').config({ path: require('path').resolve(__dirname, '../../../cred.env') });
const express = require('express');
const { syncEnums } = require('../../../shared/src/enumSync');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const { isEmbedded } = require('../../../platform/runtime');
const { isMySQL } = require('../../../shared/src/dialect');
const { connectDatabase } = require('./config/database');
const logger = require('./config/logger');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const routes = require('./routes');
const addMultiTenancy = require('./migrations/addMultiTenancy');
const { payloadCrypto } = require('../../../platform/payloadCrypto');
const { createAuditor } = require('../../../shared/src/audit');

const app = express();
const PORT = Number(process.env.PORT || 3002);

// Composed into Realx8-Core's single process, the edge already applied these to
// the shared request — installing a second cors layer here would overwrite the
// origin it negotiated. The edge relaxes crossOriginResourcePolicy for exactly
// the reason this service does: /uploads images are embedded from Realx8-Ui's
// origin. Deployed on its own, this service owns them.
if (!isEmbedded()) {
  app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || '*', credentials: true }));
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
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
app.use('/uploads', express.static(path.join(__dirname, '../../../uploads')));
app.get('/health', (req, res) => res.json({ service: 'services/user-service', status: 'ok' }));
app.use('/', routes);
app.use(notFound);
app.use(errorHandler);

const runMigrations = async (sequelize) => {
  if (isMySQL(sequelize)) {
    await addMultiTenancy(sequelize);
    // Must run after addMultiTenancy (which may create the column) and before sync.
    await require('./migrations/shrinkReferralCode')(sequelize);
    await require('./migrations/addRealtorLink')(sequelize);
    await require('./migrations/backfillRealtorCodes')(sequelize);
    await require('./migrations/addRealtorLevels')(sequelize);
    await require('./migrations/globalizeRealtorLevels')(sequelize);
    await require('./migrations/addLevelCommission')(sequelize);
    await require('./migrations/addRealtorKyc')(sequelize);
    // Phone numbers were stored unnormalised, which is why nobody with a
    // space in theirs could log in with it.
    await require('./migrations/normalisePhoneNumbers')(sequelize);
  }

  /**
   * Outside the gate, deliberately — this one speaks both engines.
   *
   * Explicit ALTER, because this service syncs with { force: false }, which
   * never adds a column to an existing table: a new User attribute has to be
   * migrated in or bootstrap selects a column that is not there.
   *
   * Which is why it cannot be MySQL-only. The migrations above exist to walk a
   * legacy MySQL installation forward and have nothing to do elsewhere. This
   * one adds columns the current model requires, and production is Postgres
   * with a `users` table copied over from MySQL rather than built by sync() —
   * so gating it there left the columns permanently missing and every
   * `User.findByPk` selecting one that does not exist.
   */
  await require('./migrations/addPasscodeColumns')(sequelize);

  /**
   * Outside the MySQL gate for the same reason: it adds a column and reshapes
   * an index the current model requires, and production is Postgres.
   */
  await require('./migrations/addPropertyShareLinks')(sequelize);

  /**
   * The realtor status history the commission engine's eligibility gate reads.
   * Outside the MySQL gate: it adds a table and a column the current code
   * requires, and production is Postgres.
   */
  await require('./migrations/addRealtorStatusHistory')(sequelize);

  /**
   * The audit trail. Creates its own table when sync cannot — sync is
   * { force: false } here, which creates MISSING tables but is not what makes
   * the append-only guarantees hold; see the migration.
   */
  await require('./migrations/createAuditLog')(sequelize);
};

/**
 * Connect, migrate, sync, seed. Idempotent, and identical in both deployment
 * shapes — standalone it runs from start() below; composed, Realx8-Core's
 * server.js calls it FIRST, before every other service, because this service
 * owns `users`, `companies` and `settings`, which the others read during their
 * own migrations.
 */
/**
 * True only on a database with no tables at all.
 *
 * The migrations below are written against an EXISTING schema — they
 * `ALTER TABLE users ...` and tolerate "Duplicate column", because they were
 * built to run over and over on a live database. On a brand-new one there is
 * nothing to alter and they fail on the first statement, which is why a fresh
 * deployment could not bootstrap itself. Detecting that case lets us create the
 * baseline first and leave the existing-database path untouched.
 */
const isEmptyDatabase = async (sequelize) => {
  const sql = isMySQL(sequelize)
    ? 'SHOW TABLES'
    : "SELECT tablename FROM pg_tables WHERE schemaname = 'public'";
  const [rows] = await sequelize.query(sql);
  return rows.length === 0;
};

const bootstrap = async () => {
  await connectDatabase();
  const models = require('./models');
  // On an empty database, create the baseline from the models first so the
  // migrations have the tables they expect. Their ALTERs then hit the
  // "Duplicate column" case they already ignore, so this changes nothing for a
  // database that already has data — it only makes a first deploy possible.
  if (await isEmptyDatabase(models.sequelize)) {
    logger.info('Empty database — creating baseline schema before migrations');
    await models.sequelize.sync({ force: false });
  }
  // Migrations first — they reshape tables (drop/add columns, fix indexes)
  // before Sequelize sync tries to create/alter anything
  await runMigrations(models.sequelize);
  await models.sequelize.sync({ force: false });
  /**
   * Postgres will not add values to an enum TYPE that already exists, so a
   * value added to a model never reaches the database and the first row to use
   * it fails in production while development is clean. This reconciles every
   * model's enums with the database — see shared/src/enumSync.js.
   */
  await syncEnums(models.sequelize);
  // Before bootstrap, which grants the platform admin every permission that
  // exists — on a fresh database that used to be none, because the catalogue
  // only got seeded by a manual `npm run seed`.
  await require('./migrations/seedRolesAndPermissions')(models);
  /**
   * After seeding, because on a fresh database the seeder is what creates the
   * realtor role in the first place — and runs once only, so an administrator
   * who grants it back is not overruled on the next restart.
   */
  await require('./migrations/revokeRealtorInstallmentPlanView')(models.sequelize);
  /**
   * Also after seeding, because it needs the `audit.view` permission ROW to
   * exist before it can grant it — the seeder is what creates it.
   */
  await require('./migrations/grantAuditViewToAdmins')(models.sequelize);
  /**
   * After sync, because sync is what creates `users` on a fresh database — and
   * after seeding, so the constraint is judged against the finished data rather
   * than a half-populated table.
   */
  await require('./migrations/requireCompanyForClients')(models.sequelize);
  /**
   * After sync, because sync is what maintains these constraints — running
   * first would let it put the cascade straight back.
   */
  await require('./migrations/relaxMediaPostAuthorCascade')(models.sequelize);
  /**
   * After sync, which is what adds media_posts.company_id — and before anybody
   * can call the now-scoped listing, which without this would show every
   * company an empty page.
   */
  await require('./migrations/backfillMediaPostCompany')(models.sequelize);
  await require('./migrations/bootstrap')(models);

  /**
   * The catalogue and the platform admin's grants were just rewritten, so any
   * authorisation cached by a PREVIOUS run of this process — or by a sibling
   * instance still serving traffic through a shared Redis — is now describing
   * permissions that may no longer exist.
   *
   * This matters most on the deploy that adds a permission: without it, a role
   * granted the new permission at boot would still be read as not holding it
   * until the TTL lapsed.
   */
  await require('../../../shared/src/cacheEvict').evictAllAuthorisation();
};

/**
 * Background jobs. Split out of the listen callback so they start at the same
 * point in the lifecycle either way: once the port is open, never during
 * migrations. Composed, server.js calls this after its own listen.
 */
const onReady = () => {
  // Start realtor reactivation scheduler after server is up
  require('./utils/reactivationScheduler')();
  // Start social media impressions sync cron
  require('./utils/impressionsSyncJob').startImpressionsSyncJob();
};

const start = async () => {
  try {
    await bootstrap();
    app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      onReady();
    });
  } catch (error) {
    logger.error(`${error.message || error}\n${error.stack || ''}`);
    process.exit(1);
  }
};

if (require.main === module) {
  start();
}

module.exports = { app, bootstrap, onReady, start };

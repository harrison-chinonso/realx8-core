require('dotenv').config({ path: require('path').resolve(__dirname, '../../../cred.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const { isEmbedded } = require('../../../platform/runtime');
const { connectDatabase } = require('./config/database');
const logger = require('./config/logger');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const routes = require('./routes');
const addMultiTenancy = require('./migrations/addMultiTenancy');

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
app.use('/uploads', express.static(path.join(__dirname, '../../../uploads')));
app.get('/health', (req, res) => res.json({ service: 'services/user-service', status: 'ok' }));
app.use('/', routes);
app.use(notFound);
app.use(errorHandler);

const runMigrations = async (sequelize) => {
  await addMultiTenancy(sequelize);
  // Must run after addMultiTenancy (which may create the column) and before sync.
  await require('./migrations/shrinkReferralCode')(sequelize);
  await require('./migrations/addRealtorLink')(sequelize);
  await require('./migrations/backfillRealtorCodes')(sequelize);
  await require('./migrations/addRealtorLevels')(sequelize);
  await require('./migrations/globalizeRealtorLevels')(sequelize);
  await require('./migrations/addLevelCommission')(sequelize);
  await require('./migrations/addRealtorKyc')(sequelize);
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
  const [rows] = await sequelize.query('SHOW TABLES');
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
  // Before bootstrap, which grants the platform admin every permission that
  // exists — on a fresh database that used to be none, because the catalogue
  // only got seeded by a manual `npm run seed`.
  await require('./migrations/seedRolesAndPermissions')(models);
  await require('./migrations/bootstrap')(models);
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

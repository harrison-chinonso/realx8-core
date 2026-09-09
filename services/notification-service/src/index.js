require('dotenv').config({ path: require('path').resolve(__dirname, '../../../cred.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { isEmbedded } = require('../../../platform/runtime');
const { connectDatabase } = require('./config/database');
const logger = require('./config/logger');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const routes = require('./routes');

const app = express();
const PORT = Number(process.env.PORT || 3007);

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
app.get('/health', (req, res) => res.json({ service: 'services/notification-service', status: 'ok' }));
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
  await require('./migrations/dropDuplicateIndexes')(models.sequelize);
  await models.sequelize.sync({ alter: true });
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

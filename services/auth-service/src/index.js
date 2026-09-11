require('dotenv').config({ path: require('path').resolve(__dirname, '../../../cred.env') });
const express = require('express');
const { syncEnums } = require('../../../shared/src/enumSync');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { Op } = require('sequelize');
const { isEmbedded } = require('../../../platform/runtime');
const { isMySQL, q } = require('../../../shared/src/dialect');
const { connectDatabase } = require('./config/database');
const logger = require('./config/logger');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const routes = require('./routes');

const session = require('express-session');
const { payloadCrypto } = require('../../../platform/payloadCrypto');

const app = express();
const PORT = Number(process.env.PORT || 3001);

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
app.use(session({
  secret: process.env.SESSION_SECRET || process.env.JWT_SECRET || 'realto-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 10 * 60 * 1000 },
}));
app.use(passport.initialize());
app.use(passport.session());
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => done(null, { id }));
app.get('/health', (req, res) => res.json({ service: 'services/auth-service', status: 'ok' }));
app.use('/', routes);
app.use(notFound);
app.use(errorHandler);

const configurePassport = async () => {
  const { User } = require('./models');
  const { syncUserRoles, reloadConfig: _r } = require('./controllers/authController');
  const { QueryTypes } = require('sequelize');
  const { sequelize } = require('./config/database');

  // Load Google credentials from DB settings (fall back to env). `value`,
  // `key` and `group` are reserved-ish words in both dialects, so they need
  // quoting — but MySQL uses backticks and Postgres uses double quotes,
  // hence quoteIdentifier rather than a literal string.
  const getDbSetting = async (key, fallback) => {
    try {
      const quote = sequelize.getQueryInterface().queryGenerator.quoteIdentifier.bind(
        sequelize.getQueryInterface().queryGenerator,
      );
      const rows = await sequelize.query(
        `SELECT ${quote('value')} FROM ${quote('settings')} WHERE ${quote('key')} = :key AND ${quote('group')} = 'system' LIMIT 1`,
        { replacements: { key }, type: QueryTypes.SELECT }
      );
      return (rows[0]?.value) || fallback;
    } catch { return fallback; }
  };

  const clientID = await getDbSetting('google_client_id', process.env.GOOGLE_CLIENT_ID);
  const clientSecret = await getDbSetting('google_client_secret', process.env.GOOGLE_CLIENT_SECRET);
  /**
   * The callback URL, with one guard.
   *
   * Settings rows normally win over the environment, and that is right: the
   * value is configured per deployment from the admin screen. But a database
   * restored or migrated from development carries development's row with it,
   * and a localhost callback on a public deployment is rejected by Google with
   * "Access blocked: This app's request is invalid" — while the correct value
   * sits unused in GOOGLE_CALLBACK_URL, so the environment variable looks
   * ignored and the fix looks like it did nothing.
   *
   * So a localhost row is NOT trusted when the environment names a real one.
   * The reverse is untouched: developing locally, where the env var is itself
   * localhost, behaves exactly as before.
   */
  const storedCallback = await getDbSetting('google_callback_url', null);
  const envCallback = process.env.GOOGLE_CALLBACK_URL;
  const isLocal = (url) => /localhost|127\.0\.0\.1/i.test(String(url || ''));

  let callbackURL = storedCallback || envCallback || 'http://localhost:3000/api/auth/google/callback';
  if (storedCallback && isLocal(storedCallback) && envCallback && !isLocal(envCallback)) {
    logger.warn(`Google callback in settings is ${storedCallback}, which Google will reject on a `
      + `public deployment — using GOOGLE_CALLBACK_URL (${envCallback}) instead. `
      + 'Update the google_callback_url setting to silence this.');
    callbackURL = envCallback;
  }

  if (!clientID || !clientSecret) {
    logger.warn('Google OAuth credentials not configured — Google login will be unavailable');
    return;
  }

  passport.use(new GoogleStrategy({
    clientID,
    clientSecret,
    callbackURL,
  }, async (_accessToken, _refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value?.toLowerCase();
      const avatar = profile.photos?.[0]?.value || null;
      const where = email
        ? { [Op.or]: [{ google_id: profile.id }, { email }] }
        : { google_id: profile.id };

      let user = await User.findOne({ where });
      if (!user) {
        user = await User.create({
          name: profile.displayName || email || 'Google User',
          email: email || `${profile.id}@google-oauth.local`,
          password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
          type: 'client',
          google_id: profile.id,
          avatar,
        });
        await syncUserRoles(user.id, ['client']);
      } else {
        let shouldSave = false;
        if (!user.google_id) {
          user.google_id = profile.id;
          shouldSave = true;
        }
        if (!user.avatar && avatar) {
          user.avatar = avatar;
          shouldSave = true;
        }
        if (!user.name && profile.displayName) {
          user.name = profile.displayName;
          shouldSave = true;
        }
        if (shouldSave) {
          await user.save();
        }
      }

      return done(null, user);
    } catch (error) {
      return done(error);
    }
  }));
};

const runMigrations = async (sequelize) => {
  if (isMySQL(sequelize)) {
    const safeAddColumn = async (table, column, definition) => {
      try {
        await sequelize.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
      } catch (e) {
        if (!e.message.includes('Duplicate column name')) throw e;
      }
    };

    const safeModifyColumn = async (table, column, definition) => {
      try {
        await sequelize.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${definition}`);
      } catch (e) {
        logger.warn(`Could not modify column ${table}.${column}: ${e.message}`);
      }
    };

    const roles = [
      'superior_admin','super_admin','admin','employee','realtor','client',
      'coo','csmo','product_manager','customer_care','media_team','branch_manager','front_desk',
    ].map((role) => `'${role}'`).join(',');

    await safeModifyColumn('users', 'type', `ENUM(${roles}) NOT NULL DEFAULT 'client'`);
    await safeAddColumn('users', 'company_id', 'INT UNSIGNED NULL');
    await safeAddColumn('users', 'two_factor_enabled', 'TINYINT(1) NOT NULL DEFAULT 0');
    await safeAddColumn('users', 'two_factor_secret', 'VARCHAR(255) NULL');
    await safeAddColumn('users', 'google_id', 'VARCHAR(255) NULL');

    /**
     * Binds a refresh token to the session it was issued for.
     *
     * Added explicitly because this service syncs with { force: false }, which
     * creates missing TABLES but never adds a column to one that already
     * exists — so the model change alone would leave the column absent and every
     * write to it silently dropped.
     */
    await safeAddColumn('refresh_tokens', 'sid', 'VARCHAR(64) NULL');

    // Ensure companies table has the referral_code column (user-service owns the
    // table but auth-service reads it during self-registration)
    try {
      await sequelize.query(
        `ALTER TABLE companies ADD COLUMN ${q(sequelize, 'referral_code')} VARCHAR(5) NULL`,
      );
    } catch (e) {
      if (!e.message.includes('Duplicate column name')) {
        // table may not exist yet; user-service will create it on its next boot
      }
    }
  
    try {
      /**
       * Quoted per engine. With MySQL backticks this was a syntax error on
       * Postgres, swallowed by the catch below — so the index was silently
       * never created there and google_id was not actually unique.
       */
      await sequelize.query(
        `CREATE UNIQUE INDEX idx_users_google_id ON users(${q(sequelize, 'google_id')})`,
      );
    } catch (_error) { /* index already exists */ }
  }
};

/**
 * Connect, migrate, sync, arm Google OAuth. Idempotent, and identical in both
 * deployment shapes — standalone it runs from start() below; composed,
 * Realx8-Core's server.js calls it directly so every service's DDL runs in a
 * defined order instead of racing.
 */
/**
 * Closes the last way signing and verification can disagree.
 *
 * The signer prefers JWT_SECRET and falls back to the settings row; the
 * verifier — shared/src/middleware/auth.js, used by every service — only ever
 * reads JWT_SECRET. So a deployment configured ENTIRELY through the database,
 * with no environment variable at all, would sign with the row and verify
 * against the built-in default: signing in succeeds and every request
 * afterwards fails with "Invalid or expired token".
 *
 * Adopting the row into the environment at boot makes the two agree. It only
 * ever fills a gap — a variable that is already set is never touched — so this
 * cannot override deployment configuration with a value that arrived in a
 * database dump.
 */
const adoptStoredJwtSecret = async (sequelize) => {
  if (process.env.JWT_SECRET) return;
  try {
    const { QueryTypes } = require('sequelize');
    const rows = await sequelize.query(
      `SELECT ${q(sequelize, 'value')} FROM settings
        WHERE ${q(sequelize, 'key')} = 'jwt_secret' AND company_id IS NULL LIMIT 1`,
      { type: QueryTypes.SELECT },
    );
    const stored = rows[0]?.value;
    if (!stored) return;
    process.env.JWT_SECRET = stored;
    logger.warn('JWT_SECRET was not set; using the jwt_secret from settings so that tokens can be '
      + 'verified. Set it in the environment — a secret kept only in the database travels with '
      + 'every dump and restore of that database.');
  } catch (error) {
    logger.warn(`Could not read jwt_secret from settings: ${error.message}`);
  }
};

const bootstrap = async () => {
  await connectDatabase();
  const models = require('./models');
  await models.sequelize.sync({ force: false });
  /**
   * Postgres will not add values to an enum TYPE that already exists, so a
   * value added to a model never reaches the database and the first row to use
   * it fails in production while development is clean. This reconciles every
   * model's enums with the database — see shared/src/enumSync.js.
   */
  await syncEnums(models.sequelize);
  await runMigrations(models.sequelize);
  // Before anything can issue a token.
  await adoptStoredJwtSecret(models.sequelize);
  // Reads the Google client id/secret from the settings table, so it has to come
  // after the schema exists. Deliberately not awaited: missing credentials only
  // mean Google login is unavailable, which must not hold up boot.
  configurePassport();
};

const start = async () => {
  try {
    await bootstrap();
    await new Promise((resolve, reject) => {
      const server = app.listen(PORT, () => {
        logger.info(`Server running on port ${PORT}`);
        resolve();
      });
      server.once('error', reject);
    });
  } catch (error) {
    logger.error(`${error.message || error}\n${error.stack || ''}`);
    process.exit(1);
  }
};

if (require.main === module) {
  start();
}

module.exports = { app, bootstrap, start };

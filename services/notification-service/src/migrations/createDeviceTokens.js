const {
  isPostgres, tableExists, quoteIdent, indexExists, isDuplicateIndexError,
} = require('../../../../shared/src/dialect');

/**
 * Where a phone's permission to be notified is kept — the native twin of
 * push_subscriptions (Realx8-Mobile; sent by shared/src/nativePush.js).
 *
 * One row per INSTALL, for the same reason push_subscriptions is per browser:
 * a person with a phone and a tablet has two, and sending to one does not
 * reach the other. The token is the identity — FCM and APNs issue it to one
 * app on one device — so registering again from the same install is an
 * update, and may move the row to a different person (a shared phone, an
 * account switch), which is what stops the previous user's notifications
 * arriving on it.
 *
 * `app_id` is the bundle id / package name. White-label builds each have their
 * own, and APNs addresses a notification to exactly one (`apns-topic`).
 * `environment` is APNs' sandbox or production: a development build's token
 * is refused by the production service and the reverse, so each is sent to
 * the service that issued it.
 */

const id = (pg) => (pg ? 'BIGSERIAL PRIMARY KEY' : 'BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY');
const fk = (pg) => (pg ? 'INTEGER' : 'INT UNSIGNED');
const ts = (pg) => (pg ? 'TIMESTAMP WITH TIME ZONE' : 'DATETIME');
const suffix = (pg) => (pg ? '' : ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');

module.exports = async (sequelize) => {
  const pg = isPostgres(sequelize);
  const table = quoteIdent(sequelize, 'device_tokens');

  if (!(await tableExists(sequelize, 'device_tokens'))) {
    await sequelize.query(
      `CREATE TABLE ${table} (
        id ${id(pg)},
        user_id ${fk(pg)} NOT NULL,
        company_id ${fk(pg)} NULL,
        /* 'android' (sent through FCM) or 'ios' (sent through APNs). */
        platform VARCHAR(10) NOT NULL,
        /* FCM tokens run to ~165 characters, APNs to 64 hex; 512 leaves room. */
        token VARCHAR(512) NOT NULL,
        app_id VARCHAR(150) NULL,
        environment VARCHAR(20) NULL,
        /* So a person can tell which of their devices a row is. */
        device_name VARCHAR(150) NULL,
        app_version VARCHAR(30) NULL,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_used_at ${ts(pg)} NULL,
        created_at ${ts(pg)} NOT NULL,
        updated_at ${ts(pg)} NULL
      )${suffix(pg)}`,
    );
  }

  // Prefix on MySQL, as for push_subscriptions: utf8mb4 cannot index 512 characters in one key.
  const unique = 'ux_device_tokens_token';
  if (!(await indexExists(sequelize, 'device_tokens', unique))) {
    const expression = pg ? quoteIdent(sequelize, 'token') : `${quoteIdent(sequelize, 'token')}(255)`;
    await sequelize.query(`CREATE UNIQUE INDEX ${quoteIdent(sequelize, unique)} ON ${table} (${expression})`)
      .catch((error) => {
        if (!isDuplicateIndexError(error)) throw error;
      });
  }

  const byUser = 'ix_device_tokens_user';
  if (!(await indexExists(sequelize, 'device_tokens', byUser))) {
    await sequelize.query(`CREATE INDEX ${quoteIdent(sequelize, byUser)} ON ${table} (${quoteIdent(sequelize, 'user_id')})`)
      .catch((error) => {
        if (!isDuplicateIndexError(error)) throw error;
      });
  }
};

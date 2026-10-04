const {
  isPostgres, tableExists, quoteIdent, indexExists, isDuplicateIndexError,
} = require('../../../../shared/src/dialect');

/**
 * Sign in with Apple refresh tokens, kept only so they can be revoked when the
 * person deletes their account (App Review 5.1.1(v); shared/src/appleTokens.js).
 *
 * Keyed by Apple's user id (`sub`), not by our user id: one Apple ID can stand
 * for a person's accounts at several companies, and the token belongs to the
 * Apple ID. `email` is the address it signed in with, which is how a deletion
 * finds it — the deletion that empties a person's last account revokes it.
 *
 * The token is stored encrypted (authController encryptSecret). It is never
 * used to sign anybody in; it exists to be thrown away properly.
 */

const id = (pg) => (pg ? 'BIGSERIAL PRIMARY KEY' : 'BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY');
const ts = (pg) => (pg ? 'TIMESTAMP WITH TIME ZONE' : 'DATETIME');
const suffix = (pg) => (pg ? '' : ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');

module.exports = async (sequelize) => {
  const pg = isPostgres(sequelize);
  const table = quoteIdent(sequelize, 'apple_credentials');

  if (!(await tableExists(sequelize, 'apple_credentials'))) {
    await sequelize.query(
      `CREATE TABLE ${table} (
        id ${id(pg)},
        apple_sub VARCHAR(255) NOT NULL,
        /* The bundle id Apple issued it to; revoking must name the same one. */
        client_id VARCHAR(150) NOT NULL,
        email VARCHAR(255) NULL,
        refresh_token TEXT NOT NULL,
        created_at ${ts(pg)} NOT NULL,
        updated_at ${ts(pg)} NULL
      )${suffix(pg)}`,
    );
  }

  const unique = 'ux_apple_credentials_sub';
  if (!(await indexExists(sequelize, 'apple_credentials', unique))) {
    await sequelize.query(`CREATE UNIQUE INDEX ${quoteIdent(sequelize, unique)} ON ${table} (${quoteIdent(sequelize, 'apple_sub')})`)
      .catch((error) => {
        if (!isDuplicateIndexError(error)) throw error;
      });
  }

  const byEmail = 'ix_apple_credentials_email';
  if (!(await indexExists(sequelize, 'apple_credentials', byEmail))) {
    await sequelize.query(`CREATE INDEX ${quoteIdent(sequelize, byEmail)} ON ${table} (${quoteIdent(sequelize, 'email')})`)
      .catch((error) => {
        if (!isDuplicateIndexError(error)) throw error;
      });
  }
};

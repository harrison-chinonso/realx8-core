const {
  columnsOf, q, indexExists, isDuplicateIndexError,
} = require('../../../../shared/src/dialect');

/**
 * users.apple_id — Sign in with Apple's stable id for a person (the identity
 * token's `sub`), the twin of google_id.
 *
 * Unique, because it names one Apple account and must never resolve to two
 * rows of ours; NULLs do not collide on either engine, so every account that
 * never used Apple is unaffected.
 *
 * Here rather than left to sync, which creates missing tables but never adds a
 * column to one that exists.
 */
const COLUMN = 'apple_id';
const INDEX = 'idx_users_apple_id';

module.exports = async (sequelize) => {
  const present = await columnsOf(sequelize, 'users');
  if (!present) return; // sync creates the table complete

  if (!present.has(COLUMN)) {
    await sequelize.query(`ALTER TABLE ${q(sequelize, 'users')} ADD COLUMN ${q(sequelize, COLUMN)} VARCHAR(255) NULL`);
    console.log(`[users] ${COLUMN} added — Sign in with Apple can find its accounts.`);
  }

  if (!(await indexExists(sequelize, 'users', INDEX))) {
    await sequelize.query(`CREATE UNIQUE INDEX ${q(sequelize, INDEX)} ON ${q(sequelize, 'users')} (${q(sequelize, COLUMN)})`)
      .catch((error) => {
        if (!isDuplicateIndexError(error)) throw error;
      });
  }
};

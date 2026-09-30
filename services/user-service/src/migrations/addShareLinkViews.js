const {
  columnsOf, tableExists, quoteIdent, isDuplicateError, isPostgres,
} = require('../../../../shared/src/dialect');

/**
 * How often each share link has been opened (see shared/src/shareViews.js).
 *
 * Two plain nullable-safe columns and nothing else — no index, because they
 * are only ever read alongside a row found by its code or property, and only
 * ever written by adding to them.
 *
 * Checks first and alters only what is missing, so a boot with the columns in
 * place runs no DDL at all: an ALTER takes a table lock, and one queued behind
 * a long read is exactly how a deploy hangs.
 */
module.exports = async (sequelize) => {
  if (!(await tableExists(sequelize, 'referral_links'))) return;
  const columns = await columnsOf(sequelize, 'referral_links');
  const table = quoteIdent(sequelize, 'referral_links');
  const pg = isPostgres(sequelize);

  // Two instances booting together both see the column missing; the loser's
  // "duplicate column" (MySQL ER_DUP_FIELDNAME, Postgres 42701) is success.
  const alreadyThere = (error) => isDuplicateError(error)
    || [error?.original?.code, error?.parent?.code].some((code) => code === 'ER_DUP_FIELDNAME' || code === '42701');
  const add = (sql) => sequelize.query(`ALTER TABLE ${table} ADD COLUMN ${sql}`)
    .catch((error) => { if (!alreadyThere(error)) throw error; });

  if (!columns.has('view_count')) {
    await add(`view_count ${pg ? 'INTEGER' : 'INT UNSIGNED'} NOT NULL DEFAULT 0`);
  }
  if (!columns.has('last_viewed_at')) {
    await add(`last_viewed_at ${pg ? 'TIMESTAMP WITH TIME ZONE' : 'DATETIME'} NULL`);
  }
};

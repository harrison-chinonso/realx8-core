const { QueryTypes } = require('sequelize');
const { isPostgres, columnsOf, q } = require('../../../../shared/src/dialect');

/**
 * Adds last_login_at and the passcode columns to `users`.
 *
 * Needed because user-service syncs with `{ force: false }`, which creates
 * missing TABLES but never adds a column to one that already exists. So a new
 * attribute on the User model appears on a fresh database and is silently
 * absent on every existing one — and then bootstrap's `User.findOne` selects
 * it and the whole service fails to boot with "Unknown column".
 *
 * That is exactly what happened when these fields were added, which is why the
 * ALTER is explicit here rather than left to sync. Runs in runMigrations,
 * before sync and before bootstrap.
 *
 * ── Why this one speaks both engines ────────────────────────────────────────
 *
 * It used to be MySQL-only — `SHOW COLUMNS` plus MySQL column types — and sat
 * inside the `isMySQL` gate with the migrations that only ever walk an old
 * MySQL database forward. It does not belong with them. Those exist to catch a
 * legacy installation up; this one adds columns the CURRENT model requires, so
 * skipping it on Postgres does not leave a database merely un-modernised, it
 * leaves it unable to serve a request: the model declares passcode_hash, so
 * every `User.findByPk` selects a column that is not there.
 *
 * Production is Postgres and was populated by copying MySQL data across rather
 * than by `sync()`, so its `users` table predates these columns and nothing
 * else would ever add them. Worse, the old `SHOW COLUMNS` threw there and the
 * catch below read the throw as "no users table yet", so the skip was silent.
 *
 * Idempotent on both: each column is checked before it is added.
 */
const COLUMNS = [
  // [name, MySQL type, Postgres type]
  //
  // Neither list is a translation of the other. Postgres has no UNSIGNED at
  // all, and Sequelize maps DataTypes.DATE to TIMESTAMP WITH TIME ZONE there —
  // so these are the definitions sync() would have produced on each engine,
  // which is what keeps a migrated database identical to a freshly synced one.
  ['last_login_at', 'DATETIME NULL', 'TIMESTAMP WITH TIME ZONE NULL'],
  ['passcode_hash', 'VARCHAR(255) NULL', 'VARCHAR(255) NULL'],
  ['passcode_set_at', 'DATETIME NULL', 'TIMESTAMP WITH TIME ZONE NULL'],
  ['passcode_failed_attempts', 'INT UNSIGNED NOT NULL DEFAULT 0', 'INTEGER NOT NULL DEFAULT 0'],
  ['passcode_locked_until', 'DATETIME NULL', 'TIMESTAMP WITH TIME ZONE NULL'],
];

module.exports = async (sequelize) => {
  const users = q(sequelize, 'users');

  /**
   * information_schema, not SHOW COLUMNS — the latter is MySQL-only and was
   * the whole reason this migration was invisible on Postgres. columnsOf
   * returns null for a table it cannot read, which on a genuinely empty
   * database is correct: sync() creates `users` with every column, so there is
   * nothing here to add.
   */
  const present = await columnsOf(sequelize, 'users');
  if (!present) return;

  const added = [];
  for (const [name, mysqlType, postgresType] of COLUMNS) {
    if (present.has(name)) continue;
    // eslint-disable-next-line no-await-in-loop
    await sequelize.query(
      `ALTER TABLE ${users} ADD COLUMN ${q(sequelize, name)} `
      + `${isPostgres(sequelize) ? postgresType : mysqlType}`,
    );
    added.push(name);
  }

  /**
   * Existing users get last_login_at seeded from last_active_at.
   *
   * Otherwise every account would look as though it had never signed in, and
   * the passcode window — measured from the last full sign-in — would be
   * closed for everybody until they next used their password. Which is safe,
   * but needlessly so for someone who signed in a minute ago.
   *
   * Guarded on last_active_at actually being there. On MySQL an earlier
   * migration guarantees it; on a Postgres database carried over from
   * elsewhere nothing does, and the UPDATE would fail on a missing column and
   * take the whole boot with it.
   */
  if (added.includes('last_login_at') && present.has('last_active_at')) {
    await sequelize.query(
      `UPDATE ${users} SET last_login_at = last_active_at
        WHERE last_login_at IS NULL AND last_active_at IS NOT NULL`,
      { type: QueryTypes.UPDATE },
    );
  }

  if (added.length) console.log(`[users] added column(s): ${added.join(', ')}`);
};

const { QueryTypes } = require('sequelize');

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
 * Idempotent: each column is checked before it is added.
 */
const COLUMNS = [
  ['last_login_at', 'DATETIME NULL'],
  ['passcode_hash', 'VARCHAR(255) NULL'],
  ['passcode_set_at', 'DATETIME NULL'],
  ['passcode_failed_attempts', 'INT UNSIGNED NOT NULL DEFAULT 0'],
  ['passcode_locked_until', 'DATETIME NULL'],
];

module.exports = async (sequelize) => {
  let present;
  try {
    const rows = await sequelize.query('SHOW COLUMNS FROM `users`', { type: QueryTypes.SELECT });
    present = new Set(rows.map((r) => r.Field));
  } catch {
    // No users table yet — a genuinely empty database. sync creates it with
    // every column, so there is nothing to add.
    return;
  }

  const added = [];
  for (const [name, definition] of COLUMNS) {
    if (present.has(name)) continue;
    // eslint-disable-next-line no-await-in-loop
    await sequelize.query(`ALTER TABLE \`users\` ADD COLUMN \`${name}\` ${definition}`);
    added.push(name);
  }

  /**
   * Existing users get last_login_at seeded from last_active_at.
   *
   * Otherwise every account would look as though it had never signed in, and
   * the passcode window — measured from the last full sign-in — would be
   * closed for everybody until they next used their password. Which is safe,
   * but needlessly so for someone who signed in a minute ago.
   */
  if (added.includes('last_login_at')) {
    await sequelize.query(
      'UPDATE `users` SET last_login_at = last_active_at WHERE last_login_at IS NULL AND last_active_at IS NOT NULL',
      { type: QueryTypes.UPDATE },
    );
  }

  if (added.length) console.log(`[users] added column(s): ${added.join(', ')}`);
};

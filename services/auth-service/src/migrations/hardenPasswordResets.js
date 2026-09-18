const { isPostgres, columnsOf, q } = require('../../../../shared/src/dialect');

/**
 * Gives `password_resets` the two columns the reset flow needs to be safe.
 *
 * ── attempts ─────────────────────────────────────────────────────────────────
 *
 * The OTP is six digits and the row lived for ten minutes with nothing counting
 * wrong guesses. The per-IP limiter caps one source at ten a minute, which is
 * the right control for one attacker on one connection and no control at all
 * for a guess spread over many. A counter on the ROW bounds the total attempts
 * against a given reset, whoever makes them and from wherever.
 *
 * ── nonce ────────────────────────────────────────────────────────────────────
 *
 * The reset token was a bare JWT carrying { purpose, email }. resetPassword
 * verified the signature and nothing else, so within its five-minute window the
 * same token set the password as many times as it was replayed — the OTP row it
 * came from had already been consumed and was never consulted again. Binding
 * the token to a nonce stored on the row, and deleting the row on use, makes it
 * single-use in the only way that holds: the second attempt has nothing to
 * match against.
 *
 * Runs outside the isMySQL gate in index.js, because production is Postgres and
 * a reset flow that is safe on one engine and not the other is not safe.
 * Idempotent: each column is checked before it is added.
 */
const COLUMNS = [
  // [name, MySQL type, Postgres type]
  ['attempts', 'INT UNSIGNED NOT NULL DEFAULT 0', 'INTEGER NOT NULL DEFAULT 0'],
  ['nonce', 'VARCHAR(64) NULL', 'VARCHAR(64) NULL'],
];

module.exports = async (sequelize) => {
  const present = await columnsOf(sequelize, 'password_resets');
  // null means the table is not there yet; sync() creates it complete.
  if (!present) return;

  const table = q(sequelize, 'password_resets');
  const added = [];
  for (const [name, mysqlType, postgresType] of COLUMNS) {
    if (present.has(name)) continue;
    // eslint-disable-next-line no-await-in-loop
    await sequelize.query(
      `ALTER TABLE ${table} ADD COLUMN ${q(sequelize, name)} `
      + `${isPostgres(sequelize) ? postgresType : mysqlType}`,
    );
    added.push(name);
  }

  /*
   * Any reset in flight when this lands predates both columns, so it has no
   * attempt count and no nonce — and a token minted before the change carries
   * no nonce to match. Clearing them costs somebody at most one more "forgot
   * password" click and starts everyone on the new rules.
   */
  if (added.length) {
    await sequelize.query(`DELETE FROM ${table}`);
    console.log(`[auth] password_resets: added ${added.join(', ')}; cleared resets in flight`);
  }
};

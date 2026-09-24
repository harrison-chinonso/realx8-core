const { isPostgres, columnsOf, q } = require('../../../../shared/src/dialect');

/**
 * Remembers, on a refresh token, which accounts the password that minted it
 * actually opened.
 *
 * ── What it is for ──────────────────────────────────────────────────────────
 *
 * The accounts one person holds across companies each have their own password
 * now. Moving between them without signing in again is therefore only sound
 * for the ones the credential in hand has been shown to open — otherwise the
 * weakest password reaches all of them through a switch, and per-company
 * passwords become decoration.
 *
 * The access token carries that set, which is enough while it lasts. It lasts
 * an hour. Without somewhere durable to keep it, every hourly refresh would
 * forget which companies had been proved and start asking for a password to
 * switch into a company the person had been switching into freely all morning.
 *
 * ── Why it cannot be derived instead ────────────────────────────────────────
 *
 * The obvious alternative is to compare hashes: same password, same set. It
 * does not work, and it is worth writing down so nobody tries. bcrypt salts
 * every hash independently, so two rows holding the SAME password hold
 * different strings. There is nothing to compare, and the plaintext is gone by
 * the time a refresh arrives — which is the point of storing a hash at all.
 *
 * ── Empty is not the same as absent ─────────────────────────────────────────
 *
 * NULL means a token minted before this column existed, and is read as "only
 * its own account" — the safe answer, and the one that merely asks for a
 * password rather than refusing anything.
 */
const COLUMN = 'opened_accounts';

module.exports = async (sequelize) => {
  const present = await columnsOf(sequelize, 'refresh_tokens');
  // Null means the table is not there yet; sync creates it complete.
  if (!present || present.has(COLUMN)) return;

  await sequelize.query(
    `ALTER TABLE ${q(sequelize, 'refresh_tokens')} ADD COLUMN ${q(sequelize, COLUMN)} `
    + `${isPostgres(sequelize) ? 'TEXT NULL' : 'TEXT NULL'}`,
  );
  console.log(`[refresh_tokens] ${COLUMN} added — a switch knows which companies the password proved.`);
};

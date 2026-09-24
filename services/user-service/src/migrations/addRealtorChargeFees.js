const { columnsOf, quoteIdent, isPostgres } = require('../../../../shared/src/dialect');

/**
 * What a realtor pays to be verified, and to move up a level.
 *
 * ── Why the level fee is a column and the verification fee is a setting ─────
 *
 * There is one verification, so its price is one number per company and lives
 * with the other company settings. There are as many level-up prices as there
 * are levels, and they belong to the level the way its commission percentage
 * does — Bronze to Silver is not worth the same as Gold to Platinum, and a
 * single company-wide figure could not say so.
 *
 * ── Minor units ────────────────────────────────────────────────────────────
 *
 * Kobo, like every other amount written since the money module landed.
 * commission_percentage beside it is a DECIMAL because it is a rate; this is
 * cash, and cash in this codebase is an integer.
 *
 * user-service syncs with { force: false }, so the column is added here rather
 * than by the model. Idempotent, and written for both engines: production is
 * Postgres and the older migrations beside this one are MySQL-only.
 */
const TABLE = 'realtor_levels';
const COLUMN = 'levelup_fee_minor';

module.exports = async function addRealtorChargeFees(sequelize) {
  /**
   * Null means the table is not there — a brand new database, where this runs
   * before sync() and sync will create `realtor_levels` complete from the
   * model. Nothing to add, and nothing wrong.
   *
   * It was `.catch(() => new Map())`, which handles a THROW and not a null, so
   * `columns.size` threw a TypeError instead. That never surfaced while this
   * migration was behind the MySQL gate, because by then the table always
   * existed. Moving it onto the path every database takes is what made an
   * empty one reachable — and a throw here is a boot that does not finish.
   */
  const columns = await columnsOf(sequelize, TABLE).catch(() => null);
  if (!columns || !columns.size || columns.has(COLUMN)) return;

  const bigint = isPostgres(sequelize) ? 'BIGINT' : 'BIGINT';
  await sequelize.query(
    `ALTER TABLE ${quoteIdent(sequelize, TABLE)}
       ADD COLUMN ${quoteIdent(sequelize, COLUMN)} ${bigint} NOT NULL DEFAULT 0`,
  ).catch((error) => {
    // Two workers can race this on boot; a duplicate means the other won.
    if (!/duplicate column|already exists/i.test(error.message)) throw error;
  });
  console.log(`[migration] ${TABLE}.${COLUMN} added`);
};

const { columnsOf, quoteIdent, isPostgres, isDuplicateError } = require('../../../../shared/src/dialect');

/**
 * What a realtor at this level earns, as a percentage.
 *
 * ── Why it is added here and not by the model ───────────────────────────────
 *
 * user-service syncs with { force: false }, which creates a MISSING table but
 * never adds a column to one that already exists. So a new attribute on the
 * model appears on a database built by sync and is silently absent on every
 * database that predates it — and then every read of a level selects a column
 * that is not there.
 *
 * ── Why it now speaks both engines ──────────────────────────────────────────
 *
 * It did not, and it lived inside the isMySQL gate with the migrations that
 * exist only to walk an old MySQL installation forward. It does not belong
 * with them: those leave a database merely un-modernised when skipped, while
 * this one leaves it unable to serve a request.
 *
 * Its SQL had four MySQL-isms, each fatal on Postgres rather than merely
 * wrong: DATABASE(), which Postgres spells current_schema(); backtick quoting;
 * an `AFTER position` clause, which Postgres has no equivalent for and does
 * not need, because column order is cosmetic; and a duplicate-column check
 * that matched MySQL's wording only, so a genuine race on Postgres would have
 * been rethrown as a boot failure.
 *
 * This is the same shape as addRealtorChargeFees beside it, for the same
 * reason — that one was found when a level-up fee could not be configured on
 * Postgres, and this column would have been the next to be missed.
 */
const TABLE = 'realtor_levels';
const COLUMN = 'commission_percentage';

module.exports = async function addLevelCommission(sequelize) {
  /*
   * Null means the table is not there at all — a brand new database, where
   * this runs before sync() and sync will create `realtor_levels` complete
   * from the model. Nothing to add, and nothing wrong. Distinguished from an
   * empty Map deliberately: reading `.size` off null is a TypeError, and a
   * throw on a boot path is a service that does not start.
   */
  const columns = await columnsOf(sequelize, TABLE).catch(() => null);
  if (!columns || !columns.size || columns.has(COLUMN)) return;

  /*
   * NUMERIC and DECIMAL are the same type in both engines; the name is spelled
   * out per engine anyway so this reads as what each would have produced.
   */
  const type = isPostgres(sequelize) ? 'NUMERIC(5,2)' : 'DECIMAL(5,2)';

  await sequelize.query(
    `ALTER TABLE ${quoteIdent(sequelize, TABLE)}
       ADD COLUMN ${quoteIdent(sequelize, COLUMN)} ${type} NOT NULL DEFAULT 0`,
  ).catch((error) => {
    // Two workers can race this on boot; a duplicate means the other won.
    if (!isDuplicateError(error) && !/duplicate column|already exists/i.test(error.message)) throw error;
  });

  console.log(`[migration] ${TABLE}.${COLUMN} added`);
};

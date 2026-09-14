const { QueryTypes } = require('sequelize');
const {
  isPostgres, tableExists, columnsOf, quoteIdent, enumTypeName,
} = require('../../../../shared/src/dialect');

/**
 * Let a flat-rate rule target ANY realtor level, not three hardcoded names.
 *
 * `commission_rules.realtor_category` was an ENUM of
 * ('premium','professional','basic','any'), and the generator matched a
 * realtor's LEVEL NAME lowercased against it. So a company whose ladder is
 * Basic / Professional / Premium / Ambassador could write a rule for three of
 * its four levels; Ambassador could only ever match an 'any' rule. So could
 * every level of every company that had renamed theirs — "Gold", "Platinum",
 * "Associate" — which is most of them.
 *
 * Two changes:
 *
 *   - the column becomes free text, so any level name is expressible and
 *     'any' keeps its meaning as the catch-all
 *   - a `realtor_level_id` is added and matched FIRST, so a rule follows a
 *     level through a rename rather than silently detaching from it
 *
 * Existing rows are backfilled by name where a level matches, which is exactly
 * what the old code was doing implicitly — so a rule written for "premium"
 * keeps applying to the Premium level, now by id.
 *
 * Idempotent on both engines: each step checks its own state first.
 */
module.exports = async (sequelize) => {
  if (!await tableExists(sequelize, 'commission_rules')) return;

  const pg = isPostgres(sequelize);
  const table = quoteIdent(sequelize, 'commission_rules');
  const column = quoteIdent(sequelize, 'realtor_category');

  const columns = await columnsOf(sequelize, 'commission_rules');

  // ── 1. ENUM -> free text ──────────────────────────────────────────────────
  const type = String(columns?.get('realtor_category')?.type || '').toLowerCase();
  const stillEnum = pg ? !type.includes('character varying') && !type.includes('text')
    : type.startsWith('enum');

  if (stillEnum) {
    if (pg) {
      const enumName = await enumTypeName(sequelize, 'commission_rules', 'realtor_category');
      await sequelize.query(
        `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE VARCHAR(64) USING ${column}::text`,
      );
      await sequelize.query(`ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT 'any'`);
      /**
       * The old type is dropped only if nothing else uses it. A shared enum
       * type is possible on a database carried across from MySQL, and dropping
       * one still referenced would take the other column down with it.
       */
      if (enumName) {
        await sequelize.query(`DROP TYPE IF EXISTS ${quoteIdent(sequelize, enumName)}`)
          .catch(() => {});
      }
    } else {
      await sequelize.query(
        `ALTER TABLE ${table} MODIFY ${column} VARCHAR(64) NOT NULL DEFAULT 'any'`,
      );
    }
    console.log('[commission_rules] realtor_category opened to any level name');
  }

  // ── 2. Match by level id, which survives a rename ─────────────────────────
  if (!columns?.has('realtor_level_id')) {
    await sequelize.query(
      `ALTER TABLE ${table} ADD COLUMN ${quoteIdent(sequelize, 'realtor_level_id')} `
      + `${pg ? 'INTEGER' : 'INT UNSIGNED'} NULL`,
    );
    console.log('[commission_rules] realtor_level_id added');
  }

  if (!await tableExists(sequelize, 'realtor_levels')) return;

  /**
   * Backfill by name, case-insensitively, and only where exactly one level
   * matches. Two levels sharing a name across the global and company ladders
   * would make the choice a guess, and a rule pointed at the wrong level pays
   * the wrong people — leaving it NULL keeps the old name-matching behaviour
   * for that row, which is no worse than before.
   */
  const [, claimed] = await sequelize.query(
    `UPDATE commission_rules r
        SET realtor_level_id = (
          SELECT MIN(l.id) FROM realtor_levels l
           WHERE LOWER(l.name) = LOWER(r.realtor_category)
             AND (l.company_id IS NULL OR l.company_id = r.company_id)
        )
      WHERE r.realtor_level_id IS NULL
        AND LOWER(r.realtor_category) <> 'any'
        AND (
          SELECT COUNT(*) FROM realtor_levels l
           WHERE LOWER(l.name) = LOWER(r.realtor_category)
             AND (l.company_id IS NULL OR l.company_id = r.company_id)
        ) = 1`,
    { type: QueryTypes.UPDATE },
  );

  if (claimed) console.log(`[commission_rules] ${claimed} rule(s) bound to a level by id`);
};

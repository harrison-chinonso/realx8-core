const { QueryTypes } = require('sequelize');
const {
  indexExists, addUniqueIndex, dropIndex, isPostgres, tableExists, q,
} = require('../../../../shared/src/dialect');

/**
 * A property type's name belongs to a company, not to the platform.
 *
 * ── The bug ─────────────────────────────────────────────────────────────────
 *
 * `property_types.name` was UNIQUE across the whole table. Every company keeps
 * its own list — the listing, the getOne, the update and the delete are all
 * company-scoped — so the one thing that was NOT scoped was the constraint.
 * The first company to create "Land" claimed the word platform-wide, and the
 * next company to try it was refused.
 *
 * What that looked like on the screen is the reason it went unrecognised for so
 * long: the refusal named a row the caller has no way to see. A company whose
 * Property Types page listed four names, none of them "Land", typed "Land",
 * saved, and was told the name already existed. Nothing visible contradicted
 * them, so it read as the feature being broken rather than as a collision.
 *
 * ── The fix ─────────────────────────────────────────────────────────────────
 *
 * Uniqueness moves to (company_id, name): the same name may appear once in each
 * company, and never twice in one. That is what the scoped reads have always
 * implied.
 *
 * ── The NULL the index cannot see ───────────────────────────────────────────
 *
 * Both engines treat NULLs as distinct in a unique index, so two rows with a
 * NULL company_id and the same name would no longer collide. company_id is NULL
 * only for platform-level rows that predate multi-tenancy. A functional index
 * over COALESCE(company_id, 0) would close it in the database and is
 * deliberately not used — MySQL has only supported those since 8.0.13, and this
 * runs on installations older than that. The controller carries the rule
 * instead, where it can also produce a message worth reading; this index is the
 * floor under it, holding against a direct INSERT, an import or a restore.
 */
const COMPANY_UNIQUE = 'property_types_company_name_unique';

/**
 * The global indexes this supersedes, by every name they have been created
 * under. Sequelize names an inline `unique: true` after the column; Postgres
 * names a table-level UNIQUE `<table>_<column>_key`. Both are listed rather
 * than only discovered, because an index left behind keeps the whole change
 * inert — the second company is still refused, by an index nobody remembered.
 */
const SUPERSEDED = ['name', 'property_types_name_unique', 'property_types_name_key'];

/** Every unique index on this table that covers exactly the `name` column. */
const globalUniquesOnName = async (sequelize) => {
  const rows = isPostgres(sequelize)
    ? await sequelize.query(
      `SELECT i.relname AS name
         FROM pg_index x
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_class t ON t.oid = x.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = CURRENT_SCHEMA() AND t.relname = 'property_types'
          AND x.indisunique AND x.indnatts = 1
          AND pg_get_indexdef(x.indexrelid) LIKE '%(name)%'`,
      { type: QueryTypes.SELECT },
    )
    : await sequelize.query(
      `SELECT index_name AS name FROM information_schema.statistics s
        WHERE s.table_schema = DATABASE() AND s.table_name = 'property_types'
          AND s.non_unique = 0 AND s.column_name = 'name'
          AND (SELECT COUNT(*) FROM information_schema.statistics c
                WHERE c.table_schema = s.table_schema AND c.table_name = s.table_name
                  AND c.index_name = s.index_name) = 1`,
      { type: QueryTypes.SELECT },
    );
  return rows.map((row) => row.name).filter((name) => name !== 'PRIMARY');
};

module.exports = async (sequelize) => {
  try {
    // Runs before sync, so on a brand-new database there is nothing here yet.
    // sync creates the table; the next boot adds the index to it.
    if (!(await tableExists(sequelize, 'property_types'))) return;

    /*
     * The composite index goes on FIRST. Dropping the global one first would
     * leave a window — on a boot path, the width of one CREATE INDEX — in which
     * nothing prevents two identical names inside one company. Adding first
     * means the table is never less constrained than it was.
     */
    if (!(await indexExists(sequelize, 'property_types', COMPANY_UNIQUE))) {
      /*
       * Rows that would refuse it. Under the global index there cannot be any,
       * but this also runs on databases restored from elsewhere, and a failed
       * CREATE on a boot path stops the service.
       */
      const clashes = await sequelize.query(
        `SELECT ${q(sequelize, 'name')}, company_id, COUNT(*) AS n FROM property_types
          GROUP BY ${q(sequelize, 'name')}, company_id HAVING COUNT(*) > 1 LIMIT 5`,
        { type: QueryTypes.SELECT },
      );
      if (clashes.length) {
        console.warn(
          `[property] NOT adding ${COMPANY_UNIQUE}: ${clashes.length} name(s) already appear `
          + 'twice inside one company.\n'
          + clashes.map((row) => `    ${row.name} in company ${row.company_id ?? 'platform'}`).join('\n')
          + '\n    Resolve the duplicates, then restart.',
        );
        return;
      }
      await addUniqueIndex(sequelize, 'property_types', ['company_id', 'name'], COMPANY_UNIQUE);
      console.log(`[property] ${COMPANY_UNIQUE} added — a type name is now unique within a company.`);
    }

    const names = [...new Set([...SUPERSEDED, ...await globalUniquesOnName(sequelize)])]
      .filter((name) => name !== COMPANY_UNIQUE);

    for (const name of names) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await indexExists(sequelize, 'property_types', name))) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await dropIndex(sequelize, 'property_types', name);
        console.log(`[property] dropped global unique index ${name} on property_types.name.`);
      } catch (error) {
        // Reported rather than fatal — the composite index is already in place.
        console.warn(`[property] could not drop ${name}: ${error.message}`);
      }
    }
  } catch (error) {
    console.warn(`[property] could not rework the property type uniqueness: ${error.message}`);
  }
};

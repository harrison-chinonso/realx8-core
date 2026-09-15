const { QueryTypes } = require('sequelize');
const { q, columnsOf, tableExists } = require('./dialect');

/**
 * Attaching rows that lost their company to the one they obviously belong to.
 *
 * ── How rows end up with no company ─────────────────────────────────────────
 *
 * `withCompanyAudit` derives the company from the REQUESTER. A platform admin
 * has none of their own, so anything they created was stored with company_id
 * NULL — and code paths written before company scoping was enforced did the
 * same. The row is then invisible to every company-scoped read: it is not
 * partially broken, it is entirely absent. A paid invoice missing from the
 * revenue report, a lead missing from the pipeline, and nothing anywhere says
 * why.
 *
 * ── Evidence, never a guess ─────────────────────────────────────────────────
 *
 * Each table names the columns that can prove ownership, in order of how
 * directly they prove it — an invoice's client before its property, a lead's
 * assignee before its creator. A row whose sources all come back NULL is LEFT
 * ALONE and reported: which company an unattributable row belongs to is a
 * question only a person can answer, and attaching it to the wrong tenant is
 * worse than leaving it invisible. That is the same direction
 * requireCompanyForClients takes, for the same reason.
 *
 * ── Only NULL is ever written over ──────────────────────────────────────────
 *
 * Every statement carries `WHERE company_id IS NULL`. A row that already names
 * a company is never re-derived, so this cannot move data between tenants — the
 * one failure that would be unrecoverable, because afterwards nothing records
 * where it used to be.
 */

/**
 * @param {object} sequelize
 * @param {object} spec
 * @param {string} spec.table
 * @param {Array}  spec.sources  [{ join, on, column, label }] in priority order
 * @param {string} [spec.label]  what to call these rows in the log
 */
const backfillCompany = async (sequelize, { table, sources, label = null }) => {
  const name = label || table;

  if (!(await tableExists(sequelize, table))) return { table, skipped: 'no_such_table' };
  const columns = await columnsOf(sequelize, table);
  if (!columns || !columns.has('company_id')) return { table, skipped: 'no_company_column' };

  const target = q(sequelize, table);

  const [before] = await sequelize.query(
    `SELECT COUNT(*) AS n FROM ${target} WHERE company_id IS NULL`,
    { type: QueryTypes.SELECT },
  );
  const orphans = Number(before?.n) || 0;
  if (!orphans) return { table, orphans: 0, fixed: 0, remaining: 0 };

  let fixed = 0;

  for (const source of sources) {
    /**
     * A correlated subquery rather than an UPDATE ... JOIN.
     *
     * Postgres has no UPDATE ... JOIN, and the MySQL-only form is exactly the
     * shape lint:sql exists to catch — a statement that works in development
     * and fails in production. This runs on both.
     */
    // eslint-disable-next-line no-await-in-loop
    const [, metadata] = await sequelize.query(
      `UPDATE ${target} AS t
          SET company_id = (
            SELECT s.${source.column} FROM ${q(sequelize, source.join)} s
             WHERE s.id = t.${source.on} AND s.${source.column} IS NOT NULL
             LIMIT 1
          )
        WHERE t.company_id IS NULL
          AND t.${source.on} IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM ${q(sequelize, source.join)} s2
             WHERE s2.id = t.${source.on} AND s2.${source.column} IS NOT NULL
          )`,
      { type: QueryTypes.UPDATE },
    ).catch((error) => {
      /**
       * A duplicate-key failure here is not a bug — it is a real conflict that
       * needs a person.
       *
       * References are unique WITHIN a company. A row created before company
       * scoping may carry a number the company has since reissued, so attaching
       * it would collide. Renumbering it silently is not an option: a reference
       * can be on a receipt somebody holds, and changing it breaks the link
       * between their document and ours.
       *
       * Sequelize reports this as "Validation error", which says nothing. The
       * underlying driver message names the index and the value, so that is
       * what gets printed.
       */
      const duplicate = error?.name === 'SequelizeUniqueConstraintError'
        || error?.original?.code === 'ER_DUP_ENTRY'
        || error?.parent?.code === 'ER_DUP_ENTRY';

      if (duplicate) {
        const detail = error?.original?.sqlMessage || error?.parent?.message || error.message;
        console.warn(
          `[backfill] ${name}: cannot attach some rows via ${source.label || source.join} — `
          + `their reference is already used by that company.\n    ${detail.split('\n')[0]}\n`
          + '    Renumber them, or leave them, but do not let this run guess.',
        );
      } else {
        console.warn(`[backfill] ${name} via ${source.label || source.join}: ${error.message.split('\n')[0]}`);
      }
      return [null, null];
    });

    const moved = Number(metadata?.rowCount ?? metadata?.affectedRows ?? metadata ?? 0);
    if (moved) {
      fixed += moved;
      console.log(`[backfill] ${name}: ${moved} row(s) attached via ${source.label || source.join}`);
    }
  }

  const [after] = await sequelize.query(
    `SELECT COUNT(*) AS n FROM ${target} WHERE company_id IS NULL`,
    { type: QueryTypes.SELECT },
  );
  const remaining = Number(after?.n) || 0;

  /**
   * What could not be resolved is REPORTED, not hidden. An operator who sees
   * "3 could not be attributed" can go and look; one who sees nothing assumes
   * the job did everything.
   */
  if (remaining) {
    console.warn(
      `[backfill] ${name}: ${remaining} row(s) still have no company — nothing on them says which. `
      + 'Attach them by hand, or leave them if they are genuinely platform-level.',
    );
  }

  return { table, orphans, fixed, remaining };
};

module.exports = { backfillCompany };

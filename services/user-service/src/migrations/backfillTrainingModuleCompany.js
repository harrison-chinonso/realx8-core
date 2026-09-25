const { QueryTypes } = require('sequelize');
const {
  isPostgres, tableExists, columnsOf, quoteIdent,
} = require('../../../../shared/src/dialect');

/**
 * Add training_modules.company_id, and give every existing module the company
 * it was always implicitly part of.
 *
 * `training_modules` had no company_id, so there is nothing recorded to
 * migrate — the only evidence of who a module belongs to is its author, and
 * the author's company is taken as the module's. Same reasoning, and same
 * shape, as backfillMediaPostCompany.
 *
 * ── The column is added HERE, not by sync ───────────────────────────────────
 *
 * user-service syncs with `{ force: false }`, which creates missing TABLES but
 * never adds a column to one that already exists. A new attribute on the
 * TrainingModule model therefore appears on a fresh database and is silently
 * absent on every existing one — and the listing now filters on company_id,
 * so the first request would fail with "Unknown column" rather than merely
 * showing the wrong rows.
 *
 * ── Why this has to run, and run before the scoping takes effect ────────────
 *
 * The listing now filters on company_id. Without a backfill every row would be
 * NULL, which is not "company-scoped" under the new rule but "visible to
 * everyone, as if a platform admin had published it" — the opposite of what
 * switching the scope on is meant to do.
 *
 * ── Only NULLs, and only from an author who still exists ────────────────────
 *
 * Idempotent: a second run has nothing left to claim. It never overwrites a
 * company_id that is already set, because after the first run those are
 * deliberate — including any a platform admin has since moved.
 *
 * Modules whose author is gone, or whose author had no company, keep NULL —
 * which leaves them platform-wide rather than orphaned, since that is the
 * closest honest reading of "we do not know whose company this was".
 */
module.exports = async (sequelize) => {
  if (!await tableExists(sequelize, 'training_modules')) return;
  if (!await tableExists(sequelize, 'users')) return;

  const pg = isPostgres(sequelize);
  const columns = await columnsOf(sequelize, 'training_modules');

  if (!columns?.has('company_id')) {
    /**
     * The definition sync() would have produced on each engine — Postgres has
     * no UNSIGNED — so a migrated database ends up identical to a fresh one.
     */
    await sequelize.query(
      `ALTER TABLE ${quoteIdent(sequelize, 'training_modules')} `
      + `ADD COLUMN ${quoteIdent(sequelize, 'company_id')} `
      + `${pg ? 'INTEGER' : 'INT UNSIGNED'} NULL`,
    );
    console.log('[training_modules] company_id added');
  }

  const [, claimed] = await sequelize.query(
    `UPDATE training_modules m
        SET company_id = (
          SELECT u.company_id FROM users u
           WHERE u.id = m.created_by AND u.company_id IS NOT NULL
        )
      WHERE m.company_id IS NULL
        AND m.created_by IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM users u
           WHERE u.id = m.created_by AND u.company_id IS NOT NULL
        )`,
    { type: QueryTypes.UPDATE },
  );

  if (claimed) {
    console.log(`[training_modules] ${claimed} module(s) attributed to their author's company`);
  }
};

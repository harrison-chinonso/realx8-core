 const { QueryTypes } = require('sequelize');
const {
  isPostgres, tableExists, columnsOf, quoteIdent,
} = require('../../../../shared/src/dialect');

/**
 * Add media_posts.company_id, and give every existing post the company it was
 * always implicitly part of.
 *
 * `media_posts` had no company_id, so there is nothing recorded to migrate —
 * the only evidence of who a post belongs to is its author, and the author's
 * company is taken as the post's.
 *
 * ── The column is added HERE, not by sync ───────────────────────────────────
 *
 * user-service syncs with `{ force: false }`, which creates missing TABLES but
 * never adds a column to one that already exists. A new attribute on the
 * MediaPost model therefore appears on a fresh database and is silently absent
 * on every existing one — and the listing now filters on company_id, so the
 * first request would fail with "Unknown column" rather than merely showing
 * the wrong rows. Same reasoning as addPasscodeColumns.
 *
 * ── Why this has to run, and run before the scoping takes effect ────────────
 *
 * The listing now filters on company_id. Without a backfill every row would be
 * NULL, which is not "visible to everyone" under the new rule but visible to
 * nobody except a platform admin — so switching the scope on without this would
 * look exactly like every company's posts having been deleted.
 *
 * ── Only NULLs, and only from an author who still exists ────────────────────
 *
 * Idempotent: a second run has nothing left to claim. It never overwrites a
 * company_id that is already set, because after the first run those are
 * deliberate — including any a platform admin has since moved.
 *
 * Posts whose author is gone, or whose author had no company, keep NULL. They
 * cannot be attributed from the data that survives, and guessing would put one
 * company's work in another company's list. The count is reported rather than
 * passed over, because "some posts are visible only to platform admins" is
 * something somebody has to be told once.
 */
module.exports = async (sequelize) => {
  if (!await tableExists(sequelize, 'media_posts')) return;
  if (!await tableExists(sequelize, 'users')) return;

  const pg = isPostgres(sequelize);
  const columns = await columnsOf(sequelize, 'media_posts');

  if (!columns?.has('company_id')) {
    /**
     * The definition sync() would have produced on each engine — Postgres has
     * no UNSIGNED — so a migrated database ends up identical to a fresh one.
     */
    await sequelize.query(
      `ALTER TABLE ${quoteIdent(sequelize, 'media_posts')} `
      + `ADD COLUMN ${quoteIdent(sequelize, 'company_id')} `
      + `${pg ? 'INTEGER' : 'INT UNSIGNED'} NULL`,
    );
    console.log('[media_posts] company_id added');
  }

  const [, claimed] = await sequelize.query(
    `UPDATE media_posts p
        SET company_id = (
          SELECT u.company_id FROM users u
           WHERE u.id = p.created_by AND u.company_id IS NOT NULL
        )
      WHERE p.company_id IS NULL
        AND p.created_by IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM users u
           WHERE u.id = p.created_by AND u.company_id IS NOT NULL
        )`,
    { type: QueryTypes.UPDATE },
  );

  const [{ orphans }] = await sequelize.query(
    'SELECT COUNT(*) AS orphans FROM media_posts WHERE company_id IS NULL',
    { type: QueryTypes.SELECT },
  );

  if (claimed) {
    console.log(`[media_posts] ${claimed} post(s) attributed to their author's company`);
  }
  if (Number(orphans) > 0) {
    console.warn(`[media_posts] ${orphans} post(s) have no company and are now visible only to `
      + 'platform admins — their author was deleted or had no company');
  }
};

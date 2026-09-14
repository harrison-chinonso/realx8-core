const { setDeleteRule } = require('../../../../shared/src/foreignKeyRule');

/**
 * Stop a company's published work being deleted with the person who wrote it.
 *
 * `media_posts.created_by` referenced `users.id` ON DELETE CASCADE, so removing
 * a user removed every post they had authored — including published ones, with
 * their reach, impressions and engagement figures, and the platform post ids
 * that tie them to what is live on Facebook or Instagram. A staff member leaves,
 * somebody tidies up their account, and a year of the company's social output
 * disappears along with the only record of what was posted where.
 *
 * ── SET NULL, and why the post is worth more than the attribution ───────────
 *
 * `created_by` is nullable and the listing already renders a missing author as
 * "—", so a post without one still reads correctly. The alternative, RESTRICT,
 * would refuse to delete any user who had ever drafted a post — which turns a
 * data-retention decision into an unexplained failure at the point somebody
 * tries to remove an account.
 *
 * ── reviewed_by is changed too, and not as scope creep ──────────────────────
 *
 * It was NO ACTION, which InnoDB enforces as RESTRICT: deleting a user who had
 * ever approved a post was already blocked. Fixing only `created_by` would
 * leave user deletion failing anyway, on a different constraint, and the fix
 * would look as though it had not worked. Both now behave the same way.
 *
 * Idempotent on both engines — it reads the current rule and does nothing when
 * it is already right. See shared/src/foreignKeyRule.js.
 */
module.exports = async (sequelize) => {
  for (const column of ['created_by', 'reviewed_by']) {
    // eslint-disable-next-line no-await-in-loop
    const result = await setDeleteRule(sequelize, {
      table: 'media_posts',
      column,
      references: 'users',
      rule: 'SET NULL',
    });
    if (result.changed) {
      console.log(`[media_posts] ${column} no longer ${result.from} — a post now `
        + 'survives the deletion of the person it points at');
    }
  }
};

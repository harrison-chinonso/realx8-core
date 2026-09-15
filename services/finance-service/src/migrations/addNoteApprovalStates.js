const { columnsOf, widenEnum, quoteIdent, q } = require('../../../../shared/src/dialect');

/**
 * Opens credit and debit notes up to an approval lifecycle.
 *
 * The status used to be whatever the person raising the note typed, defaulting
 * to `draft`. Since a credit note writes off money owed to the company and a
 * debit note creates money owed out of it, that let one person move money with
 * their own say-so. Approval is now a separate action requiring a separate
 * permission, which needs three new states — `pending_approval`, `approved`,
 * `rejected` — and a new default.
 *
 * ── Why the enum has to be widened by hand ──────────────────────────────────
 *
 * finance-service syncs with { alter: true }, which adds missing COLUMNS. It
 * does not reliably rewrite an existing enum's members, and on Postgres the
 * enum is a separate type that has to be altered with ADD VALUE. Without this,
 * every insert of a `pending_approval` note fails on a constraint whose message
 * says nothing about approval.
 *
 * ── The old states are kept ─────────────────────────────────────────────────
 *
 * `draft`, `sent` and `partial` stay in the enum. Nothing new is created in
 * them, but narrowing an enum destroys any row that holds a removed value, and
 * a migration that deletes financial documents to tidy a type is not a trade
 * worth making — even on a database where the tables happen to be empty today.
 */

module.exports = async (sequelize) => {
  const tables = [
    { table: 'credit_notes', settled: 'used' },
    { table: 'debit_notes', settled: 'paid' },
  ];

  for (const { table, settled } of tables) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const columns = await columnsOf(sequelize, table);
      if (!columns || !columns.has('status')) continue;

      // eslint-disable-next-line no-await-in-loop
      const added = await widenEnum(sequelize, table, 'status', [
        'pending_approval', 'approved', 'rejected',
        'draft', 'sent', 'partial', settled, 'cancelled',
      ], { defaultValue: 'pending_approval' });

      if (added.length) console.log(`[finance] ${table}.status: added ${added.join(', ')}`);

      /**
       * The default has to be set on Postgres separately — widenEnum's
       * defaultValue only reaches MySQL, where the whole column is rewritten in
       * one MODIFY. Without it a note inserted without a status would land as
       * `draft` and bypass approval entirely, which is the one outcome this
       * whole change exists to prevent.
       */
      // eslint-disable-next-line no-await-in-loop
      await sequelize.query(
        `ALTER TABLE ${quoteIdent(sequelize, table)} ALTER COLUMN ${quoteIdent(sequelize, 'status')} SET DEFAULT 'pending_approval'`,
      ).catch(() => {});

      /**
       * Anything still sitting in `draft` has not been acted on, so it belongs
       * in the queue rather than in a state nothing can now advance. `sent`,
       * `partial` and settled rows are left alone — those represent notes that
       * were already acted on under the old rules, and re-opening them for
       * approval would ask somebody to sign off on money that has moved.
       */
      // eslint-disable-next-line no-await-in-loop
      await sequelize.query(
        `UPDATE ${q(sequelize, table)} SET status = 'pending_approval' WHERE status = 'draft'`,
      );
    } catch (error) {
      console.warn(`[finance] ${table} approval states skipped:`, error.message);
    }
  }
};

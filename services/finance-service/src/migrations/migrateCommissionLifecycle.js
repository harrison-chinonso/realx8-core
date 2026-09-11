const { QueryTypes } = require('sequelize');
const {
  isPostgres, columnsOf, enumValues, widenEnum, narrowEnum, quoteIdent,
} = require('../../../../shared/src/dialect');

/**
 * Brings existing commissions and transactions onto the new shape.
 *
 * Runs BEFORE sync, because both changes alter an ENUM that already has rows
 * against it.
 *
 * ── Why this one is NOT gated to MySQL ───────────────────────────────────────
 *
 * Most of the raw-SQL migrations in this service exist only to walk an old
 * MySQL installation forward, and are correctly skipped on Postgres, where
 * `sequelize.sync()` builds the right schema from the models.
 *
 * This one is different, and the difference is the whole reason it was
 * rewritten. The production Postgres database was not created by sync() from a
 * clean slate — it was populated by copying the MySQL data across, so it
 * carries the OLD vocabulary: rows whose status is `pending`, and an enum type
 * that predates `created`. sync() does not reconcile either, because Postgres
 * models an enum as a TYPE and Sequelize will not add values to a type that
 * already exists.
 *
 * Skipping it there produced exactly the reported failure:
 *
 *     invalid input value for enum enum_commision_status: "pending"
 *
 * Note the type name in that error is not `enum_commissions_status` — a
 * database carried forward can have a type named after an older spelling of
 * the table. That is why the helpers look the type name UP rather than
 * constructing it from the table and column.
 *
 * Idempotent on both engines: each step checks the state it is about to change.
 */

/** The vocabulary a commission's status may use, after this migration. */
const STATUSES = ['created', 'payment_requested', 'approved', 'paid', 'cancelled'];

module.exports = async (sequelize) => {
  // ── commissions.status: pending -> created ────────────────────────────────
  const commissionColumns = await columnsOf(sequelize, 'commissions');
  if (commissionColumns?.has('status')) {
    const values = await enumValues(sequelize, 'commissions', 'status');

    if (values.includes('pending')) {
      /**
       * Widen, move, narrow — in that order, on both engines.
       *
       * Renaming in one step would reject the very rows being migrated, since
       * for the duration of the statement both vocabularies have to be legal.
       * On Postgres the widening is `ALTER TYPE ... ADD VALUE`, which cannot be
       * undone, so the narrowing afterwards is what actually retires `pending`.
       */
      await widenEnum(sequelize, 'commissions', 'status', ['pending', ...STATUSES], {
        defaultValue: 'created',
      });

      const [, moved] = await sequelize.query(
        "UPDATE commissions SET status = 'created' WHERE status = 'pending'",
        { type: QueryTypes.UPDATE },
      );

      await narrowEnum(sequelize, 'commissions', 'status', STATUSES, { defaultValue: 'created' });
      console.log(`[commissions] status pending -> created for ${moved ?? 0} row(s)`);
    } else {
      /**
       * No `pending` left, but the type may still be missing values the models
       * now use — the case on a database copied across while the vocabulary was
       * mid-change. Widening is safe and does nothing when there is nothing to
       * add.
       */
      const added = await widenEnum(sequelize, 'commissions', 'status', STATUSES, {
        defaultValue: 'created',
      });
      if (added.length) console.log(`[commissions] status accepts ${added.join(', ')}`);
    }
  }

  // ── transactions.entry_type ───────────────────────────────────────────────
  const transactionColumns = await columnsOf(sequelize, 'transactions');
  if (transactionColumns && !transactionColumns.has('entry_type')) {
    if (isPostgres(sequelize)) {
      // The column needs a type to be declared as, and the type has to exist
      // first — Postgres has no inline ENUM the way MySQL does.
      await sequelize.query(`DO $$ BEGIN
        CREATE TYPE enum_transactions_entry_type AS ENUM ('credit','debit');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
      await sequelize.query(
        `ALTER TABLE ${quoteIdent(sequelize, 'transactions')}
         ADD COLUMN ${quoteIdent(sequelize, 'entry_type')} enum_transactions_entry_type
         NOT NULL DEFAULT 'credit'`,
      );
    } else {
      await sequelize.query(
        "ALTER TABLE transactions ADD COLUMN entry_type ENUM('credit','debit') NOT NULL DEFAULT 'credit'",
      );
    }

    /**
     * Existing rows are backfilled from what their `type` says.
     *
     * Everything recorded so far is money coming in — invoice payments — so
     * credit is the right default. The known outgoing types are corrected
     * explicitly rather than left to the default, so a ledger total is right
     * immediately rather than after someone notices.
     */
    const [, corrected] = await sequelize.query(
      `UPDATE transactions SET entry_type = 'debit'
        WHERE type IN ('commission_payout', 'refund', 'payout', 'withdrawal')`,
      { type: QueryTypes.UPDATE },
    );
    console.log(`[transactions] entry_type added; ${corrected ?? 0} existing row(s) marked debit`);
  }
};

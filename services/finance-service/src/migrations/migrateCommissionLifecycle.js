const { QueryTypes } = require('sequelize');

/**
 * Brings existing commissions and transactions onto the new shape.
 *
 * Runs BEFORE sync, because both changes alter an ENUM that already has rows
 * against it. Sequelize's sync would widen the column but leave `pending`
 * values behind — and `pending` is not in the new set, so every one of them
 * would read back as an empty string under a non-strict sql_mode.
 *
 * Idempotent: each step checks the state it is about to change.
 */
const columns = async (sequelize, table) => {
  try {
    const rows = await sequelize.query(`SHOW COLUMNS FROM ${table}`, { type: QueryTypes.SELECT });
    return new Map(rows.map((r) => [r.Field, r.Type]));
  } catch {
    return null; // table not created yet — a fresh database
  }
};

module.exports = async (sequelize) => {
  // ── commissions.status: pending -> created ────────────────────────────────
  const commissionColumns = await columns(sequelize, 'commissions');
  if (commissionColumns) {
    const statusType = commissionColumns.get('status') || '';
    if (statusType.includes("'pending'")) {
      // Widen first so both vocabularies are valid, then move the values, then
      // narrow. Renaming in one step would reject the rows it is migrating.
      await sequelize.query(
        `ALTER TABLE commissions MODIFY COLUMN status
         ENUM('pending','created','payment_requested','approved','paid','cancelled')
         DEFAULT 'created'`,
      );
      const [, moved] = await sequelize.query(
        "UPDATE commissions SET status = 'created' WHERE status = 'pending'",
        { type: QueryTypes.UPDATE },
      );
      await sequelize.query(
        `ALTER TABLE commissions MODIFY COLUMN status
         ENUM('created','payment_requested','approved','paid','cancelled')
         DEFAULT 'created'`,
      );
      console.log(`[commissions] status pending -> created for ${moved ?? 0} row(s)`);
    }
  }

  // ── transactions.entry_type ───────────────────────────────────────────────
  const transactionColumns = await columns(sequelize, 'transactions');
  if (transactionColumns && !transactionColumns.has('entry_type')) {
    await sequelize.query(
      "ALTER TABLE transactions ADD COLUMN entry_type ENUM('credit','debit') NOT NULL DEFAULT 'credit'",
    );
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

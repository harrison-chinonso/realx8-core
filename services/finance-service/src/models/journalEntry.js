module.exports = (sequelize, DataTypes) => {
  /**
   * One journal entry: a dated, balanced, permanent statement that something
   * happened (ACC-2).
   *
   * ── Append-only, and what that actually requires ──────────────────────────
   *
   * Nothing updates or deletes an entry (ACC-2.4). A correction is a REVERSING
   * entry that names what it reverses, so the original and its correction both
   * stay on the record and a statement can be reproduced exactly as it read at
   * any past date. That is what an auditor means by an audit trail, and it is
   * the difference between a ledger and a spreadsheet with a history tab.
   *
   * The database enforces it as well — see createAccountingLedger.js, which
   * installs the same kind of UPDATE/DELETE trigger audit_logs already has.
   * The guarantee does not rest on every future caller remembering.
   *
   * ── Three different times, and they are not interchangeable ───────────────
   *
   *   entry_date    the ACCOUNTING date. Which period this belongs to, decided
   *                 by the event, and the only one a statement filters on.
   *   created_at    the wall clock. When somebody actually wrote it down —
   *                 which for a backdated accrual is months later (ACC-2.7).
   *   source        what caused it, and its reference.
   *
   * Reporting on created_at instead of entry_date is the classic error: it
   * produces a January P&L that changes in March.
   */
  const JournalEntry = sequelize.define('JournalEntry', {
    id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    /** Per-company, gap-aware, from documentSequence. Prefix JE. */
    reference: { type: DataTypes.STRING(40), allowNull: false },

    /** The accounting date. Period membership is decided by this and nothing else. */
    entry_date: { type: DataTypes.DATEONLY, allowNull: false },

    /**
     * What caused the entry: 'invoice', 'invoice_payment', 'credit_note',
     * 'commission_ledger', 'manual', 'opening_balance', 'reversal'…
     *
     * Free text over an enum for the same reason as elsewhere in this codebase:
     * a source added by a later epic must not need a migration on a table
     * holding a tenant's posted history.
     */
    source: { type: DataTypes.STRING(40), allowNull: false },
    source_id: { type: DataTypes.STRING(64), allowNull: true },

    memo: { type: DataTypes.STRING(500), allowNull: true },

    /**
     * Posted once, however many times the event arrives (ACC-2.3).
     *
     * A replayed payment approval, a retried job, two tabs — all of them
     * produce the same key, and the unique index refuses the second. The same
     * mechanism commissionStore.idempotencyKey uses, and for the same reason:
     * the alternative is a ledger that double-counts under load and balances
     * perfectly while doing it.
     */
    idempotency_key: { type: DataTypes.STRING(160), allowNull: false },

    /** The entry this one reverses, for a correction (ACC-2.4). */
    reverses_entry_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    reversal_reason: { type: DataTypes.TEXT, allowNull: true },

    /**
     * The totals, stored rather than derived.
     *
     * Every reader of a journal wants them, and a stored pair lets the
     * append-only guarantee be checked cheaply: debits must equal credits on
     * every row, which is one scan rather than a join and a group-by.
     */
    debit_minor: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    credit_minor: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },

    /** Who wrote it down. Null for an entry the system posted unattended. */
    created_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
  }, {
    tableName: 'journal_entries',
    updatedAt: false,
    indexes: [
      { unique: true, fields: ['idempotency_key'], name: 'ux_journal_entries_idempotency' },
      { unique: true, fields: ['company_id', 'reference'], name: 'ux_journal_entries_company_reference' },
      // The shape every statement reads: one company, one date window.
      { fields: ['company_id', 'entry_date'], name: 'ix_journal_entries_company_date' },
      { fields: ['source', 'source_id'], name: 'ix_journal_entries_source' },
    ],
  });

  return JournalEntry;
};

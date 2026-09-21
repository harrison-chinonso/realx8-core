module.exports = (sequelize, DataTypes) => {
  /**
   * One line off a bank statement (ACC-6.1).
   *
   * ── Why the bank's own lines are stored at all ──────────────────────────────
   *
   * Reconciliation is a comparison between two records of the same money: what
   * the company thinks happened, and what the bank says did. Matching them on
   * the fly and keeping only the result would throw away the half that is
   * evidence — the line the bank printed, with its own reference and its own
   * date, which is what an auditor asks to see and what a dispute turns on.
   *
   * It is also what makes a reconciliation repeatable. A statement re-imported
   * next month must not create a second copy of the same movements, and only a
   * stored line can be recognised as one already seen.
   *
   * ── Signed, because a statement has one amount column ───────────────────────
   *
   * Money leaves and arrives on the same column, and the sign is the only thing
   * separating them. Splitting into two columns here would mean deciding, at
   * import, which side every line belongs on — and getting it wrong silently
   * for any bank that prints brackets rather than a minus.
   */
  const BankStatementLine = sequelize.define('BankStatementLine', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    /** The ledger account this statement belongs to — a bank account in the chart. */
    account_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },

    statement_date: { type: DataTypes.DATEONLY, allowNull: false },
    description: { type: DataTypes.STRING(400), allowNull: true },
    /** The bank's own reference — a transfer narration, a cheque number. */
    reference: { type: DataTypes.STRING(120), allowNull: true },

    /** Positive is money in, negative is money out. */
    amount_minor: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    /** The running balance the bank printed, where the export carries one. */
    balance_minor: { type: DataTypes.BIGINT, allowNull: true },

    /**
     * A hash of the line as the bank printed it.
     *
     * The same statement imported twice — which happens constantly, because
     * people re-download a month to get the last few days — must not double
     * every movement in it. Date, amount and reference together identify a
     * line well enough that a genuine duplicate (two identical transfers on
     * one day) is the only false positive, and that case is rarer than the
     * re-import it prevents.
     */
    fingerprint: { type: DataTypes.STRING(64), allowNull: false },

    status: {
      type: DataTypes.ENUM('unmatched', 'matched', 'posted', 'ignored'),
      allowNull: false,
      defaultValue: 'unmatched',
    },

    /**
     * What it was matched to.
     *
     * A journal entry, because that is what the ledger side of a movement
     * always is however it arose — a receipt, a bill payment, a manual entry.
     * Matching to the source document instead would mean four nullable columns
     * and a question about which one to read.
     */
    matched_entry_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    matched_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    matched_at: { type: DataTypes.DATE, allowNull: true },

    /** Set once this line falls inside a locked reconciliation. */
    reconciliation_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    import_batch: { type: DataTypes.STRING(40), allowNull: true },
    imported_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
  }, {
    tableName: 'bank_statement_lines',
    indexes: [
      {
        unique: true,
        fields: ['company_id', 'account_id', 'fingerprint'],
        name: 'ux_bank_lines_fingerprint',
      },
      { fields: ['company_id', 'account_id', 'statement_date'], name: 'ix_bank_lines_date' },
      { fields: ['company_id', 'status'], name: 'ix_bank_lines_status' },
    ],
  });

  return BankStatementLine;
};

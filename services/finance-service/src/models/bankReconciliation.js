module.exports = (sequelize, DataTypes) => {
  /**
   * A dated, locked statement that the books agreed with the bank (ACC-6.4).
   *
   * ── Why it is a record and not a state ──────────────────────────────────────
   *
   * "Reconciled" is not a property of an account, it is something that was true
   * on a date. An account reconciled to 31 August and left alone for a month is
   * not reconciled today, and a flag on the account cannot tell you which. This
   * row says: on this date, the bank said X, the ledger said Y, these lines
   * were outstanding, and somebody signed it.
   *
   * ── Locked, because a reconciliation that can drift is not one ──────────────
   *
   * Period close depends on this (ACC-7.2): a month cannot be closed while a
   * bank account was last reconciled before the month ended. If a locked
   * reconciliation could be edited afterwards, the close would rest on
   * something that can move — which is the exact failure periods exist to
   * prevent.
   */
  const BankReconciliation = sequelize.define('BankReconciliation', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    account_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },

    /** The date the statement was drawn to. */
    statement_date: { type: DataTypes.DATEONLY, allowNull: false },

    /** What the BANK says the balance was on that date. */
    statement_balance_minor: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    /** What the LEDGER says, on the same date. */
    ledger_balance_minor: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },

    /**
     * The two will rarely be equal, and that is normal: a cheque written and
     * not yet presented is in the ledger and not on the statement. Holding the
     * reconciling amount explicitly is what lets somebody see WHY they differ
     * rather than being told they do.
     */
    outstanding_minor: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },

    /**
     * What remains after the outstanding items are accounted for.
     *
     * Zero, or the reconciliation is not finished. Stored rather than derived
     * so that a reconciliation locked when it was right stays evidence of
     * having been right.
     */
    difference_minor: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },

    status: {
      type: DataTypes.ENUM('draft', 'locked'),
      allowNull: false,
      defaultValue: 'draft',
    },

    notes: { type: DataTypes.TEXT, allowNull: true },

    reconciled_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    reconciled_at: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'bank_reconciliations',
    indexes: [
      {
        unique: true,
        fields: ['company_id', 'account_id', 'statement_date'],
        name: 'ux_bank_reconciliations_date',
      },
      { fields: ['company_id', 'status'], name: 'ix_bank_reconciliations_status' },
    ],
  });

  return BankReconciliation;
};

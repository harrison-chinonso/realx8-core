module.exports = (sequelize, DataTypes) => {
  /**
   * One line of an approved payment applied to one schedule (FRD 8.4).
   *
   * Without this the ledger cannot be reconciled or disputed: a schedule's
   * outstanding figure tells you WHERE it got to but not how, and a single
   * payment routinely spans four or five schedules. Each row answers which
   * transaction contributed how much to which schedule, split between fee and
   * principal.
   *
   * Append-only. A correction is a further allocation or a reversal, never an
   * edit — the same rule the rest of finance-service applies to transactions.
   */
  const PaymentAllocation = sequelize.define('PaymentAllocation', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    // The approved payment this line came from, i.e. the Transaction in FRD
    // terms. invoice_payments is the row an approval creates.
    invoice_payment_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    invoice_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    payment_schedule_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },

    // Split, not a single amount: fees settle before principal (FRD 8.2) and a
    // combined figure could not be reconciled back against either.
    principal_minor: { type: DataTypes.BIGINT, defaultValue: 0 },
    fee_minor: { type: DataTypes.BIGINT, defaultValue: 0 },

    // Who approved the payment this line came from.
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
  }, {
    tableName: 'payment_allocations',
    updatedAt: false,
    indexes: [
      { fields: ['invoice_payment_id'], name: 'payment_allocation_by_payment' },
      { fields: ['payment_schedule_id'], name: 'payment_allocation_by_schedule' },
      { fields: ['invoice_id'], name: 'payment_allocation_by_invoice' },
    ],
  });

  return PaymentAllocation;
};

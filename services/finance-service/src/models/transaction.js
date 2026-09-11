module.exports = (sequelize, DataTypes) => {
      const Transaction = sequelize.define('Transaction', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

user_id: { type: DataTypes.INTEGER.UNSIGNED },
type: { type: DataTypes.STRING, allowNull: false },
/**
 * Which way the money moved, from the company's point of view.
 *
 *   credit  money IN — a property purchase, an installment, income
 *   debit   money OUT — a commission payout, a refund
 *
 * The `type` column above says what KIND of thing it was, which is not the same
 * question and cannot answer this one: without a direction, summing the ledger
 * required a hardcoded list of which type strings happen to be outgoing, and
 * every new type silently defaulted to income.
 */
entry_type: { type: DataTypes.ENUM('credit', 'debit'), allowNull: false, defaultValue: 'credit' },
amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
description: { type: DataTypes.TEXT },
payment_method: { type: DataTypes.STRING },
status: { type: DataTypes.STRING, defaultValue: 'completed' },
reference: { type: DataTypes.STRING },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, {
  tableName: 'transactions',
  updatedAt: false,
  // One reference, one transaction — see invoicePayment.js.
  indexes: [{ unique: true, fields: ['company_id', 'reference'], name: 'ux_transactions_company_reference' }],
});

      return Transaction;
    };

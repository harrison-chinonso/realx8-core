module.exports = (sequelize, DataTypes) => {
      const Invoice = sequelize.define('Invoice', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

invoice_id: { type: DataTypes.STRING, allowNull: false },
client_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
property_id: { type: DataTypes.INTEGER.UNSIGNED },
amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
due_date: { type: DataTypes.DATE },
// 'payment_under_review' sits between sent and paid: the buyer has uploaded
// proof of payment and an admin has not yet confirmed it.
status: { type: DataTypes.ENUM('draft', 'sent', 'payment_under_review', 'paid', 'overdue', 'cancelled'), defaultValue: 'draft' },
tax_id: { type: DataTypes.INTEGER.UNSIGNED },
// Optional: an admin can point one invoice at a specific bank account. When
// null the buyer is shown the company's active accounts instead.
bank_account_id: { type: DataTypes.INTEGER.UNSIGNED },
discount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
created_by: { type: DataTypes.INTEGER.UNSIGNED },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'invoices', updatedAt: false, indexes: [{ unique: true, fields: ['invoice_id'], name: 'invoice_id' }] });

      return Invoice;
    };

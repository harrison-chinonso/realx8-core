module.exports = (sequelize, DataTypes) => {
      const InvoicePayment = sequelize.define('InvoicePayment', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

invoice_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
payment_method: { type: DataTypes.STRING, allowNull: false },
transaction_id: { type: DataTypes.STRING },
status: { type: DataTypes.STRING, defaultValue: 'completed' },
note: { type: DataTypes.TEXT },
order_id: { type: DataTypes.STRING },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'invoice_payments', updatedAt: false });

      return InvoicePayment;
    };

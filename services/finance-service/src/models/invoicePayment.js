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
}, {
        tableName: 'invoice_payments',
        updatedAt: false,
        /**
         * One proof-of-payment reference, one payment.
         *
         * Two payments carrying the same transaction_id means one bank
         * transfer credited twice. NULL repeats freely, which is what an
         * admin-approved payment with no proof needs.
         */
        indexes: [{
          unique: true,
          fields: ['company_id', 'transaction_id'],
          name: 'ux_invoice_payments_company_reference',
        }],
      });

      return InvoicePayment;
    };

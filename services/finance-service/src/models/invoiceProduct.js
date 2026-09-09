module.exports = (sequelize, DataTypes) => {
      const InvoiceProduct = sequelize.define('InvoiceProduct', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

invoice_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
name: { type: DataTypes.STRING, allowNull: false },
quantity: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 1 },
price: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
tax_id: { type: DataTypes.INTEGER.UNSIGNED },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'invoice_products', updatedAt: false });

      return InvoiceProduct;
    };

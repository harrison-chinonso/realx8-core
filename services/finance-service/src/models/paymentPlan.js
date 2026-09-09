module.exports = (sequelize, DataTypes) => {
      const PaymentPlan = sequelize.define('PaymentPlan', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

name: { type: DataTypes.STRING, allowNull: false },
price: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
duration: { type: DataTypes.STRING },
features: { type: DataTypes.JSON },
is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'payment_plans', updatedAt: false });

      return PaymentPlan;
    };

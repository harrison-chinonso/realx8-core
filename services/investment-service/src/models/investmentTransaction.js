module.exports = (sequelize, DataTypes) => {
      const InvestmentTransaction = sequelize.define('InvestmentTransaction', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

investment_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
type: { type: DataTypes.ENUM('deposit', 'return', 'payout'), allowNull: false },
status: { type: DataTypes.STRING, defaultValue: 'completed' },
description: { type: DataTypes.STRING },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'investment_transactions', updatedAt: false });

      return InvestmentTransaction;
    };

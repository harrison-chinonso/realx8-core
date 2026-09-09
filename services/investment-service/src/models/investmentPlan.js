module.exports = (sequelize, DataTypes) => {
      const InvestmentPlan = sequelize.define('InvestmentPlan', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

name: { type: DataTypes.STRING, allowNull: false },
description: { type: DataTypes.TEXT },
min_amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
max_amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
return_rate: { type: DataTypes.DECIMAL(5, 2), defaultValue: 0 },
period_id: { type: DataTypes.INTEGER.UNSIGNED },
category_id: { type: DataTypes.INTEGER.UNSIGNED },
status: { type: DataTypes.STRING, defaultValue: 'active' },
total_investment_amount: { type: DataTypes.DECIMAL(14, 2), defaultValue: 0 },
created_by: { type: DataTypes.INTEGER.UNSIGNED },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'investment_plans', updatedAt: false });

      return InvestmentPlan;
    };

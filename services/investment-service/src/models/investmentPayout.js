module.exports = (sequelize, DataTypes) => {
      const InvestmentPayout = sequelize.define('InvestmentPayout', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

investment_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
status: { type: DataTypes.ENUM('pending', 'paid'), defaultValue: 'pending' },
payout_date: { type: DataTypes.DATE },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'investment_payouts', updatedAt: false });

      return InvestmentPayout;
    };

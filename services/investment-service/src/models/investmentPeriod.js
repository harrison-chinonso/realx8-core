module.exports = (sequelize, DataTypes) => {
      const InvestmentPeriod = sequelize.define('InvestmentPeriod', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

name: { type: DataTypes.STRING, allowNull: false },
days: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'investment_periods', updatedAt: false });

      return InvestmentPeriod;
    };

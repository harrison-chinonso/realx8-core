module.exports = (sequelize, DataTypes) => {
      const InvestmentCategory = sequelize.define('InvestmentCategory', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

name: { type: DataTypes.STRING, allowNull: false },
description: { type: DataTypes.TEXT },
created_by: { type: DataTypes.INTEGER.UNSIGNED },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'investment_categories', updatedAt: false });

      return InvestmentCategory;
    };

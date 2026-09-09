module.exports = (sequelize, DataTypes) => {
      const Transaction = sequelize.define('Transaction', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

user_id: { type: DataTypes.INTEGER.UNSIGNED },
type: { type: DataTypes.STRING, allowNull: false },
amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
description: { type: DataTypes.TEXT },
payment_method: { type: DataTypes.STRING },
status: { type: DataTypes.STRING, defaultValue: 'completed' },
reference: { type: DataTypes.STRING },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'transactions', updatedAt: false });

      return Transaction;
    };

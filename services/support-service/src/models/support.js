module.exports = (sequelize, DataTypes) => {
      const Support = sequelize.define('Support', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

subject: { type: DataTypes.STRING, allowNull: false },
description: { type: DataTypes.TEXT, allowNull: false },
status: { type: DataTypes.ENUM('open', 'in_progress', 'resolved', 'closed'), defaultValue: 'open' },
priority: { type: DataTypes.ENUM('low', 'medium', 'high'), defaultValue: 'medium' },
user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
assigned_to: { type: DataTypes.INTEGER.UNSIGNED },
created_by: { type: DataTypes.INTEGER.UNSIGNED },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'support_tickets', updatedAt: false });

      return Support;
    };

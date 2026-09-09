module.exports = (sequelize, DataTypes) => {
      const Task = sequelize.define('Task', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

title: { type: DataTypes.STRING, allowNull: false },
description: { type: DataTypes.TEXT },
due_date: { type: DataTypes.DATE },
status: { type: DataTypes.ENUM('pending', 'in_progress', 'done'), defaultValue: 'pending' },
priority: { type: DataTypes.STRING, defaultValue: 'medium' },
assigned_to: { type: DataTypes.INTEGER.UNSIGNED },
deal_id: { type: DataTypes.INTEGER.UNSIGNED },
lead_id: { type: DataTypes.INTEGER.UNSIGNED },
created_by: { type: DataTypes.INTEGER.UNSIGNED },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'tasks', updatedAt: false });

      return Task;
    };

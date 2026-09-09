module.exports = (sequelize, DataTypes) => {
      const TaskStage = sequelize.define('TaskStage', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

name: { type: DataTypes.STRING, allowNull: false },
color: { type: DataTypes.STRING, defaultValue: '#14b8a6' },
created_by: { type: DataTypes.INTEGER.UNSIGNED },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'task_stages', updatedAt: false });

      return TaskStage;
    };

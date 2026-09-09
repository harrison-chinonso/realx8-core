module.exports = (sequelize, DataTypes) => {
      const Stage = sequelize.define('Stage', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

name: { type: DataTypes.STRING, allowNull: false },
pipeline_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
order: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
color: { type: DataTypes.STRING, defaultValue: '#0ea5e9' },
created_by: { type: DataTypes.INTEGER.UNSIGNED },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'stages', updatedAt: false });

      return Stage;
    };

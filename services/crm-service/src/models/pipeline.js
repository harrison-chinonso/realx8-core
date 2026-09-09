module.exports = (sequelize, DataTypes) => {
      const Pipeline = sequelize.define('Pipeline', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

name: { type: DataTypes.STRING, allowNull: false },
created_by: { type: DataTypes.INTEGER.UNSIGNED },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'pipelines', updatedAt: false });

      return Pipeline;
    };

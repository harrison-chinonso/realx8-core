module.exports = (sequelize, DataTypes) => {
      const Source = sequelize.define('Source', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

name: { type: DataTypes.STRING, allowNull: false },
created_by: { type: DataTypes.INTEGER.UNSIGNED },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'sources', updatedAt: false });

      return Source;
    };

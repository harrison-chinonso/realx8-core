module.exports = (sequelize, DataTypes) => {
      const Label = sequelize.define('Label', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

name: { type: DataTypes.STRING, allowNull: false },
color: { type: DataTypes.STRING, defaultValue: '#6366f1' },
created_by: { type: DataTypes.INTEGER.UNSIGNED },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'labels', updatedAt: false });

      return Label;
    };

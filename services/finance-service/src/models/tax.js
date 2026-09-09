module.exports = (sequelize, DataTypes) => {
      const Tax = sequelize.define('Tax', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

name: { type: DataTypes.STRING, allowNull: false },
rate: { type: DataTypes.DECIMAL(5, 2), allowNull: false },
created_by: { type: DataTypes.INTEGER.UNSIGNED },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'taxes', updatedAt: false });

      return Tax;
    };

module.exports = (sequelize, DataTypes) => {
      const PropertyUnit = sequelize.define('PropertyUnit', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

name: { type: DataTypes.STRING, allowNull: false, unique: true },
symbol: { type: DataTypes.STRING },
default: { type: DataTypes.BOOLEAN, defaultValue: false },
      }, { tableName: 'property_unit_catalog', updatedAt: false });

      return PropertyUnit;
    };

module.exports = (sequelize, DataTypes) => {
      const PropertyUnits = sequelize.define('PropertyUnits', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

property_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
// A unit configuration: N units of `size` `unit` at `price` each.
name: { type: DataTypes.STRING, allowNull: false },
price: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
status: { type: DataTypes.STRING, defaultValue: 'available' },
size: { type: DataTypes.STRING },          // Property Size, e.g. "500"
unit: { type: DataTypes.STRING },          // Measured In, e.g. "sqm"
quantity: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 1 },
      }, { tableName: 'property_units' });

      return PropertyUnits;
    };

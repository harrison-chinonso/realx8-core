module.exports = (sequelize, DataTypes) => {
      const PropertyUnitsPlots = sequelize.define('PropertyUnitsPlots', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

property_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
unit_id: { type: DataTypes.INTEGER.UNSIGNED },
plot_id: { type: DataTypes.INTEGER.UNSIGNED },
quantity: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
quantity_available: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
price: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
commission: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
      }, { tableName: 'property_units_plots' });

      return PropertyUnitsPlots;
    };

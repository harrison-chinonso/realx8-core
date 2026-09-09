module.exports = (sequelize, DataTypes) => {
      const PropertyPlots = sequelize.define('PropertyPlots', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

property_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
name: { type: DataTypes.STRING, allowNull: false },
price: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
status: { type: DataTypes.STRING, defaultValue: 'available' },
size: { type: DataTypes.STRING },
      }, { tableName: 'property_plots' });

      return PropertyPlots;
    };

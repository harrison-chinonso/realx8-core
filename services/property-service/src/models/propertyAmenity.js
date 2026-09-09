module.exports = (sequelize, DataTypes) => {
      const PropertyAmenity = sequelize.define('PropertyAmenity', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

property_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
name: { type: DataTypes.STRING, allowNull: false },
icon: { type: DataTypes.STRING },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'property_amenities', updatedAt: false });

      return PropertyAmenity;
    };

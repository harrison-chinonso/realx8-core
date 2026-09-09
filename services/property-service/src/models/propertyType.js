module.exports = (sequelize, DataTypes) => {
  const PropertyType = sequelize.define('PropertyType', {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    name: { type: DataTypes.STRING, allowNull: false, unique: true },
    description: { type: DataTypes.TEXT },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
  
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
    }, { tableName: 'property_types', updatedAt: false });

  return PropertyType;
};

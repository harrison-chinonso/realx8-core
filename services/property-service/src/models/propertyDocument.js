module.exports = (sequelize, DataTypes) => {
  const PropertyDocument = sequelize.define('PropertyDocument', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    property_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    name: { type: DataTypes.STRING, allowNull: false },
    url: { type: DataTypes.STRING(1000), allowNull: false },
    type: { type: DataTypes.STRING },        // e.g. deed, survey, title, other
    size: { type: DataTypes.INTEGER.UNSIGNED },
    public_id: { type: DataTypes.STRING },   // Cloudinary public_id for deletion
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
  }, { tableName: 'property_documents', updatedAt: false });

  return PropertyDocument;
};

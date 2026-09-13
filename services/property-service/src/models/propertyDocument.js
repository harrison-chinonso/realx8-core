module.exports = (sequelize, DataTypes) => {
  const PropertyDocument = sequelize.define('PropertyDocument', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    property_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    name: { type: DataTypes.STRING, allowNull: false },
    url: { type: DataTypes.STRING(1000), allowNull: false },
    type: { type: DataTypes.STRING },        // e.g. deed, survey, title, other
    /**
     * Whether a prospective buyer may see this document at all.
     *
     * Defaults to FALSE, and that default is the point: a property's document
     * store holds internal paperwork as well as the deeds a buyer should read,
     * so nothing becomes visible outside staff until somebody says so about
     * that specific file. Sharing is an act, not a side effect of uploading.
     *
     * Shared means VIEW. It never means download — see getDocuments.
     */
    is_shareable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    size: { type: DataTypes.INTEGER.UNSIGNED },
    public_id: { type: DataTypes.STRING },   // Cloudinary public_id for deletion
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
  }, { tableName: 'property_documents', updatedAt: false });

  return PropertyDocument;
};

module.exports = (sequelize, DataTypes) => {
  const PropertyType = sequelize.define('PropertyType', {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    /**
     * Not globally unique, and that is the fix rather than an omission.
     *
     * `unique: true` here made one name usable once on the ENTIRE platform: the
     * first company to add "Land" took the word, and every other company was
     * refused it forever. The listing is company-scoped, so the refusal pointed
     * at a row the caller could not see — the screen showed four types, none of
     * them "Land", and the save failed saying the name was taken.
     *
     * Uniqueness belongs inside a company. It is carried by the composite index
     * in migrations/propertyTypeNamePerCompany.js rather than declared here,
     * because this service syncs with { alter: true } and an index declared in
     * two places is an index sync keeps rebuilding.
     */
    name: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
  
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
    }, { tableName: 'property_types', updatedAt: false });

  return PropertyType;
};

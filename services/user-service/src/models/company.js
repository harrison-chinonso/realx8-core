module.exports = (sequelize, DataTypes) => {
  const Company = sequelize.define('Company', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false },
    slug: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, allowNull: false },
    phone: { type: DataTypes.STRING },
    address: { type: DataTypes.STRING },
    logo_url: { type: DataTypes.STRING },
    status: { type: DataTypes.ENUM('active', 'suspended', 'pending'), defaultValue: 'active' },
    plan: { type: DataTypes.STRING, defaultValue: 'standard' },
    referral_code: { type: DataTypes.STRING(5), allowNull: true, unique: true },
  }, { tableName: 'companies', indexes: [{ unique: true, fields: ['slug'], name: 'slug' }] });

  return Company;
};

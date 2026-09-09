module.exports = (sequelize, DataTypes) => {
  const Setting = sequelize.define('Setting', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    key: { type: DataTypes.STRING, allowNull: false },
    value: { type: DataTypes.TEXT },
    group: { type: DataTypes.STRING, defaultValue: 'general' },
    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
  }, {
    tableName: 'settings',
    updatedAt: false,
    // Index is managed by addMultiTenancy migration — not defined here to avoid ER_DUP_KEYNAME on sync
  });

  return Setting;
};

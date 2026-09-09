module.exports = (sequelize, DataTypes) => {
  const Role = sequelize.define('Role', {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    name: { type: DataTypes.STRING, allowNull: false, unique: true },
    display_name: { type: DataTypes.STRING },
    description: { type: DataTypes.TEXT },
    guard_name: { type: DataTypes.STRING, defaultValue: 'api' },
    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
  }, { tableName: 'roles', updatedAt: false });

  return Role;
};

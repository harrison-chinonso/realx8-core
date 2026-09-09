module.exports = (sequelize, DataTypes) => {
  const Permission = sequelize.define('Permission', {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    name: { type: DataTypes.STRING, allowNull: false, unique: true },
    display_name: { type: DataTypes.STRING },
    module: { type: DataTypes.STRING },
    description: { type: DataTypes.TEXT },
    guard_name: { type: DataTypes.STRING, defaultValue: 'api' },
  }, { tableName: 'permissions', updatedAt: false });

  return Permission;
};

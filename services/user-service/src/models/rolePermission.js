module.exports = (sequelize, DataTypes) => sequelize.define('RolePermission', {
  role_id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
  permission_id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
}, { tableName: 'role_permissions', timestamps: false });

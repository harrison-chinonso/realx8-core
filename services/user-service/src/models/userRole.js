module.exports = (sequelize, DataTypes) => sequelize.define('UserRole', {
  user_id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
  role_id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
}, { tableName: 'user_roles', timestamps: false });

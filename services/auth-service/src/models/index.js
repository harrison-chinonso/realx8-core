const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const User = require('./user')(sequelize, DataTypes);
const RefreshToken = require('./refreshToken')(sequelize, DataTypes);
const PasswordReset = require('./passwordReset')(sequelize, DataTypes);

User.hasMany(RefreshToken, { foreignKey: 'user_id', as: 'refreshTokens' });
RefreshToken.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

module.exports = { sequelize, User, RefreshToken, PasswordReset };

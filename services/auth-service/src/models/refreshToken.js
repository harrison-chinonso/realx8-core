module.exports = (sequelize, DataTypes) => {
      const RefreshToken = sequelize.define('RefreshToken', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
token: { type: DataTypes.STRING(255), allowNull: false, unique: true },
expires_at: { type: DataTypes.DATE, allowNull: false },
      }, { tableName: 'refresh_tokens', updatedAt: false });

      return RefreshToken;
    };

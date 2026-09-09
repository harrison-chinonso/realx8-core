module.exports = (sequelize, DataTypes) => {
      const PasswordReset = sequelize.define('PasswordReset', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

email: { type: DataTypes.STRING, allowNull: false },
token: { type: DataTypes.STRING(255), allowNull: false },
expires_at: { type: DataTypes.DATE, allowNull: false },
      }, { tableName: 'password_resets', updatedAt: false });

      return PasswordReset;
    };

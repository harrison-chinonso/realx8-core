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
// Wrong guesses against this OTP, whoever made them. See the controller.
attempts: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
// Ties the issued reset token to this row, so it is usable exactly once.
nonce: { type: DataTypes.STRING(64), allowNull: true },
      }, { tableName: 'password_resets', updatedAt: false });

      return PasswordReset;
    };

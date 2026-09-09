module.exports = (sequelize, DataTypes) => {
      const UserProfile = sequelize.define('UserProfile', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, unique: true },
billing_address: { type: DataTypes.STRING },
billing_city: { type: DataTypes.STRING },
billing_state: { type: DataTypes.STRING },
billing_country: { type: DataTypes.STRING },
id_card: { type: DataTypes.STRING },
wallet_balance: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
balance: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
credit_balance: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
referral_code: { type: DataTypes.STRING },
created_by: { type: DataTypes.INTEGER.UNSIGNED },
      }, { tableName: 'user_profiles' });

      return UserProfile;
    };

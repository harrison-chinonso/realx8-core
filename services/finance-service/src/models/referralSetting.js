module.exports = (sequelize, DataTypes) => {
  const ReferralSetting = sequelize.define('ReferralSetting', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    referral_type: { type: DataTypes.ENUM('fixed', 'percentage'), defaultValue: 'percentage' },
    amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
    is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
  
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
    }, { tableName: 'referral_settings', updatedAt: false });

  return ReferralSetting;
};

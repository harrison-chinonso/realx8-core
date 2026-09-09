module.exports = (sequelize, DataTypes) => {
  const ReferralTransaction = sequelize.define('ReferralTransaction', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    referrer_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    referred_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    status: { type: DataTypes.ENUM('pending', 'paid', 'cancelled'), defaultValue: 'pending' },
    payment_date: { type: DataTypes.DATE },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
  
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
    }, { tableName: 'referral_transactions', updatedAt: false });

  return ReferralTransaction;
};

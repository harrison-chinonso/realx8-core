module.exports = (sequelize, DataTypes) => {
  const CommissionRule = sequelize.define('CommissionRule', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    product_type: {
      type: DataTypes.ENUM('land', 'house', 'investment', 'any'),
      allowNull: false,
      defaultValue: 'any',
    },
    realtor_category: {
      type: DataTypes.ENUM('premium', 'professional', 'basic', 'any'),
      allowNull: false,
      defaultValue: 'any',
    },
    type: { type: DataTypes.ENUM('fixed', 'percentage'), allowNull: false, defaultValue: 'percentage' },
    value: { type: DataTypes.DECIMAL(12, 4), allowNull: false },
    description: { type: DataTypes.STRING },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
  }, { tableName: 'commission_rules' });

  return CommissionRule;
};

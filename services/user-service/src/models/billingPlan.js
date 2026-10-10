module.exports = (sequelize, DataTypes) => sequelize.define('BillingPlan', {
  /** Stable identifier: starter | professional | enterprise. */
  code: { type: DataTypes.STRING(40), primaryKey: true },
  name: { type: DataTypes.STRING(80), allowNull: false },
  description: { type: DataTypes.STRING(255) },
  monthly_price: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
  annual_price: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
  currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'NGN' },
  /** User accounts allowed in the company; null = unlimited. */
  user_limit: { type: DataTypes.INTEGER, allowNull: true },
  sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, { tableName: 'billing_plans' });

/** Every subscription charge — Paystack or recorded by hand — and the period it paid for. */
module.exports = (sequelize, DataTypes) => sequelize.define('SubscriptionPayment', {
  id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
  company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  plan_code: { type: DataTypes.STRING(40), allowNull: false },
  billing_interval: { type: DataTypes.STRING(10), allowNull: false },
  amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
  currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'NGN' },
  /** Paystack's reference, or one made up for a manual payment. Unique: a webhook and a redirect never record it twice. */
  reference: { type: DataTypes.STRING(120), allowNull: false, unique: true },
  provider: { type: DataTypes.STRING(20), allowNull: false },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'success' },
  period_start: { type: DataTypes.DATE, allowNull: true },
  period_end: { type: DataTypes.DATE, allowNull: true },
  paid_at: { type: DataTypes.DATE, allowNull: true },
  recorded_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
  note: { type: DataTypes.STRING(255), allowNull: true },
}, { tableName: 'subscription_payments', indexes: [{ fields: ['company_id'] }] });

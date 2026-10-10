/**
 * One per company: its plan, and the dates its billing state is derived from
 * (shared/src/billing.js effectiveState). Status is only trialing | active |
 * cancelled — "grace" and "lapsed" are worked out from the dates, never stored.
 */
module.exports = (sequelize, DataTypes) => sequelize.define('CompanySubscription', {
  id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
  company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, unique: true },
  plan_code: { type: DataTypes.STRING(40), allowNull: true },
  billing_interval: { type: DataTypes.STRING(10), allowNull: true },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'trialing' },
  trial_ends_at: { type: DataTypes.DATE, allowNull: true },
  current_period_end: { type: DataTypes.DATE, allowNull: true },
  /** Charge the saved card when the period ends. */
  auto_renew: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  paystack_authorization_code: { type: DataTypes.STRING(120), allowNull: true },
  paystack_email: { type: DataTypes.STRING(160), allowNull: true },
  /** The last reminder sent (e.g. "trial:3:2026-10-17"), so the sweep sends each once. */
  last_reminder: { type: DataTypes.STRING(60), allowNull: true },
}, { tableName: 'company_subscriptions' });

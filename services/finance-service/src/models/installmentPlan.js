module.exports = (sequelize, DataTypes) => {
  /**
   * A company-configured installment arrangement (FRD 3.1) — a reusable
   * TEMPLATE, not an arrangement against any particular invoice.
   *
   * Nothing here is read for an invoice that already exists: the terms are
   * snapshotted onto invoice_payment_plans at creation (FRD 3.3), so editing a
   * plan cannot restate what an issued invoice owes.
   *
   * Distinct from `payment_plans`, which despite the name is the subscription
   * price list and has nothing to do with the purchase journey.
   */
  const InstallmentPlan = sequelize.define('InstallmentPlan', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false },
    // Months, and therefore the number of schedules generated (FRD 9.1).
    duration_months: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },

    // `percentage` reads surcharge_value as a percentage of the full base
    // amount, applied once (FRD 15.2); `flat` reads it as a major-unit amount.
    surcharge_type: { type: DataTypes.ENUM('none', 'percentage', 'flat'), defaultValue: 'none' },
    // DECIMAL(12,4), not (12,2): this holds a RATE as well as an amount, and a
    // rate like 2.75% needs the extra places. The money it produces is computed
    // in minor units and stored as such.
    surcharge_value: { type: DataTypes.DECIMAL(12, 4), defaultValue: 0 },

    rounding_rule: {
      type: DataTypes.ENUM('none', 'nearest_100', 'nearest_1000', 'up_to_1000'),
      defaultValue: 'none',
    },

    // Days after a due date before the schedule is treated as overdue and the
    // default fee bites (FRD 9.3).
    grace_period_days: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
    default_fee_type: { type: DataTypes.ENUM('none', 'percentage', 'flat'), defaultValue: 'none' },
    // Percentage applies to the schedule's OUTSTANDING principal (FRD 15.3).
    default_fee_value: { type: DataTypes.DECIMAL(12, 4), defaultValue: 0 },
    default_fee_recurrence: { type: DataTypes.ENUM('once', 'monthly'), defaultValue: 'once' },

    // Inactive plans stay on the invoices already issued against them; they are
    // simply no longer offered (FRD 3.1).
    is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
  }, { tableName: 'installment_plans' });

  return InstallmentPlan;
};

module.exports = (sequelize, DataTypes) => {
  /**
   * The financial arrangement attached to one invoice (FRD 2, 11).
   *
   * For an outright purchase it is a single obligation and owns no schedules.
   * For an installment purchase it is the parent of N payment_schedules.
   *
   * The `snapshot_*` columns are the plan terms frozen at creation (FRD 3.3).
   * Every later calculation for this invoice — schedule regeneration, the
   * default fee, the grace window — reads them and never the live plan, which
   * an admin may have edited or deactivated since. FRD 16 names reading live
   * plan configuration for a historic invoice as the most likely source of
   * silent financial error in the design, so installment_plan_id is kept for
   * provenance only.
   *
   * Money is minor units (kobo). The invoice's own DECIMAL `amount` still
   * carries the major-unit total for everything that already reads it; this row
   * is where the arithmetic actually lives.
   */
  const InvoicePaymentPlan = sequelize.define('InvoicePaymentPlan', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    invoice_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    payment_type: { type: DataTypes.ENUM('outright', 'installment'), allowNull: false },
    // Provenance only — never read for calculation. Null for outright, and it
    // survives the plan being deactivated.
    installment_plan_id: { type: DataTypes.INTEGER.UNSIGNED },

    // What was bought. Denormalised so the arrangement stays priceable if the
    // unit configuration is edited or removed.
    property_unit_id: { type: DataTypes.INTEGER.UNSIGNED },
    quantity: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 1 },
    unit_price_minor: { type: DataTypes.BIGINT, defaultValue: 0 },

    // The FRD 4 calculation, kept broken out rather than only as a total: the
    // surcharge has to be statable explicitly (FRD 4.1) long after purchase,
    // and a total alone cannot be decomposed back into base and charge.
    base_minor: { type: DataTypes.BIGINT, defaultValue: 0 },
    /**
     * What a promotion took off this purchase, in minor units.
     *
     * Stored BESIDE the base rather than deducted from it. Every screen has to
     * show original, discount and payable as three separate numbers, and a base
     * that has already absorbed the discount cannot produce them — nor could
     * anybody later answer what the property was actually sold for.
     *
     * The authoritative record of WHICH promotion and why is the redemption row;
     * this is the figure the plan's own arithmetic used.
     */
    promotion_discount_minor: { type: DataTypes.BIGINT, defaultValue: 0 },
    surcharge_minor: { type: DataTypes.BIGINT, defaultValue: 0 },
    total_minor: { type: DataTypes.BIGINT, defaultValue: 0 },

    /**
     * Surplus paid beyond every schedule (FRD 8.2).
     *
     * Held here rather than silently absorbed, and flagged for admin attention
     * — `credit_balance_flagged_at` is what the admin queue filters on, so
     * clearing the flag does not lose the money.
     */
    /**
     * The discount spread across this plan's schedules, kept here as the sum so
     * a revised discount can be applied as a DIFFERENCE rather than stacked on
     * top of itself — re-granting the same discount twice is the obvious way to
     * halve an invoice by accident, and it only shows up when the buyer stops
     * paying at what they believe is the end.
     */
    discount_minor: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    credit_balance_minor: { type: DataTypes.BIGINT, defaultValue: 0 },
    credit_balance_flagged_at: { type: DataTypes.DATE },

    status: {
      // IN_DEFAULT is recoverable: settling the overdue schedules returns the
      // plan to ACTIVE (FRD 11), so this is recalculated, never latched.
      type: DataTypes.ENUM('active', 'completed', 'in_default', 'cancelled'),
      defaultValue: 'active',
    },

    // Plan terms as at creation — the authority for this invoice (FRD 3.3).
    snapshot_plan_name: { type: DataTypes.STRING },
    snapshot_duration_months: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
    snapshot_surcharge_type: { type: DataTypes.STRING(16), defaultValue: 'none' },
    snapshot_surcharge_value: { type: DataTypes.DECIMAL(12, 4), defaultValue: 0 },
    snapshot_rounding_rule: { type: DataTypes.STRING(16), defaultValue: 'none' },
    snapshot_grace_period_days: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
    snapshot_default_fee_type: { type: DataTypes.STRING(16), defaultValue: 'none' },
    snapshot_default_fee_value: { type: DataTypes.DECIMAL(12, 4), defaultValue: 0 },
    snapshot_default_fee_recurrence: { type: DataTypes.STRING(16), defaultValue: 'once' },

    created_by: { type: DataTypes.INTEGER.UNSIGNED },
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
  }, {
    tableName: 'invoice_payment_plans',
    indexes: [
      // One arrangement per invoice. Without this a retried checkout could
      // leave an invoice with two plans and two full schedule sets, and every
      // balance derived from it would double.
      { unique: true, fields: ['invoice_id'], name: 'invoice_payment_plan_invoice_unique' },
    ],
  });

  return InvoicePaymentPlan;
};

module.exports = (sequelize, DataTypes) => {
  /**
   * Inventory actually held against a property unit (FRD 10).
   *
   * This table exists because FRD 10.1 reverses how availability used to be
   * decided. Availability was DERIVED — unit quantity minus every non-cancelled
   * purchase request — which meant merely creating an invoice took stock off the
   * market. The requirement is now the opposite: an unpaid invoice secures
   * nothing, and quantity is reduced only once a payment is received and
   * approved, per the company's hold policy (FRD 10.2).
   *
   * A derived figure cannot express that, because "has this invoice's payment
   * reached the threshold?" is not a fact about the purchase request. So the
   * hold is recorded explicitly, and availability is
   *
   *     property_units.quantity - SUM(quantity of unreleased holds)
   *
   * One row per invoice, created when its policy trigger is first met and
   * covering the ENTIRE invoiced quantity rather than a pro-rata share
   * (FRD 10.2). Releasing sets released_at rather than deleting, so a
   * cancellation still shows what had been held and when.
   */
  const PropertyUnitHold = sequelize.define('PropertyUnitHold', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    property_unit_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    property_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    // finance-service's invoices table. The hold belongs to the invoice that
    // paid for it, which is what makes it releasable on cancellation.
    invoice_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    client_id: { type: DataTypes.INTEGER.UNSIGNED },
    quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },

    // Which policy fired, and on what evidence. Kept for the audit trail: a
    // buyer asking why their units were secured at one point and not another
    // is answered from here rather than by replaying the payment history.
    trigger_policy: {
      type: DataTypes.ENUM('any_payment', 'threshold_amount', 'threshold_percentage'),
      allowNull: false,
    },
    triggered_by_payment_id: { type: DataTypes.INTEGER.UNSIGNED },
    cumulative_paid_minor: { type: DataTypes.BIGINT, defaultValue: 0 },

    released_at: { type: DataTypes.DATE },
    release_reason: { type: DataTypes.STRING },

    company_id: { type: DataTypes.INTEGER.UNSIGNED },
  }, {
    tableName: 'property_unit_holds',
    indexes: [
      // One hold per invoice. The hold covers the whole invoiced quantity, so a
      // second approved payment on the same invoice must not hold it twice —
      // and this makes that impossible rather than merely unlikely.
      { unique: true, fields: ['invoice_id'], name: 'property_unit_hold_invoice_unique' },
      // The availability sum, which runs on every unit listing and inside the
      // oversell check (FRD 10.4).
      { fields: ['property_unit_id', 'released_at'], name: 'property_unit_hold_availability' },
    ],
  });

  return PropertyUnitHold;
};

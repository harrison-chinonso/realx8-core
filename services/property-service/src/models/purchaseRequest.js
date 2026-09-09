module.exports = (sequelize, DataTypes) => {
  const PurchaseRequest = sequelize.define('PurchaseRequest', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    property_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    // Which unit configuration the buyer wants (nullable if none was chosen).
    unit_id: { type: DataTypes.INTEGER.UNSIGNED },
    // The authenticated buyer. Purchase requests always require an account.
    user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    buyer_name: { type: DataTypes.STRING },
    buyer_email: { type: DataTypes.STRING },
    buyer_phone: { type: DataTypes.STRING },
    quantity: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 1 },
    notes: { type: DataTypes.TEXT },
    payment_mode: { type: DataTypes.ENUM('outright', 'installment'), defaultValue: 'outright' },
    // Total = unit price x quantity, computed server-side, never client-supplied.
    amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
    // The generated invoice (finance-service owns the invoices table).
    invoice_id: { type: DataTypes.INTEGER.UNSIGNED },
    invoice_ref: { type: DataTypes.STRING },
    status: {
      type: DataTypes.ENUM('pending', 'contacted', 'completed', 'cancelled'),
      defaultValue: 'pending',
    },
    // Denormalised so the request stays attributable if the unit is deleted.
    unit_label: { type: DataTypes.STRING },
    unit_price: { type: DataTypes.DECIMAL(12, 2) },
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
  }, { tableName: 'property_purchase_requests' });

  return PurchaseRequest;
};

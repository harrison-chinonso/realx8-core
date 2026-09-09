module.exports = (sequelize, DataTypes) => {
  const Receipt = sequelize.define('Receipt', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    receipt_number: { type: DataTypes.STRING, allowNull: false },
    invoice_id: { type: DataTypes.INTEGER.UNSIGNED },
    invoice_payment_id: { type: DataTypes.INTEGER.UNSIGNED },
    client_id: { type: DataTypes.INTEGER.UNSIGNED },
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    payment_method: { type: DataTypes.STRING },
    // The uploaded proof of payment (image or PDF).
    document_url: { type: DataTypes.STRING },
    reference: { type: DataTypes.STRING },
    status: { type: DataTypes.ENUM('pending', 'verified', 'rejected'), defaultValue: 'pending' },
    verified_by: { type: DataTypes.INTEGER.UNSIGNED },
    verified_at: { type: DataTypes.DATE },
    notes: { type: DataTypes.TEXT },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
  }, {
    tableName: 'receipts',
    updatedAt: false,
    indexes: [{ unique: true, fields: ['receipt_number'], name: 'receipt_number_unique' }],
  });

  return Receipt;
};

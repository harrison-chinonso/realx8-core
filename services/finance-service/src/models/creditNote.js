module.exports = (sequelize, DataTypes) => {
  const CreditNote = sequelize.define('CreditNote', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    credit_note_id: { type: DataTypes.STRING, allowNull: false },
    client_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    invoice_id: { type: DataTypes.INTEGER.UNSIGNED },
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    tax_id: { type: DataTypes.INTEGER.UNSIGNED },
    discount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
    status: { type: DataTypes.ENUM('draft', 'sent', 'partial', 'used', 'cancelled'), defaultValue: 'draft' },
    reason: { type: DataTypes.TEXT },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
  
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
    }, { tableName: 'credit_notes', updatedAt: false, indexes: [{ unique: true, fields: ['credit_note_id'], name: 'credit_note_id' }] });

  return CreditNote;
};

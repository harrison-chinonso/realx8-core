module.exports = (sequelize, DataTypes) => {
  const DebitNote = sequelize.define('DebitNote', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    debit_note_id: { type: DataTypes.STRING, allowNull: false },
    client_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    invoice_id: { type: DataTypes.INTEGER.UNSIGNED },
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    tax_id: { type: DataTypes.INTEGER.UNSIGNED },
    discount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
    status: { type: DataTypes.ENUM('draft', 'sent', 'partial', 'paid', 'cancelled'), defaultValue: 'draft' },
    reason: { type: DataTypes.TEXT },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
  
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
    }, { tableName: 'debit_notes', updatedAt: false, indexes: [{ unique: true, fields: ['debit_note_id'], name: 'debit_note_id' }] });

  return DebitNote;
};

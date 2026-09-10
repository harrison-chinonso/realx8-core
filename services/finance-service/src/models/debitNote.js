module.exports = (sequelize, DataTypes) => {
  const DebitNote = sequelize.define('DebitNote', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    debit_note_id: { type: DataTypes.STRING, allowNull: false },
    /**
     * The user the note is raised against.
     *
     * Named client_id for history, but it is any user in the company —
     * `party_type` says which kind. A note is just as legitimately raised
     * against a realtor (clawing back a commission) or an employee as against a
     * client, and requiring a client meant those cases had nowhere to go.
     *
     * Nullable now: a draft can be started before the party is chosen, and the
     * controller requires it on anything that leaves draft.
     */
    client_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    // Which kind of user client_id points at. Drives the picker, and makes the
    // note readable without joining to users to find out.
    party_type: { type: DataTypes.ENUM('client', 'realtor', 'admin', 'employee'), defaultValue: 'client' },
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

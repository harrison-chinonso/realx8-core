module.exports = (sequelize, DataTypes) => {
  const CreditNote = sequelize.define('CreditNote', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    credit_note_id: { type: DataTypes.STRING, allowNull: false },
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
    /**
     * Where the note is in its approval.
     *
     * Set by the system, never by whoever raises the note. A credit note
     * writes off money owed to the company,
     * so it is raised as `pending_approval` and can only be
     * used against an invoice once
     * somebody holding `finance.notes.approve` has signed it off. Letting the
     * creator pick a status made the approval a formality performed by the
     * person who wanted the note.
     *
     * `draft`, `sent` and `partial` are kept because older rows may carry
     * them; nothing new is created in those states.
     */
    status: {
      type: DataTypes.ENUM(
        'pending_approval', 'approved', 'rejected',
        'draft', 'sent', 'partial', 'used', 'cancelled',
      ),
      defaultValue: 'pending_approval',
    },
    approved_by: { type: DataTypes.INTEGER.UNSIGNED },
    approved_at: { type: DataTypes.DATE },
    /** Why it was refused. The person who raised it is shown this. */
    rejection_reason: { type: DataTypes.TEXT },
    reason: { type: DataTypes.TEXT },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
  
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
    }, {
    tableName: 'credit_notes',
    updatedAt: false,
    /**
     * Unique WITHIN a company, not globally: every company numbers its own
     * notes from 1. A single global sequence made each company's numbers skip
     * wherever another tenant had taken the ones in between.
     */
    indexes: [{ unique: true, fields: ['company_id', 'credit_note_id'], name: 'ux_credit_notes_company_reference' }],
  });

  return CreditNote;
};

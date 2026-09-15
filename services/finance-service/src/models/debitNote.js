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
    /**
     * Where the note is in its approval.
     *
     * Set by the system, never by whoever raises the note. A debit note
     * creates money owed out of the company,
     * so it is raised as `pending_approval` and can only be
     * paid out once
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
        'draft', 'sent', 'partial', 'paid', 'cancelled',
      ),
      defaultValue: 'pending_approval',
    },
    approved_by: { type: DataTypes.INTEGER.UNSIGNED },
    approved_at: { type: DataTypes.DATE },
    /** Why it was refused. The person who raised it is shown this. */
    rejection_reason: { type: DataTypes.TEXT },
    reason: { type: DataTypes.TEXT },
    /**
     * The payment that caused this note, when the system raised it itself.
     *
     * Only set on overpayment notes. It is what makes raising idempotent: a
     * payment approval that is retried finds its own note already here and
     * does not raise a second one, which would be a second refund of the same
     * money. Null on every note a person raised by hand.
     */
    source_payment_id: { type: DataTypes.INTEGER.UNSIGNED },
    /**
     * The commission payout this note pays, when it was raised from one.
     *
     * Makes raising idempotent — a second click finds the note already there
     * rather than sending a realtor two of them — and lets the payout screen
     * show whether its note has been approved yet, which is the question an
     * admin has when they come back to mark the commission paid.
     */
    source_payout_id: { type: DataTypes.BIGINT },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
  
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
    }, {
    tableName: 'debit_notes',
    updatedAt: false,
    // Unique within a company — see creditNote.js.
    indexes: [
      { unique: true, fields: ['company_id', 'debit_note_id'], name: 'ux_debit_notes_company_reference' },
      // Unique so two concurrent approvals of the same payment cannot both
      // raise a note; the loser's insert is refused rather than duplicated.
      { unique: true, fields: ['source_payment_id'], name: 'ux_debit_notes_source_payment' },
      // Unique for the same reason: one payout, one note.
      { unique: true, fields: ['source_payout_id'], name: 'ux_debit_notes_source_payout' },
    ],
  });

  return DebitNote;
};

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
    /**
     * The four states a payment request can be in, and no others.
     *
     *   pending    the buyer has submitted proof; an admin has not decided yet.
     *              Editable and cancellable by the buyer.
     *   verified   approved, allocated against the invoice, and FROZEN. Nobody
     *              edits an approved payment — correcting one is an accounting
     *              action (credit note), not a field change.
     *   rejected   an admin refused it, with a reason. The buyer may correct
     *              and resubmit, which returns it to pending.
     *   cancelled  the buyer withdrew it. Never counts toward the invoice,
     *              which it never did anyway: only approval creates a payment.
     */
    status: {
      type: DataTypes.ENUM('pending', 'verified', 'rejected', 'cancelled'),
      defaultValue: 'pending',
    },
    verified_by: { type: DataTypes.INTEGER.UNSIGNED },
    verified_at: { type: DataTypes.DATE },
    /** The buyer's own note, written when they submitted. Theirs, not staff's. */
    notes: { type: DataTypes.TEXT },
    /**
     * Why an admin refused it, which the buyer is shown.
     *
     * Its own column because the rejection reason used to be written over
     * `notes` — silently destroying what the buyer had written, and leaving the
     * two indistinguishable afterwards.
     */
    rejection_reason: { type: DataTypes.TEXT },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
  }, {
    tableName: 'receipts',
    updatedAt: false,
    indexes: [{ unique: true, fields: ['receipt_number'], name: 'receipt_number_unique' }],
  });

  return Receipt;
};

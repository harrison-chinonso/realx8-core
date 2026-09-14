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
    /**
     * The COMPANY's own receipt, attached by an admin when they approve.
     *
     * Distinct from `document_url`, and the two are easy to confuse. That one
     * is the BUYER's proof that they paid — a transfer screenshot, a teller
     * slip — uploaded before anybody has agreed the payment is real. This is
     * what the company issues back afterwards: the document the buyer keeps.
     * Storing both in one column would lose the buyer's evidence the moment a
     * receipt was issued, which is the evidence a dispute turns on.
     *
     * Nullable, because whether it is required is a per-company setting and
     * because every receipt approved before this existed has none.
     */
    company_receipt_url: { type: DataTypes.STRING(1000) },
    /** Cloudinary's handle for the same file, so it can be managed later. */
    company_receipt_public_id: { type: DataTypes.STRING(1000) },
    company_receipt_uploaded_by: { type: DataTypes.INTEGER.UNSIGNED },
    company_receipt_uploaded_at: { type: DataTypes.DATE },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
  }, {
    tableName: 'receipts',
    updatedAt: false,
    indexes: [{ unique: true, fields: ['receipt_number'], name: 'receipt_number_unique' }],
  });

  return Receipt;
};

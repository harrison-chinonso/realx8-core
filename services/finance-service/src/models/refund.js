module.exports = (sequelize, DataTypes) => {
  /**
   * Money going back to a buyer who paid more than they owed (ACC-0.5).
   *
   * ── Why this is not a debit note ────────────────────────────────────────
   *
   * It was one. A `debit_note` was raised for the surplus and "paying" it sent
   * the money back — which is the wrong instrument twice over: a debit note in
   * ordinary accounting CHARGES a customer more, and a refund of an
   * overpayment is not a charge in either direction. It is the discharge of a
   * liability the company took on the moment it banked money it was not owed.
   *
   * The liability already exists and is already tracked: the payment plan
   * carries it as `credit_balance_minor`. This is the document that clears it,
   * and the approval that used to sit on the note sits here unchanged — the
   * decision is the same one, made by the same person, on a document whose
   * name says what it does.
   *
   * ── What it posts ──────────────────────────────────────────────────────
   *
   *   Dr  Customer credit balances     (the liability, discharged)
   *   Cr  Bank                         (the money leaving)
   *
   * Which is why it must never be modelled as negative revenue: the sale did
   * not shrink, the company simply held money that was not its own.
   */
  const Refund = sequelize.define('Refund', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    reference: { type: DataTypes.STRING(40), allowNull: false },

    /** Who is being repaid. */
    client_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    /** What they overpaid on. */
    invoice_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    amount_minor: { type: DataTypes.BIGINT, allowNull: false },

    /**
     * Waiting, agreed, sent, or refused.
     *
     * `pending_approval` because a refund is a judgement: the alternative to
     * sending it back is leaving the surplus on the plan for the next
     * instalment, which is often what the buyer wants and always cheaper than
     * two transfers. Somebody has to decide, and the reason they decided
     * stays on the row.
     */
    status: {
      type: DataTypes.ENUM('pending_approval', 'approved', 'paid', 'rejected', 'cancelled'),
      allowNull: false,
      defaultValue: 'pending_approval',
    },

    reason: { type: DataTypes.TEXT, allowNull: true },
    rejection_reason: { type: DataTypes.TEXT, allowNull: true },

    /**
     * The payment that produced the surplus.
     *
     * The idempotency anchor, exactly as it was on the note it replaces: a
     * payment approval that is retried finds its own refund already here and
     * does not raise a second one, which would be a second repayment of the
     * same money.
     */
    source_payment_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    approved_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    approved_at: { type: DataTypes.DATE, allowNull: true },
    paid_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    paid_at: { type: DataTypes.DATE, allowNull: true },
    payment_method: { type: DataTypes.STRING(40), allowNull: true },
    payment_reference: { type: DataTypes.STRING(120), allowNull: true },

    created_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
  }, {
    tableName: 'refunds',
    indexes: [
      { unique: true, fields: ['company_id', 'reference'], name: 'ux_refunds_company_reference' },
      /*
       * One refund per payment. Two concurrent approvals of the same payment
       * cannot both raise one; the loser's insert is refused rather than
       * duplicated — the same guarantee, and the same index, the debit note
       * carried.
       */
      { unique: true, fields: ['source_payment_id'], name: 'ux_refunds_source_payment' },
      { fields: ['company_id', 'status'], name: 'ix_refunds_company_status' },
      { fields: ['client_id'], name: 'ix_refunds_client' },
    ],
  });

  return Refund;
};

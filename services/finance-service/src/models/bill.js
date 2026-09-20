module.exports = (sequelize, DataTypes) => {
  /**
   * What a vendor is charging the company (ACC-4.2).
   *
   * ── The document a debit note was pretending to be ────────────────────────
   *
   * ACC-0 found `debit_notes` doing three jobs, one of which was paying a
   * realtor's commission — which in ordinary accounting is a supplier bill.
   * This is that document, built properly: a vendor, an amount, what it is
   * for, and an approval before the company is committed to pay it.
   *
   * ── Approval before payment, and the note machinery it borrows ────────────
   *
   * The same shape as the credit note it sits beside — raised, approved or
   * refused with a reason, then paid — because that machinery is well built,
   * staff already know it, and a second approval pattern would be a second
   * thing to get wrong. What is different is what approval MEANS: approving a
   * credit note reduces what somebody owes us; approving a bill commits us to
   * pay. Both are decisions, and both post.
   *
   * ── What this deliberately is not ─────────────────────────────────────────
   *
   * No purchase order, no goods-received note, no three-way matching. A
   * property developer's payables are contractors and statutory payments, and
   * both of those are a bill and an approval. Three-way matching is an
   * inventory problem and this platform has no inventory — ACC-10's
   * development WIP is a cost pool, not a stock ledger.
   */
  const Bill = sequelize.define('Bill', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    /** Per company, gap-aware, from documentSequence. Prefix BILL. */
    reference: { type: DataTypes.STRING(40), allowNull: false },
    /** What the vendor calls it on their own paperwork. */
    vendor_reference: { type: DataTypes.STRING(80), allowNull: true },

    vendor_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },

    /**
     * A bill, or a credit the vendor has given back (ACC-4.2b).
     *
     * One table and one payables subledger, for the reason the fee invoice
     * shares a table with property sales (ACC-0.1): two tables would mean two
     * things to reconcile the AP control against, and a vendor's balance
     * answerable from two places that can disagree. The discriminator says
     * which direction the document points; every amount stays positive, and
     * the posting rule decides the sides.
     */
    type: {
      type: DataTypes.ENUM('bill', 'credit_note'),
      allowNull: false,
      defaultValue: 'bill',
    },

    /**
     * Whether this cost capitalises into development WIP rather than hitting
     * the P&L (ACC-10.2).
     *
     * Named here and honoured by the posting rule, but nothing sets it to true
     * until ACC-10 defines which expense types capitalise. Present now so the
     * column does not have to be added to a table that by then has a tenant's
     * posted history in it.
     */
    capitalise: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    /**
     * Net, tax and withholding, each held separately.
     *
     * A single `amount` cannot answer any of the three questions that matter:
     * what the expense was, what input tax is recoverable, and what has to be
     * remitted rather than paid. Holding the net and deriving the rest would
     * be the same mistake in a different place — the vendor's own invoice
     * states these figures and they are what gets reconciled against.
     */
    net_minor: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    tax_minor: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    withholding_minor: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },

    /** Where the expense is coded (ACC-4.3). */
    account_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    /**
     * The project this cost belongs to, for analysis.
     *
     * Coding a cost to a property and CAPITALISING it into inventory are two
     * different acts — ACC-10.2 is what separates them, through the expense
     * type rather than through this column. A marketing spend on an estate is
     * coded here and expensed; a contractor's foundation pour is coded here
     * and capitalised.
     */
    property_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    branch_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    description: { type: DataTypes.TEXT, allowNull: true },
    /** The vendor's invoice, through the ordinary upload. */
    document_url: { type: DataTypes.STRING(500), allowNull: true },

    bill_date: { type: DataTypes.DATEONLY, allowNull: false },
    due_date: { type: DataTypes.DATEONLY, allowNull: true },

    status: {
      type: DataTypes.ENUM('draft', 'pending_approval', 'approved', 'rejected', 'paid', 'cancelled'),
      allowNull: false,
      defaultValue: 'pending_approval',
    },

    approved_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    approved_at: { type: DataTypes.DATE, allowNull: true },
    rejection_reason: { type: DataTypes.TEXT, allowNull: true },

    /** How much of it has actually been paid, so a part payment is visible. */
    paid_minor: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },

    created_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
  }, {
    tableName: 'bills',
    indexes: [
      { unique: true, fields: ['company_id', 'reference'], name: 'ux_bills_company_reference' },
      { fields: ['company_id', 'status'], name: 'ix_bills_company_status' },
      { fields: ['vendor_id'], name: 'ix_bills_vendor' },
      { fields: ['company_id', 'property_id'], name: 'ix_bills_company_property' },
    ],
  });

  return Bill;
};

module.exports = (sequelize, DataTypes) => {
  /**
   * Commission owed to someone for a sale.
   *
   * The lifecycle is CREATED → PAYMENT REQUESTED → APPROVED → PAID, and it is
   * deliberately a one-way progression with a single actor at each step: the
   * system creates, the earner requests, an admin approves, an admin pays.
   *
   * There is no partial payment anywhere in it. A commission is a single
   * obligation for a stated amount — paying half would leave a remainder with
   * no schedule and no due date, which is what the installment machinery exists
   * for and a commission is not. So `amount` is what gets paid, in one entry,
   * or nothing is.
   */
  const Commission = sequelize.define('Commission', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    // The earner. Named employee_id for history; in practice usually a realtor.
    employee_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    title: { type: DataTypes.STRING, allowNull: false },
    type: { type: DataTypes.ENUM('fixed', 'percentage'), defaultValue: 'fixed' },
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },

    /**
     * `created` replaces the old `pending`, which was ambiguous once earners
     * could request payment — pending on whom? The two are distinct states:
     * created is waiting on the earner, payment_requested is waiting on an
     * admin.
     */
    status: {
      type: DataTypes.ENUM('created', 'payment_requested', 'approved', 'paid', 'cancelled'),
      defaultValue: 'created',
    },

    /**
     * What earned it. Set when the system generates the commission on a sale,
     * and null on one an admin raised by hand.
     *
     * The unique index on invoice_id below is what stops a sale generating a
     * second commission if the paid event is ever replayed.
     */
    invoice_id: { type: DataTypes.INTEGER.UNSIGNED },
    property_id: { type: DataTypes.INTEGER.UNSIGNED },
    // The sale amount the commission was computed from, kept so the figure can
    // be explained later without re-deriving it from an invoice that may since
    // have been edited.
    basis_amount: { type: DataTypes.DECIMAL(12, 2) },
    rule_id: { type: DataTypes.INTEGER.UNSIGNED },

    requested_at: { type: DataTypes.DATE },
    approved_at: { type: DataTypes.DATE },
    approved_by: { type: DataTypes.INTEGER.UNSIGNED },
    paid_at: { type: DataTypes.DATE },
    paid_by: { type: DataTypes.INTEGER.UNSIGNED },
    // The ledger entry the payout wrote, so the two can be reconciled.
    payout_transaction_id: { type: DataTypes.INTEGER.UNSIGNED },
    notes: { type: DataTypes.TEXT },

    created_by: { type: DataTypes.INTEGER.UNSIGNED },
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
  }, {
    tableName: 'commissions',
    indexes: [
      /**
       * One commission per invoice per earner.
       *
       * The generator runs on the invoice-paid event, and an event that fires
       * twice — a replayed job, a double approval — would otherwise mint a
       * second commission for the same sale. Enforced here rather than by a
       * check in the generator, so it holds however the event arrives.
       */
      {
        unique: true,
        fields: ['invoice_id', 'employee_id'],
        name: 'commission_invoice_earner_unique',
      },
      { fields: ['employee_id', 'status'], name: 'commission_earner_status' },
    ],
  });

  return Commission;
};

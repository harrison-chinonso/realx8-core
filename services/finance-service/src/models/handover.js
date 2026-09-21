module.exports = (sequelize, DataTypes) => {
  /**
   * The moment a unit stops being the developer's (ACC-8.1).
   *
   * ── Why the platform needed a new event at all ──────────────────────────────
   *
   * For an off-plan unit sold on a 24-month plan, the invoice date and the
   * moment the company has actually earned the money are years apart. Until
   * now the platform had only the invoice date, because it had nothing else to
   * point at — so any revenue figure it produced was really a figure about
   * paperwork. This is the event the accounting has been missing.
   *
   * ── It is not only an accounting record ─────────────────────────────────────
   *
   * Handover is when the defect-liability period starts, when the unit's cost
   * releases under ACC-10.4, when the buyer's risk begins and the developer's
   * ends. It would be worth recording if it posted nothing at all, which is
   * part of why it is a first-class row rather than a date column on a sale.
   *
   * ── The attachment is not optional, and that is the point ───────────────────
   *
   * Recognition will not post without the buyer's signed acknowledgement
   * attached. An optional evidence field is an empty evidence field within a
   * quarter — and this particular field is the document an auditor asks for
   * when they ask why revenue moved. Making the posting depend on it is the
   * only version of "required" that stays true.
   *
   * ── Reversal, not deletion ──────────────────────────────────────────────────
   *
   * A handover recorded in error is reversed: the row goes to 'reversed' with
   * a reason, and the journal behind it is reversed by its own dated entry.
   * Deleting it would leave revenue recognised and nothing to explain it.
   */
  const Handover = sequelize.define('Handover', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    /** Per company, gap-aware, from documentSequence. Prefix HO. */
    reference: { type: DataTypes.STRING(40), allowNull: false },

    /**
     * What was handed over, and to whom.
     *
     * The invoice is the anchor: it is what carries the price, the buyer, the
     * deferred revenue that this event releases, and the property the cost was
     * capitalised against. A handover with no invoice behind it would have
     * nothing to recognise.
     */
    invoice_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    client_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    property_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    /** references property_units, which property-service owns. */
    property_unit_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    /**
     * The date control passed, which is not the date somebody typed it in.
     *
     * A handover entered three weeks late still recognises in the month it
     * happened — that is the whole reason the field exists separately from
     * created_at, and why period close (ACC-7.1) has to refuse one dated into
     * a closed month rather than quietly moving it.
     */
    handover_date: { type: DataTypes.DATEONLY, allowNull: false },

    /** The buyer's signed acknowledgement, through the ordinary upload guard. */
    acknowledgement_url: { type: DataTypes.STRING(500), allowNull: true },

    notes: { type: DataTypes.TEXT, allowNull: true },

    status: {
      type: DataTypes.ENUM('recorded', 'reversed'),
      allowNull: false,
      defaultValue: 'recorded',
    },
    reversal_reason: { type: DataTypes.TEXT, allowNull: true },
    reversed_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    reversed_at: { type: DataTypes.DATE, allowNull: true },

    /**
     * What was actually posted, kept on the row.
     *
     * Not derivable afterwards: the cost released was this unit's share of the
     * project pool AS IT STOOD on the day, and the pool keeps moving. Without
     * the figure recorded here the catch-up in ACC-10.4 has nothing to measure
     * against, and a margin quoted a year later would silently change.
     */
    revenue_recognised_minor: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    cost_released_minor: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },

    recorded_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
  }, {
    tableName: 'handovers',
    indexes: [
      { unique: true, fields: ['company_id', 'reference'], name: 'ux_handovers_company_reference' },
      { fields: ['company_id', 'property_id'], name: 'ix_handovers_company_property' },
      { fields: ['invoice_id'], name: 'ix_handovers_invoice' },
      { fields: ['company_id', 'handover_date'], name: 'ix_handovers_company_date' },
    ],
  });

  return Handover;
};

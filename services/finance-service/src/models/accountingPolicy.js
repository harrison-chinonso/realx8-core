module.exports = (sequelize, DataTypes) => {
  /**
   * When a sale becomes revenue, and how a project's cost is split
   * (ACC-8.2 and ACC-10.3).
   *
   * ── Why one table holds two policies ────────────────────────────────────────
   *
   * They are answered about the same thing, by the same person, at the same
   * moment. Somebody setting up Favour City Epe decides both that its units
   * are recognised at handover and that their cost divides by saleable area,
   * and both answers are about that estate. Two tables would mean two screens
   * and two chances for a project to have one of its two accounting policies
   * set.
   *
   * ── Three tiers, resolved most specific first ───────────────────────────────
   *
   * The PRD is precise that a single company-wide switch is wrong: the same
   * developer sells off-plan units, completed units and bare land on different
   * contractual terms, and under IFRS 15 the answer depends on the contract.
   * So a row can address one property, or every property of a type, or the
   * company — and the most specific row that matches wins.
   *
   * The company row is the default a new project inherits, not a value copied
   * into it. Changing the company default therefore moves every project that
   * never stated its own — which is the behaviour somebody expects from a
   * default, and the reason not to denormalise it onto the property.
   *
   * ── What a missing row means ────────────────────────────────────────────────
   *
   * Recognition on handover, and cost by saleable area. Both are the
   * conservative answer: handover defers revenue rather than bringing it
   * forward, and area is the basis a developer's own cost plan is built on.
   * Failing closed matters more here than almost anywhere else in the module,
   * because the unsafe direction — recognising early — is also the flattering
   * one.
   */
  const AccountingPolicy = sequelize.define('AccountingPolicy', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    /** What this row addresses. The narrowest matching row wins. */
    scope: {
      type: DataTypes.ENUM('company', 'property_type', 'property'),
      allowNull: false,
      defaultValue: 'company',
    },

    /** Set when scope is 'property'. */
    property_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    /** Set when scope is 'property_type' — matches properties.type. */
    property_type: { type: DataTypes.STRING(80), allowNull: true },

    /**
     * ON_INVOICE or ON_HANDOVER. Null means "say nothing here" — the next
     * tier out answers instead, which is how a property row can set the
     * allocation basis without also restating the recognition policy.
     */
    revenue_recognition: {
      type: DataTypes.ENUM('ON_INVOICE', 'ON_HANDOVER'),
      allowNull: true,
    },

    /** saleable_area or sales_value. Null defers to the next tier out. */
    cost_allocation_basis: {
      type: DataTypes.ENUM('saleable_area', 'sales_value'),
      allowNull: true,
    },

    /**
     * What the project is now expected to fetch, net of costs to complete and
     * to sell (ACC-10.5).
     *
     * Held rather than derived because it is an estimate a person makes — a
     * revised sales schedule, a repriced market — and the write-down test is
     * only as good as somebody having stated it. Null means no test has been
     * made, which the WIP report says plainly instead of assuming the project
     * is fine.
     */
    nrv_proceeds_minor: { type: DataTypes.BIGINT, allowNull: true },
    nrv_assessed_at: { type: DataTypes.DATE, allowNull: true },
    nrv_note: { type: DataTypes.STRING(240), allowNull: true },

    updated_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
  }, {
    tableName: 'accounting_policies',
    indexes: [
      { unique: true, fields: ['company_id', 'scope', 'property_id', 'property_type'], name: 'ux_accounting_policies_target' },
      { fields: ['company_id', 'property_id'], name: 'ix_accounting_policies_property' },
    ],
  });

  return AccountingPolicy;
};

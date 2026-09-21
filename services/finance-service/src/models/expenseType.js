module.exports = (sequelize, DataTypes) => {
  /**
   * What a cost IS, and therefore whether it capitalises (ACC-10.2).
   *
   * ── Replacing a tick-box with a policy ──────────────────────────────────────
   *
   * ACC-4 shipped the bill with a `capitalise` checkbox on the form, which put
   * the difference between this month's profit and the balance sheet in the
   * hands of whoever was typing. That is a weak control for a strong decision:
   * the same contractor's invoice would capitalise or not depending on who
   * raised it, and nothing afterwards could tell you which.
   *
   * The decision belongs to the KIND of cost, made once by somebody with the
   * standing to make it. Land, materials, direct labour, subcontractors, site
   * overheads and infrastructure required as a condition of planning consent
   * are part of what the unit cost to build. Selling and marketing,
   * administration and general financing are the cost of running a company and
   * belong in the period they were incurred — IAS 2.16 is explicit about it.
   *
   * ── Capitalisable is necessary, not sufficient ──────────────────────────────
   *
   * A capitalisable TYPE still only capitalises when the bill is coded to a
   * project, because a build cost with no project cannot be allocated to any
   * unit and would sit in work in progress for ever with nothing to release
   * it. The controller refuses that combination rather than quietly expensing
   * it, which would be a third silent answer.
   *
   * ── Per company, and editable ───────────────────────────────────────────────
   *
   * Seeded with a defensible set, then the company's own. A developer who
   * treats borrowing costs on a qualifying asset as capitalisable under IAS 23
   * is not wrong, and that is their accountant's call to make, not ours to
   * hardcode.
   */
  const ExpenseType = sequelize.define('ExpenseType', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    name: { type: DataTypes.STRING(120), allowNull: false },

    /** Whether a cost of this kind belongs on the balance sheet. */
    capitalisable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    /**
     * Where a cost of this kind is coded when the bill does not say.
     *
     * Optional: a type is a policy about capitalisation first and a coding
     * convenience second, and a company that wants every bill coded by hand
     * should be able to have that.
     */
    account_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    /**
     * A short note for the person choosing it on a bill.
     *
     * The seeded set uses this to say WHY a type capitalises or does not,
     * because "Site overheads" and "Administration" are not self-evidently
     * different to somebody raising their first bill.
     */
    note: { type: DataTypes.STRING(240), allowNull: true },

    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    created_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
  }, {
    tableName: 'expense_types',
    indexes: [
      { unique: true, fields: ['company_id', 'name'], name: 'ux_expense_types_company_name' },
      { fields: ['company_id', 'is_active'], name: 'ix_expense_types_company_active' },
    ],
  });

  return ExpenseType;
};

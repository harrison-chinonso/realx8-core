module.exports = (sequelize, DataTypes) => {
  /**
   * Somebody the company buys from (ACC-4.1).
   *
   * ── Why a table rather than a user ────────────────────────────────────────
   *
   * A client is a user: they sign in, they have a portal, they hold a role. A
   * contractor pouring a foundation does none of that, and modelling them as a
   * user would mean either an account nobody logs into or a permission set
   * nobody wants to reason about. A vendor is a party the company owes money
   * to and nothing else.
   *
   * The one place this gets interesting is a realtor who is also a supplier —
   * a self-employed agent invoicing for commission. That stays a realtor: the
   * commission engine already owes them through commission_payable, and giving
   * them a second identity here would make their balance answerable from two
   * places that could disagree.
   */
  const Vendor = sequelize.define('Vendor', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    name: { type: DataTypes.STRING(200), allowNull: false },
    /** What they do — 'contractor', 'supplier', 'professional', 'statutory'. */
    category: { type: DataTypes.STRING(40), allowNull: true },

    email: { type: DataTypes.STRING(160), allowNull: true },
    phone: { type: DataTypes.STRING(40), allowNull: true },
    address: { type: DataTypes.TEXT, allowNull: true },
    contact_name: { type: DataTypes.STRING(160), allowNull: true },

    bank_name: { type: DataTypes.STRING(120), allowNull: true },
    bank_account_name: { type: DataTypes.STRING(160), allowNull: true },
    bank_account_number: { type: DataTypes.STRING(40), allowNull: true },

    /**
     * Their tax identification number.
     *
     * Kept because withholding tax on a contractor payment is remitted against
     * it, and chasing a TIN after the fact is the commonest reason a WHT
     * schedule cannot be filed.
     */
    tax_id_number: { type: DataTypes.STRING(40), allowNull: true },

    /**
     * The rate withheld from this vendor's bills, as a percentage.
     *
     * Per vendor rather than per company: Nigerian WHT is 5% on most services
     * and 10% on others, and a developer pays both kinds. Null means none, and
     * none is the default — a rate applied because somebody forgot to set it
     * to zero is money withheld from a supplier who was owed it in full.
     */
    withholding_rate: { type: DataTypes.DECIMAL(5, 2), allowNull: true },

    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    created_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
  }, {
    tableName: 'vendors',
    indexes: [
      { fields: ['company_id', 'is_active'], name: 'ix_vendors_company_active' },
      { fields: ['company_id', 'name'], name: 'ix_vendors_company_name' },
    ],
  });

  return Vendor;
};

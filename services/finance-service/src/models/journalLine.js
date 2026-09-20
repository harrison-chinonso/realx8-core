module.exports = (sequelize, DataTypes) => {
  /**
   * One side of one journal entry (ACC-2.1).
   *
   * ── Why the dimensions are here and not in the chart ──────────────────────
   *
   * A line carries the property, unit, branch and realtor it relates to
   * (ACC-2.6). The alternative — an account per estate — is what turns a
   * seventy-account chart into a four-hundred-account one by the fourth
   * project, and it still cannot answer "margin per unit" because a unit is
   * finer than any chart would go.
   *
   * It is also nearly free: every source document already knows these. An
   * invoice has a property, a commission entitlement has a realtor, a purchase
   * has a branch. The dimension is copied from the document that caused the
   * posting rather than typed by anybody.
   *
   * ── account_code alongside account_id ─────────────────────────────────────
   *
   * The id is the relation; the code is what the account was CALLED when the
   * line was written. A tenant who renumbers their chart afterwards must not
   * silently restate a statement somebody has already filed, so the code is
   * captured at post time in the same way a commission records the rate it was
   * paid at.
   */
  const JournalLine = sequelize.define('JournalLine', {
    id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
    entry_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    account_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    account_code: { type: DataTypes.STRING(20), allowNull: true },
    /** The role the posting rule asked for, when it asked by role. */
    account_role: { type: DataTypes.STRING(48), allowNull: true },

    /**
     * Exactly one of these is non-zero on any line.
     *
     * Two columns rather than one signed amount: it is how a journal is read
     * on paper, it makes the balance check a sum of each column rather than a
     * sign convention nobody agrees on, and a negative debit is not a thing an
     * accountant should ever be shown.
     */
    debit_minor: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    credit_minor: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },

    memo: { type: DataTypes.STRING(500), allowNull: true },

    // ── Analysis dimensions (ACC-2.6) ──────────────────────────────────────
    property_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    unit_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    branch_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    realtor_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    /** The counterparty, for an AR or AP line — which subledger row this is. */
    party_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    party_type: { type: DataTypes.STRING(20), allowNull: true },

    /** Where in the entry this line sits, so a journal reads back in order. */
    position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, {
    tableName: 'journal_lines',
    updatedAt: false,
    createdAt: false,
    indexes: [
      { fields: ['entry_id'], name: 'ix_journal_lines_entry' },
      /** The shape a trial balance and an account ledger both read. */
      { fields: ['company_id', 'account_id'], name: 'ix_journal_lines_company_account' },
      { fields: ['company_id', 'property_id'], name: 'ix_journal_lines_company_property' },
      { fields: ['company_id', 'party_type', 'party_id'], name: 'ix_journal_lines_company_party' },
    ],
  });

  return JournalLine;
};

module.exports = (sequelize, DataTypes) => {
  /**
   * One line of a company's chart of accounts (ACC-1).
   *
   * ── Code and role are different things, deliberately ──────────────────────
   *
   * `code` is what the tenant's accountant reads and may renumber to match the
   * chart they already use. `role` is what a posting rule names, and is the
   * same string in every company — see shared/src/accounting/chart.js. A rule
   * that referred to the code would break for the first tenant who renumbered;
   * one that refers to the role survives it.
   *
   * Most accounts hold no role at all. Only the control accounts do, and there
   * is at most one account per role per company, which the unique index below
   * enforces rather than leaving to whoever edits the chart.
   */
  const LedgerAccount = sequelize.define('LedgerAccount', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    code: { type: DataTypes.STRING(20), allowNull: false },
    name: { type: DataTypes.STRING(160), allowNull: false },
    type: {
      type: DataTypes.ENUM('asset', 'liability', 'equity', 'income', 'expense'),
      allowNull: false,
    },

    /**
     * The role a posting rule addresses this account by, or null.
     *
     * Free text rather than an enum so a role added by a later epic does not
     * need a migration on a table that by then has a tenant's edits in it —
     * the same reasoning as commission_rules.realtor_category. The catalogue
     * in shared/src/accounting/chart.js is what validates it.
     */
    role: { type: DataTypes.STRING(48), allowNull: true },

    /** The code of the account above this one, for presentation only. */
    parent_code: { type: DataTypes.STRING(20), allowNull: true },

    /**
     * Deactivated rather than deleted (ACC-1.3).
     *
     * An account that has ever been posted to cannot be removed — its history
     * has to stay readable, and a journal line pointing at a row that is gone
     * is a statement that cannot be reproduced. The controller refuses the
     * delete; this is what it offers instead.
     */
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

    /**
     * Seeded by the platform rather than created by the tenant.
     *
     * Kept so the seeder can tell its own rows from an administrator's, and so
     * "reset my chart to the default" remains answerable. It does not confer
     * any protection: a seeded account is as editable as any other, which is
     * the point of seeding rather than hardcoding.
     */
    is_system: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    description: { type: DataTypes.TEXT, allowNull: true },
    created_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
  }, {
    tableName: 'ledger_accounts',
    indexes: [
      /**
       * One code per company. Two accounts numbered 1110 make every report
       * that groups by code wrong in a way nobody notices until it is audited.
       */
      { unique: true, fields: ['company_id', 'code'], name: 'ux_ledger_accounts_company_code' },
      /**
       * One account per role per company.
       *
       * Two accounts claiming ACCOUNTS_RECEIVABLE would make the posting rule's
       * choice arbitrary — whichever row came back first — and the AR control
       * would then reconcile against neither. Both engines treat NULLs as
       * distinct here, which is correct: the many accounts holding no role at
       * all are unconstrained.
       */
      { unique: true, fields: ['company_id', 'role'], name: 'ux_ledger_accounts_company_role' },
      { fields: ['company_id', 'type'], name: 'ix_ledger_accounts_company_type' },
    ],
  });

  return LedgerAccount;
};

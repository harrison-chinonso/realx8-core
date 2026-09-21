module.exports = (sequelize, DataTypes) => {
  /**
   * How one source's columns map onto ours (ACC-6.1, ACC-9.5, ACC-9.6).
   *
   * ── Saved after the first import, because the second is the same file ───────
   *
   * A bank's CSV export has the same columns every month. Asking somebody to
   * describe them twelve times a year is the kind of friction that sends a
   * finance team back to their spreadsheet — and re-describing them is also
   * twelve chances to describe them differently.
   *
   * ── One table for banks and for migrations ──────────────────────────────────
   *
   * A Sage 50 chart of accounts export and a GTBank statement are the same
   * problem: a file whose column names differ from ours in a way somebody has
   * to state once. The PRD asks for one import rather than one per package
   * (ACC-9.1), and a shared mapping table is most of what that means in
   * practice. `kind` says what the file is FOR; `source` says who produced it.
   *
   * ── Presets ship as rows, not as code ───────────────────────────────────────
   *
   * A company-less row is a preset every tenant can start from — Sage 50,
   * QuickBooks, the common Nigerian banks — and a tenant's own row overrides
   * it. Shipping them as configuration means a new bank is an afternoon and a
   * data change rather than a release.
   */
  const ImportMapping = sequelize.define('ImportMapping', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    /** Null is a preset available to every company. */
    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    /** What the file is for. */
    kind: {
      type: DataTypes.ENUM('bank_statement', 'chart_of_accounts', 'opening_balances', 'open_items', 'journal'),
      allowNull: false,
    },

    /** Who produced it: "GTBank", "Sage 50", "QuickBooks Online". */
    source: { type: DataTypes.STRING(80), allowNull: false },

    /**
     * field → the column heading in THIS source's export.
     *
     * Held as the source's own spelling rather than as a column index, because
     * banks reorder columns between exports far more often than they rename
     * them, and an index that silently shifts one place puts the reference in
     * the amount.
     */
    columns: { type: DataTypes.JSON, allowNull: false },

    /**
     * Whether this source writes 03/04 as the third of April.
     *
     * Asked once and remembered, because it cannot be inferred safely: a file
     * where every day is below the thirteenth reads identically either way and
     * puts every transaction in the wrong month if guessed wrongly.
     */
    day_first: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

    /**
     * How this source names account types (ACC-9.6).
     *
     * QuickBooks says "Other Current Asset", Sage classifies by nominal range,
     * a spreadsheet says whatever the bookkeeper typed. Unmatched types go to
     * a screen rather than being inferred.
     */
    type_map: { type: DataTypes.JSON, allowNull: true },

    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    created_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
  }, {
    tableName: 'import_mappings',
    indexes: [
      { unique: true, fields: ['company_id', 'kind', 'source'], name: 'ux_import_mappings_source' },
      { fields: ['kind'], name: 'ix_import_mappings_kind' },
    ],
  });

  return ImportMapping;
};

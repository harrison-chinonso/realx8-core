module.exports = (sequelize, DataTypes) => {
  /**
   * A month, and whether it is still open (ACC-7.1).
   *
   * ── Why a company cannot keep its books without this ────────────────────────
   *
   * Without periods, every statement is provisional for ever, because anything
   * behind it can still change. A profit figure that somebody relied on in
   * March can be different in June with nothing to say it moved. It is also the
   * first thing an auditor asks about, which is why the book-of-record decision
   * moved this out of last place in the plan.
   *
   * ── Closed means closed, including for the automatic postings ───────────────
   *
   * A payment approved today with a value date inside a closed month must be
   * REFUSED, loudly, rather than quietly posted to the current month instead.
   * Silently moving the date would make the closed month right and every
   * subsequent reconciliation wrong, and nobody would ever find it — the
   * statement for the closed month would still balance.
   *
   * ── Reopening is allowed, and recorded ──────────────────────────────────────
   *
   * A close that cannot be undone gets avoided, and a month nobody dares close
   * is worse than one that was closed and reopened with a reason attached. The
   * separate permission is the control; the reason is the audit trail.
   */
  const AccountingPeriod = sequelize.define('AccountingPeriod', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    /** What a person calls it: "September 2026", "FY2026". */
    name: { type: DataTypes.STRING(60), allowNull: false },

    starts_on: { type: DataTypes.DATEONLY, allowNull: false },
    ends_on: { type: DataTypes.DATEONLY, allowNull: false },

    /**
     * Whether this period is the last month of a financial year.
     *
     * Year end posts the profit and loss to retained earnings (ACC-7.4), and
     * that only happens on one period in twelve. Marked on the period rather
     * than inferred from the month, because a financial year ending in June is
     * ordinary and guessing December would post the wrong month's close.
     */
    is_year_end: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    status: {
      type: DataTypes.ENUM('open', 'closed'),
      allowNull: false,
      defaultValue: 'open',
    },

    closed_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    closed_at: { type: DataTypes.DATE, allowNull: true },

    /**
     * What the checklist found when it was closed, kept on the row.
     *
     * Not derivable afterwards: the whole point of a close is that the figures
     * stop moving, so a checklist re-run in a year would be answering about a
     * different ledger. This is the evidence that the checks were made and
     * what they said at the time.
     */
    checklist: { type: DataTypes.JSON, allowNull: true },

    reopened_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    reopened_at: { type: DataTypes.DATE, allowNull: true },
    reopen_reason: { type: DataTypes.TEXT, allowNull: true },

    created_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
  }, {
    tableName: 'accounting_periods',
    indexes: [
      { unique: true, fields: ['company_id', 'starts_on'], name: 'ux_accounting_periods_start' },
      { fields: ['company_id', 'status'], name: 'ix_accounting_periods_status' },
      { fields: ['company_id', 'ends_on'], name: 'ix_accounting_periods_end' },
    ],
  });

  return AccountingPeriod;
};

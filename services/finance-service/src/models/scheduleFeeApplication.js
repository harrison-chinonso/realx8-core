module.exports = (sequelize, DataTypes) => {
  /**
   * One application of a default fee to one schedule (FRD 9.3), and the record
   * that makes the daily job idempotent (FRD 9.4).
   *
   * The idempotency is enforced by the DATABASE, not by the job's control flow:
   * UNIQUE(payment_schedule_id, period_index) means a second attempt at the
   * same trigger fails the insert instead of quietly adding a second fee. A job
   * that re-runs, overlaps itself, or runs on two hosts at once still cannot
   * charge a client twice — which a "have I already done this?" check before
   * the write does not guarantee.
   *
   *   period_index 0  the first application, when grace elapsed
   *   period_index n  the nth 30-day recurrence, for MONTHLY plans
   *
   * `once` plans only ever have period_index 0.
   */
  const ScheduleFeeApplication = sequelize.define('ScheduleFeeApplication', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    payment_schedule_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    invoice_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    // Which trigger this row represents. See the note above.
    period_index: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    amount_minor: { type: DataTypes.BIGINT, allowNull: false },
    applied_at: { type: DataTypes.DATE, allowNull: false },

    /**
     * Waiver (FRD 15.5) — an admin may waive an applied fee, with a mandatory
     * reason and an audit entry.
     *
     * The application row stays; waiving is recorded ON it rather than by
     * deleting it, so the ledger still shows that the fee was charged and then
     * forgiven. The schedule's fee_outstanding drops by amount_minor.
     */
    waived_at: { type: DataTypes.DATE },
    waived_by: { type: DataTypes.INTEGER.UNSIGNED },
    waive_reason: { type: DataTypes.TEXT },

    company_id: { type: DataTypes.INTEGER.UNSIGNED },
  }, {
    tableName: 'schedule_fee_applications',
    updatedAt: false,
    indexes: [
      {
        unique: true,
        fields: ['payment_schedule_id', 'period_index'],
        name: 'schedule_fee_application_unique',
      },
    ],
  });

  return ScheduleFeeApplication;
};

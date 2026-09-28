module.exports = (sequelize, DataTypes) => {
  /**
   * One row per lapse notice actually sent to a realtor.
   *
   * ── Why this table exists ─────────────────────────────────────────────────
   *
   * The reactivation check used to decide who to tell from the clock alone:
   * everyone whose last activity fell inside a one-day band ending at the
   * threshold. That has two failure modes, and both are silent.
   *
   * Run the job twice in a day — which is exactly what a second instance does —
   * and every lapsing realtor is emailed twice. Miss a day, because the one
   * instance was deploying or asleep at 08:00, and the band moves past them:
   * they are never told at all, and nothing reports the gap.
   *
   * A record of what was sent fixes both. The query becomes "past this
   * threshold and not yet told" instead of "lapsed exactly N days ago", which
   * no longer depends on the job running at a particular minute, and the unique
   * index makes a second instance's insert fail rather than a second email
   * arrive. Same shape as schedule_reminder_sends in finance.
   */
  const RealtorReactivationNotice = sequelize.define('RealtorReactivationNotice', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    /** Which escalation step this was: 30, 60 or 90 days. */
    days: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    /**
     * The `last_active_at` the notice was computed from.
     *
     * A realtor who comes back and lapses again deserves the whole escalation
     * again. Without this the unique index would silence them for ever after
     * one cycle, so the rows are discarded once activity moves past the value
     * they were based on.
     */
    basis: { type: DataTypes.DATE },
    sent_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
  }, {
    tableName: 'realtor_reactivation_notices',
    updatedAt: false,
    indexes: [
      // The guarantee: one notice per realtor per step, enforced by the
      // database so two instances racing cannot both win.
      { unique: true, fields: ['user_id', 'days'], name: 'ux_reactivation_user_days' },
    ],
  });

  return RealtorReactivationNotice;
};

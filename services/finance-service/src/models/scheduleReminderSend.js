module.exports = (sequelize, DataTypes) => {
  /**
   * One reminder, sent once, for one installment at one offset.
   *
   * ── Why this replaces the two sent-at columns ───────────────────────────
   *
   * Reminders used to be tracked by `reminder_first_sent_at` and
   * `reminder_second_sent_at` on the schedule row. Two columns means exactly
   * two reminders, fixed forever — so a company could not ask for three, and
   * nothing after the due date could be tracked at all. A row per send lifts
   * that: any offset a company configures has somewhere to be recorded.
   *
   * ── The unique index IS the idempotency ─────────────────────────────────
   *
   * UNIQUE(payment_schedule_id, offset_days), exactly as
   * schedule_fee_applications does it. A second attempt at the same reminder
   * fails the INSERT rather than being caught by a prior check — so a job that
   * re-runs, overlaps itself, or runs on two hosts cannot email a buyer the
   * same reminder twice. Sending a duplicate reminder is not as costly as
   * charging a duplicate fee, but it is the thing that makes a buyer stop
   * reading them.
   */
  const ScheduleReminderSend = sequelize.define('ScheduleReminderSend', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    payment_schedule_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    invoice_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    /** Days relative to the due date. Negative before, 0 on, positive after. */
    offset_days: { type: DataTypes.INTEGER, allowNull: false },
    sent_at: { type: DataTypes.DATE, allowNull: false },
    /**
     * Which schedule was in force when it was sent.
     *
     * Kept because a company can edit its schedule at any time, and afterwards
     * "why did this buyer get a reminder four days late" is otherwise
     * unanswerable — the configuration that produced it no longer exists.
     */
    reminder_schedule_id: { type: DataTypes.INTEGER.UNSIGNED },
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
  }, {
    tableName: 'schedule_reminder_sends',
    updatedAt: false,
    indexes: [
      {
        unique: true,
        fields: ['payment_schedule_id', 'offset_days'],
        name: 'schedule_reminder_send_unique',
      },
    ],
  });

  return ScheduleReminderSend;
};

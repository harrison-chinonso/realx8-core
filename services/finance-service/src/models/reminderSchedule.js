module.exports = (sequelize, DataTypes) => {
  /**
   * When buyers are reminded about an installment.
   *
   * ── One table, three levels ─────────────────────────────────────────────
   *
   * A row with `company_id` NULL and `is_default` true is the PLATFORM default
   * — what every company gets until it decides otherwise. A row with a
   * company_id and `is_default` true is that company's, and wins for its
   * invoices. Any other row is a named schedule that an invoice can be put on
   * individually.
   *
   * Modelled as one table rather than three because the three are the same
   * thing at different scopes, and the resolver only has to ask for the most
   * specific row that exists (see shared/src/reminderSchedule.js). Separate
   * tables would need the same resolution logic written three times, and the
   * per-invoice case would have nowhere to live at all.
   *
   * ── Editing the platform default does not edit the platform's ────────────
   *
   * A company that changes the default gets a copy of its own. That is what
   * makes it a DEFAULT rather than a shared setting, and it is why the
   * controller creates rather than updates on a company's first edit.
   */
  const ReminderSchedule = sequelize.define('ReminderSchedule', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false },
    /** NULL is the platform's own — the fallback for every company. */
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
    /**
     * When an offset fires, relative to the installment's due date.
     *
     * Stored as JSON — `[-7, -2, 0, 2]` — because the set is variable-length
     * and a company may want one reminder or six. Negative is before the due
     * date, 0 is the day itself, positive is after.
     *
     * The alternative, a row per offset, was rejected: every read of a schedule
     * wants the whole set, and an ordering of rows is a worse representation of
     * an ordered list than an ordered list.
     */
    offsets: { type: DataTypes.JSON, allowNull: false },
    /**
     * Whether this is the fallback at its level.
     *
     * Exactly one per scope should carry it. The resolver takes the highest id
     * where more than one does, so a botched edit degrades to "the most recent
     * one wins" rather than to no reminders at all.
     */
    is_default: { type: DataTypes.BOOLEAN, defaultValue: false },
    /**
     * A schedule can be switched off without being deleted.
     *
     * Deleting one that invoices point at would silently move them back to the
     * company default, which is a change nobody asked for made by a delete.
     */
    is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
    description: { type: DataTypes.TEXT },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
  }, {
    tableName: 'reminder_schedules',
    indexes: [
      { fields: ['company_id', 'is_default'], name: 'ix_reminder_schedules_scope' },
    ],
  });

  return ReminderSchedule;
};

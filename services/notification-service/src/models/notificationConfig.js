module.exports = (sequelize, DataTypes) => {
  /**
   * Who hears about one event, for one company.
   *
   * Two levels, distinguished by company_id:
   *
   *   company_id IS NULL   the PLATFORM default set, from
   *                        shared/src/notificationEvents.js.
   *   company_id = N       company N's own configuration.
   *
   * Resolution is PER COMPANY, not per event: where a company has its own
   * configuration, that set applies in place of the platform's entirely. So a
   * company that configures one event has configured all of them — anything it
   * left out is off, not inherited. See shared/src/notificationConfig.js, where
   * that rule lives.
   */
  const NotificationConfig = sequelize.define('NotificationConfig', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    event_key: { type: DataTypes.STRING(64), allowNull: false },

    enabled: { type: DataTypes.BOOLEAN, defaultValue: true },

    /**
     * The RELATIONAL recipients — one specific person each, resolved from the
     * event's own data rather than from a role.
     *
     * `subject` is the user the event is about: the buyer on an invoice, the
     * author of a post, the applicant on a KYC submission. The catalogue gives
     * each event a label for it so the UI can say "Buyer" rather than a
     * generic word.
     *
     * `realtor` is the realtor assigned to that subject, where one exists;
     * omitted silently where none does.
     */
    notify_subject: { type: DataTypes.BOOLEAN, defaultValue: false },
    notify_realtor: { type: DataTypes.BOOLEAN, defaultValue: false },

    /**
     * The PERMISSION recipients: a JSON array of permission names. Everyone in
     * the company holding ANY of them is notified.
     *
     * This replaces what was a blunt notify_admin flag. "Invoice created" now
     * reaches whoever holds finance.invoices.view — the group that can actually
     * act on it — and a company can change who that is through the Roles screen
     * without touching notification settings at all. It also means a company
     * can target a group that is not an admin: a branch manager, a custom
     * collections role, whoever they have defined.
     *
     * Resolution is company-scoped, so a platform admin (who holds every
     * permission, and whose company_id is null) is not swept into every
     * company's events.
     */
    notify_permissions: {
      type: DataTypes.JSON,
      defaultValue: [],
      get() {
        // MySQL hands JSON back as a string on some driver/column
        // combinations, and a string here would be iterated character by
        // character downstream.
        const raw = this.getDataValue('notify_permissions');
        if (Array.isArray(raw)) return raw;
        if (typeof raw === 'string') {
          try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
        }
        return [];
      },
    },

    channel: { type: DataTypes.ENUM('in_app', 'email', 'both'), defaultValue: 'both' },

    created_by: { type: DataTypes.INTEGER.UNSIGNED },
  }, {
    tableName: 'notification_configs',
    indexes: [
      // One row per event per company. The platform rows share company_id NULL,
      // and MySQL treats NULLs as distinct in a unique index, so the platform
      // set is deduplicated by the seeder's findOrCreate rather than by this.
      {
        unique: true,
        fields: ['company_id', 'event_key'],
        name: 'notification_config_company_event_unique',
      },
    ],
  });

  return NotificationConfig;
};

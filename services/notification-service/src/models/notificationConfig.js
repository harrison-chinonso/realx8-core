module.exports = (sequelize, DataTypes) => {
  /**
   * Who hears about a purchase-journey event, and how (FRD 12.1).
   *
   * Two levels, distinguished by company_id:
   *
   *   company_id IS NULL   the PLATFORM default set — the FRD 12.2 matrix,
   *                        defined by the platform operator.
   *   company_id = N       company N's own configuration.
   *
   * Resolution is PER COMPANY, not per event (FRD 12.1): a company either has
   * its own configuration or it does not, and where it does, that set applies
   * in place of the platform's entirely. So a company that configures one event
   * has configured all of them — anything it left out is off, not inherited.
   * See shared/src/notificationConfig.js, which is where that rule lives.
   */
  const NotificationConfig = sequelize.define('NotificationConfig', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    // Null = the platform default row for this event.
    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    event_key: { type: DataTypes.STRING(64), allowNull: false },

    // Whether the notification fires at all (FRD 12.1).
    enabled: { type: DataTypes.BOOLEAN, defaultValue: true },

    // Recipients. Three flags rather than a JSON list: the recipient set is
    // fixed by the domain — a purchase has a buyer, their realtor and the
    // company's admins — and a JSON column would invite values nothing knows
    // how to deliver to.
    notify_client: { type: DataTypes.BOOLEAN, defaultValue: false },
    // The realtor assigned to the client, where one exists; silently omitted
    // where none does (FRD 12.2).
    notify_realtor: { type: DataTypes.BOOLEAN, defaultValue: false },
    notify_admin: { type: DataTypes.BOOLEAN, defaultValue: false },

    channel: { type: DataTypes.ENUM('in_app', 'email', 'both'), defaultValue: 'both' },

    created_by: { type: DataTypes.INTEGER.UNSIGNED },
  }, {
    tableName: 'notification_configs',
    indexes: [
      // One row per event per company. The platform rows share company_id NULL,
      // and MySQL treats NULLs as distinct in a unique index, so the platform
      // set is deduplicated by the seeder's findOrCreate rather than by this
      // index — see migrations/seedNotificationConfigs.js.
      {
        unique: true,
        fields: ['company_id', 'event_key'],
        name: 'notification_config_company_event_unique',
      },
    ],
  });

  return NotificationConfig;
};

const { columnsOf, isPostgres } = require('../../../../shared/src/dialect');

/**
 * notification_configs.channel: from ENUM('in_app','email','both') to text.
 *
 * Push and SMS made the channel a comma-separated set ('in_app,push',
 * 'email,push', 'in_app,email,push,sms' …) — shared/src/notificationEvents.js
 * CHANNELS — but the column was never widened, so choosing any push or SMS
 * option on Notification Settings failed to save. A set of routes is not an
 * enum; the controller validates the value against CHANNELS instead.
 *
 * Runs BEFORE sync, so sync never tries to turn the column into something
 * else on its own. Idempotent: it only acts while the column is still an enum,
 * and does nothing on a fresh database (sync creates it as text).
 */
module.exports = async function widenNotificationChannel(sequelize) {
  const columns = await columnsOf(sequelize, 'notification_configs');
  const type = String(columns?.get('channel') || '').toLowerCase();
  if (!type) return;

  if (isPostgres(sequelize)) {
    // udt_name is the enum's own type name for an enum, 'varchar' once widened.
    if (type === 'varchar' || type === 'text') return;
    await sequelize.query('ALTER TABLE notification_configs ALTER COLUMN channel DROP DEFAULT');
    await sequelize.query('ALTER TABLE notification_configs ALTER COLUMN channel TYPE VARCHAR(64) USING CAST(channel AS TEXT)');
    await sequelize.query("ALTER TABLE notification_configs ALTER COLUMN channel SET DEFAULT 'both'");
    return;
  }

  if (!type.startsWith('enum(')) return;
  await sequelize.query("ALTER TABLE notification_configs MODIFY channel VARCHAR(64) DEFAULT 'both'");
};

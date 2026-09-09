/**
 * Adds users.realtor_id — the realtor a client belongs to.
 *
 * user-service syncs with { force: false }, which never alters existing tables,
 * so the column must be added explicitly here. Idempotent.
 */
module.exports = async function addRealtorLink(sequelize) {
  const [existing] = await sequelize.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'realtor_id'`,
  ).catch(() => [[]]);
  if (existing?.length) return;

  try {
    await sequelize.query('ALTER TABLE `users` ADD COLUMN `realtor_id` INT UNSIGNED NULL AFTER `realtor_code`');
    await sequelize.query('CREATE INDEX `users_realtor_id` ON `users` (`realtor_id`)').catch(() => {});
    console.log('[migration] users.realtor_id added');
  } catch (error) {
    if (!/duplicate column/i.test(error.message)) throw error;
  }
};

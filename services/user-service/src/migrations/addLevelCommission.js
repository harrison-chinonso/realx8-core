/**
 * Commission percentage per realtor level. user-service syncs with
 * { force: false }, so the column is added explicitly. Idempotent.
 */
module.exports = async function addLevelCommission(sequelize) {
  const [existing] = await sequelize.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'realtor_levels'
        AND COLUMN_NAME = 'commission_percentage'`,
  ).catch(() => [[]]);
  if (existing?.length) return;

  await sequelize.query(
    'ALTER TABLE `realtor_levels` ADD COLUMN `commission_percentage` DECIMAL(5,2) NOT NULL DEFAULT 0 AFTER `position`',
  ).catch((error) => { if (!/duplicate column/i.test(error.message)) throw error; });
  console.log('[migration] realtor_levels.commission_percentage added');
};

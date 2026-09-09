/**
 * Realtor levels: an ordered, admin-managed tier list plus the upgrade-request
 * workflow, and the users.realtor_level_id link.
 *
 * user-service syncs with { force: false }, so nothing here is created by sync.
 * Every step is idempotent.
 *
 * Deliberately separate from users.category, which is the commission-rule
 * matching field and is left untouched.
 */
const DEFAULT_LEVELS = ['Basic', 'Professional', 'Premium', 'Ambassador'];

module.exports = async function addRealtorLevels(sequelize) {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS realtor_levels (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
      description TEXT NULL,
      position INT UNSIGNED NOT NULL DEFAULT 1,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by INT UNSIGNED NULL,
      company_id INT UNSIGNED NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      PRIMARY KEY (id),
      KEY realtor_levels_company (company_id),
      KEY realtor_levels_position (position)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS realtor_level_requests (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id INT UNSIGNED NOT NULL,
      current_level_id INT UNSIGNED NULL,
      current_level_name VARCHAR(255) NULL,
      requested_level_id INT UNSIGNED NOT NULL,
      requested_level_name VARCHAR(255) NULL,
      reason TEXT NULL,
      status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
      review_notes TEXT NULL,
      reviewed_by INT UNSIGNED NULL,
      reviewed_at DATETIME NULL,
      company_id INT UNSIGNED NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      PRIMARY KEY (id),
      KEY rlr_user (user_id),
      KEY rlr_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const [column] = await sequelize.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'realtor_level_id'`,
  ).catch(() => [[]]);
  if (!column?.length) {
    await sequelize.query('ALTER TABLE `users` ADD COLUMN `realtor_level_id` INT UNSIGNED NULL AFTER `realtor_id`')
      .catch((error) => { if (!/duplicate column/i.test(error.message)) throw error; });
    await sequelize.query('CREATE INDEX `users_realtor_level_id` ON `users` (`realtor_level_id`)').catch(() => {});
    console.log('[migration] users.realtor_level_id added');
  }

  // Seed the starter ladder per company that has none yet. Companies are
  // seeded independently so one company's edits never affect another's.
  const [companies] = await sequelize.query('SELECT id FROM companies');
  for (const company of companies) {
    const [existing] = await sequelize.query(
      'SELECT COUNT(*) AS n FROM realtor_levels WHERE company_id = :companyId',
      { replacements: { companyId: company.id } },
    );
    if (Number(existing[0].n) > 0) continue;

    for (let i = 0; i < DEFAULT_LEVELS.length; i += 1) {
      await sequelize.query(
        `INSERT INTO realtor_levels (name, position, is_active, company_id, created_at, updated_at)
         VALUES (:name, :position, 1, :companyId, NOW(), NOW())`,
        { replacements: { name: DEFAULT_LEVELS[i], position: i + 1, companyId: company.id } },
      );
    }
    console.log(`[migration] seeded ${DEFAULT_LEVELS.length} realtor levels for company ${company.id}`);
  }
};

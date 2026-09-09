const crypto = require('crypto');

const USER_TYPES = [
  'superior_admin',
  'super_admin',
  'admin',
  'employee',
  'realtor',
  'client',
  'coo',
  'csmo',
  'product_manager',
  'customer_care',
  'media_team',
  'branch_manager',
  'front_desk',
];

const ignoreIfExpected = (error, expectedMessages = []) => {
  if (expectedMessages.some((message) => error.message.includes(message))) return;
  throw error;
};

module.exports = async function addMultiTenancy(sequelize) {
  const safeQuery = async (query, expectedMessages = []) => {
    try {
      await sequelize.query(query);
    } catch (error) {
      ignoreIfExpected(error, expectedMessages);
    }
  };

  await safeQuery(`
    CREATE TABLE IF NOT EXISTS \`companies\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`name\` VARCHAR(255) NOT NULL,
      \`slug\` VARCHAR(255) NOT NULL,
      \`email\` VARCHAR(255) NOT NULL,
      \`phone\` VARCHAR(255) NULL,
      \`address\` VARCHAR(255) NULL,
      \`logo_url\` VARCHAR(255) NULL,
      \`status\` ENUM('active','suspended','pending') NOT NULL DEFAULT 'active',
      \`plan\` VARCHAR(255) NOT NULL DEFAULT 'standard',
      \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`companies_slug_unique\` (\`slug\`)
    )
  `);

  // Rename camelCase timestamp columns to snake_case for existing installs
  // (the global Sequelize config uses underscored: true)
  const RENAME_EXPECTED = ["doesn't exist", "Unknown column", "Can't DROP", 'check that column/key exists'];
  await safeQuery(
    'ALTER TABLE `companies` CHANGE `createdAt` `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP',
    RENAME_EXPECTED
  );
  await safeQuery(
    'ALTER TABLE `companies` CHANGE `updatedAt` `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
    RENAME_EXPECTED
  );

  // On a fresh install these tables don't exist yet (sync creates them after
  // migrations run).  Silently skip the ALTER when the table is missing — sync
  // will create the column from the model definition.
  const FRESH_INSTALL = ["doesn't exist", 'Table', 'Duplicate column name'];

  await safeQuery(
    'ALTER TABLE `users` ADD COLUMN `company_id` INT UNSIGNED NULL',
    FRESH_INSTALL
  );
  await safeQuery(
    'ALTER TABLE `users` ADD COLUMN `deleted_at` DATETIME NULL',
    FRESH_INSTALL
  );
  await safeQuery(
    'ALTER TABLE `settings` ADD COLUMN `company_id` INT UNSIGNED NULL',
    FRESH_INSTALL
  );
  await safeQuery(
    'ALTER TABLE `roles` ADD COLUMN `company_id` INT UNSIGNED NULL',
    FRESH_INSTALL
  );

  const enumValues = USER_TYPES.map((type) => `'${type}'`).join(',');
  await safeQuery(
    `ALTER TABLE \`users\` MODIFY COLUMN \`type\` ENUM(${enumValues}) NOT NULL DEFAULT 'client'`,
    ["doesn't exist", 'Table']
  );

  const DROP_EXPECTED = ['check that column/key exists', "Can't DROP", 'needed in a foreign key constraint', "doesn't exist"];

  // Dynamically find every single-column unique index on `key` (MySQL may rename it
  // to `key_2`, `key_3`, etc. because KEY is a reserved word).  Drop them all.
  try {
    const [singleKeyIndexes] = await sequelize.query(`
      SELECT DISTINCT s.INDEX_NAME
      FROM INFORMATION_SCHEMA.STATISTICS s
      WHERE s.TABLE_SCHEMA = DATABASE()
        AND s.TABLE_NAME   = 'settings'
        AND s.COLUMN_NAME  = 'key'
        AND s.NON_UNIQUE   = 0
        AND s.INDEX_NAME  != 'PRIMARY'
        AND s.INDEX_NAME  != 'settings_key_company_unique'
        AND s.INDEX_NAME NOT IN (
          SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME   = 'settings'
            AND SEQ_IN_INDEX > 1
        )
    `);
    for (const row of singleKeyIndexes) {
      await safeQuery(`ALTER TABLE \`settings\` DROP INDEX \`${row.INDEX_NAME}\``, DROP_EXPECTED);
    }
  } catch {
    // Table may not exist yet on a fresh install — safe to skip
  }

  // Also try the previously known hardcoded names as a belt-and-suspenders measure
  for (const idx of ['key', 'key_2', 'key_3', 'settings_key_unique', 'settings_key_key']) {
    await safeQuery(`ALTER TABLE \`settings\` DROP INDEX \`${idx}\``, DROP_EXPECTED);
  }

  await safeQuery(
    'ALTER TABLE `settings` ADD UNIQUE KEY `settings_key_company_unique` (`key`, `company_id`)',
    ['Duplicate key name', 'Duplicate entry', "doesn't exist"]
  );

  // Clean up duplicate global settings rows created by MySQL's NULL quirk.
  // The composite unique key (key, company_id) does NOT prevent duplicate rows when
  // company_id IS NULL (MySQL treats NULL != NULL for unique constraints), so every
  // Setting.upsert call for globals inserted a new row. Keep only the latest per key.
  await safeQuery(`
    DELETE s1 FROM \`settings\` s1
    INNER JOIN \`settings\` s2
      ON s1.\`key\` = s2.\`key\`
      AND s1.company_id IS NULL
      AND s2.company_id IS NULL
      AND s1.id < s2.id
  `, ['Unknown table', "doesn't exist"]);

  // ── Referral codes ──────────────────────────────────────────────────────────
  await safeQuery(
    "ALTER TABLE `companies` ADD COLUMN `referral_code` VARCHAR(5) NULL",
    ['Duplicate column name']
  );

  // Backfill existing companies that have no code yet
  const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // unambiguous chars (no 0/O/1/I)
  const genCode = () =>
    Array.from(crypto.randomBytes(5))
      .map((b) => CHARSET[b % CHARSET.length])
      .join('');

  try {
    const [rows] = await sequelize.query(
      "SELECT id FROM `companies` WHERE referral_code IS NULL OR referral_code = ''"
    );
    for (const row of rows) {
      let code;
      let attempts = 0;
      do {
        code = genCode();
        const [existing] = await sequelize.query(
          'SELECT id FROM `companies` WHERE referral_code = :code LIMIT 1',
          { replacements: { code } }
        );
        if (!existing.length) break;
        attempts++;
      } while (attempts < 20);

      await sequelize.query(
        'UPDATE `companies` SET referral_code = :code WHERE id = :id',
        { replacements: { code, id: row.id } }
      );
    }
  } catch { /* table may not exist on fresh install — sync will create it */ }

  await safeQuery(
    "ALTER TABLE `companies` ADD UNIQUE KEY `companies_referral_code_unique` (`referral_code`)",
    ['Duplicate key name', 'Duplicate entry']
  );

  // ── User enhancements ──────────────────────────────────────────────────────
  await safeQuery(
    "ALTER TABLE `users` ADD COLUMN `category` ENUM('premium','professional','basic') NULL AFTER `google_id`",
    ['Duplicate column']
  );
  await safeQuery(
    "ALTER TABLE `users` ADD COLUMN `last_active_at` DATETIME NULL AFTER `category`",
    ['Duplicate column']
  );
  await safeQuery(
    "ALTER TABLE `users` ADD COLUMN `realtor_code` VARCHAR(8) NULL AFTER `last_active_at`",
    ['Duplicate column']
  );
  await safeQuery(
    "ALTER TABLE `users` ADD UNIQUE KEY `users_realtor_code_unique` (`realtor_code`)",
    ['Duplicate key name', 'Duplicate entry']
  );
};

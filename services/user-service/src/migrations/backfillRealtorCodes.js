/**
 * Ensures every realtor has a referral code, and narrows the column to 5
 * characters to match the company code convention.
 *
 * Codes are only generated when a user is created, so realtors that predate
 * that (or were made through another path) have none. Idempotent.
 */
const crypto = require('crypto');

const CODE_LENGTH = 5;
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // unambiguous characters only

const randomCode = () => Array.from(crypto.randomBytes(CODE_LENGTH))
  .map((byte) => CHARSET[byte % CHARSET.length])
  .join('');

module.exports = async function backfillRealtorCodes(sequelize) {
  const [columns] = await sequelize.query(
    `SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'realtor_code'`,
  ).catch(() => [[]]);
  if (!columns?.length) return;

  // Shrink any over-long codes BEFORE narrowing the column, or the ALTER errors.
  const [tooLong] = await sequelize.query(
    `SELECT id FROM users WHERE realtor_code IS NOT NULL AND CHAR_LENGTH(realtor_code) > ${CODE_LENGTH}`,
  );
  const [missing] = await sequelize.query(
    "SELECT id FROM users WHERE type = 'realtor' AND (realtor_code IS NULL OR realtor_code = '') AND deleted_at IS NULL",
  );

  const needing = [...tooLong, ...missing];
  if (needing.length) {
    const [taken] = await sequelize.query('SELECT realtor_code FROM users WHERE realtor_code IS NOT NULL');
    const used = new Set(taken.map((row) => String(row.realtor_code).toUpperCase()));

    for (const user of needing) {
      let code = randomCode();
      let attempts = 0;
      while (used.has(code) && attempts < 50) { code = randomCode(); attempts += 1; }
      if (used.has(code)) throw new Error('Could not allocate a unique realtor code');
      used.add(code);
      await sequelize.query('UPDATE `users` SET realtor_code = :code WHERE id = :id', { replacements: { code, id: user.id } });
      console.log(`[migration] realtor ${user.id}: referral code -> ${code}`);
    }
  }

  if (Number(columns[0].len) !== CODE_LENGTH) {
    await sequelize.query(`ALTER TABLE \`users\` MODIFY \`realtor_code\` VARCHAR(${CODE_LENGTH}) NULL`);
    console.log(`[migration] users.realtor_code narrowed to VARCHAR(${CODE_LENGTH})`);
  }
};

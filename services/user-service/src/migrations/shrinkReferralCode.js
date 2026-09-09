/**
 * Referral codes were VARCHAR(8); they are now 5 characters.
 *
 * Order matters: existing 8-character values are regenerated FIRST, because
 * narrowing the column while longer data is present errors under MySQL strict
 * mode (and silently truncates without it — which would collide codes).
 *
 * Idempotent: once every code is <= 5 chars and the column is VARCHAR(5),
 * subsequent boots do nothing.
 */

const CODE_LENGTH = 5;
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // unambiguous chars only

const randomCode = () => Array.from(require('crypto').randomBytes(CODE_LENGTH))
  .map((byte) => CHARSET[byte % CHARSET.length])
  .join('');

module.exports = async function shrinkReferralCode(sequelize) {
  const [columns] = await sequelize.query(
    `SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'referral_code'`,
  ).catch(() => [[]]);

  // Column absent — addMultiTenancy will create it at the new width.
  if (!columns?.length) return;
  const currentLength = Number(columns[0].len);

  const [tooLong] = await sequelize.query(
    `SELECT id, referral_code FROM companies WHERE CHAR_LENGTH(referral_code) > ${CODE_LENGTH}`,
  );

  if (tooLong.length) {
    const [existing] = await sequelize.query(
      `SELECT referral_code FROM companies WHERE referral_code IS NOT NULL`,
    );
    const taken = new Set(existing.map((row) => String(row.referral_code).toUpperCase()));

    for (const company of tooLong) {
      let code = randomCode();
      let attempts = 0;
      while (taken.has(code) && attempts < 50) { code = randomCode(); attempts += 1; }
      if (taken.has(code)) throw new Error('Could not allocate a unique 5-character referral code');
      taken.add(code);

      await sequelize.query(
        'UPDATE `companies` SET referral_code = :code WHERE id = :id',
        { replacements: { code, id: company.id } },
      );
      // Logged so an operator can map old shared links to the new code.
      console.log(`[migration] company ${company.id}: referral_code ${company.referral_code} -> ${code}`);
    }
  }

  if (currentLength !== CODE_LENGTH) {
    await sequelize.query(
      `ALTER TABLE \`companies\` MODIFY \`referral_code\` VARCHAR(${CODE_LENGTH}) NULL`,
    );
    console.log(`[migration] companies.referral_code narrowed to VARCHAR(${CODE_LENGTH})`);
  }
};

const { columnsOf, q } = require('../../../../shared/src/dialect');

/**
 * Remembers, on a refresh token, the company a session is held to.
 *
 * A company's own branded mobile app signs in to that company alone
 * (shared/src/companyPin.js). The access token carries the pin, but it lasts
 * an hour; without a durable copy the first refresh would forget it, and from
 * then on the session could switch into — or join — any other company the
 * person holds, under the branded app's name.
 *
 * NULL means not pinned: every web sign-in, the general app, and every token
 * minted before this column existed.
 */
const COLUMN = 'pinned_company_id';

module.exports = async (sequelize) => {
  const present = await columnsOf(sequelize, 'refresh_tokens');
  // Null means the table is not there yet; sync creates it complete.
  if (!present || present.has(COLUMN)) return;

  await sequelize.query(
    `ALTER TABLE ${q(sequelize, 'refresh_tokens')} ADD COLUMN ${q(sequelize, COLUMN)} INTEGER NULL`,
  );
  console.log(`[refresh_tokens] ${COLUMN} added — a branded app's session stays in its company.`);
};

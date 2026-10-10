const { columnsOf } = require('../../../../shared/src/dialect');

/**
 * users.billing_hold — an account waiting in its company's queue because the
 * company had lapsed or was at its user limit when it signed up. Released by
 * the billing service when the company renews or upgrades.
 *
 * Before sync (which never adds columns to a table that exists), and the same
 * statement on both engines: BOOLEAN is TINYINT(1) on MySQL.
 */
module.exports = async function addBillingHold(sequelize) {
  const columns = await columnsOf(sequelize, 'users');
  if (!columns || columns.has('billing_hold')) return;
  await sequelize.query('ALTER TABLE users ADD COLUMN billing_hold BOOLEAN NOT NULL DEFAULT false');
};

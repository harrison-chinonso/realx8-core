const { QueryTypes } = require('sequelize');
const { q } = require('./dialect');

/**
 * Money as the company writes it, for text that reaches a person.
 *
 * Notifications and API messages used to interpolate raw numbers ("An invoice
 * of 400000"), which is not how an amount appears anywhere else in the product.
 *
 * Shared rather than private to finance-service because more than one service
 * now writes a sentence with an amount in it, and a second copy would answer
 * the currency question from the same settings row in a slightly different way
 * — which shows up as two screens quoting the same figure differently.
 */
const formatMoneyFor = async (sequelize, companyId) => {
  let code = 'USD';
  try {
    const rows = await sequelize.query(
      `SELECT ${q(sequelize, 'value')}, company_id FROM settings
        WHERE ${q(sequelize, 'group')} = 'appearance' AND ${q(sequelize, 'key')} = 'currency'
          AND (company_id IS NULL OR company_id = :companyId)`,
      { replacements: { companyId: companyId ?? null }, type: QueryTypes.SELECT },
    );
    // A company's own setting wins over the platform default.
    code = rows.find((r) => r.company_id != null)?.value
      || rows.find((r) => r.company_id == null)?.value
      || 'USD';
  } catch { /* fall back to the default below */ }

  return (value) => {
    const amount = Number(value) || 0;
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency', currency: code, currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: 0, maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      return `${code} ${amount.toLocaleString('en-US')}`;
    }
  };
};

module.exports = { formatMoneyFor };

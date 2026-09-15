const { backfillCompany } = require('../../../../shared/src/backfillCompany');

/**
 * Attaches purchase requests that lost their company.
 *
 * A purchase request with no company is invisible to the company that sold the
 * unit — which is what made the Top Performers unit card wrong in the other
 * direction: rows existed but belonged to nobody.
 */
module.exports = async (sequelize) => {
  /**
   * The PROPERTY first, then the buyer.
   *
   * A purchase request is a record of somebody buying a company's stock, so the
   * seller is the company that listed it. The buyer's own company is the
   * fallback because a client belongs to the company they registered under,
   * which is the same one in every case that is not a mistake.
   */
  return backfillCompany(sequelize, {
    table: 'property_purchase_requests',
    label: 'purchase requests',
    sources: [
      { join: 'properties', on: 'property_id', column: 'company_id', label: 'its property' },
      { join: 'users', on: 'user_id', column: 'company_id', label: 'its buyer' },
    ],
  });
};

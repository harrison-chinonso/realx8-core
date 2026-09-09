const { QueryTypes } = require('sequelize');

/**
 * The level a brand-new realtor starts on: the entry rung of the ladder that
 * company can see.
 *
 * "Entry rung" is the lowest active position among the global levels plus that
 * company's own — which is Basic on the stock ladder. Resolved by position
 * rather than by matching the name "Basic", so a company that renames or
 * replaces its first rung still gets a sensible default instead of nothing.
 *
 * Read with raw SQL on purpose: realtor_levels belongs to user-service, and a
 * second service defining a model for it would let sync({alter:true}) reshape
 * another service's table.
 *
 * Best effort by design — returns null if the ladder is empty or the lookup
 * fails. Creating an account must never break because levels are unconfigured.
 */
const defaultRealtorLevelId = async (sequelize, companyId = null) => {
  try {
    const rows = await sequelize.query(
      `SELECT id FROM realtor_levels
        WHERE is_active = 1
          AND (company_id IS NULL OR company_id = :companyId)
        ORDER BY position ASC, id ASC
        LIMIT 1`,
      { replacements: { companyId: companyId ?? null }, type: QueryTypes.SELECT },
    );
    return rows[0]?.id ?? null;
  } catch (error) {
    console.error('[realtor-level] default lookup failed:', error.message);
    return null;
  }
};

module.exports = { defaultRealtorLevelId };

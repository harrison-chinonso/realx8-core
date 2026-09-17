const { QueryTypes } = require('sequelize');

/**
 * Which ladder a company is on.
 *
 * ── One ladder, never two ──────────────────────────────────────────────────
 *
 * The platform ships a ladder — Basic, Professional, Premium, Ambassador —
 * owned by nobody (company_id IS NULL) and free to climb. A company may take
 * it as it stands, or make it their own: rename the rungs, price them, reorder
 * them, throw them away and write four of their own.
 *
 * The rule, everywhere, is: **a company uses its own rungs if it has any, and
 * the platform's otherwise.** Never a mixture.
 *
 * That last word is the whole point. The union of the two was what this used
 * to return, and a union has no sensible order: a company rung at position 10
 * and a platform rung at position 10 are both "the first level", so the entry
 * rung a new realtor landed on depended on which row the database happened to
 * return first. Positions were being pushed above the platform's to paper over
 * it, which only hid the interleaving — it did not remove it.
 *
 * Since a company's ladder replaces rather than extends, positions are simply
 * 10, 20, 30 within whichever ladder is in force.
 *
 * ── Read with raw SQL on purpose ───────────────────────────────────────────
 *
 * realtor_levels belongs to user-service and this is called from three
 * services. A second model for the table would let sync({alter:true}) in one
 * service reshape another's.
 */

/** Does this company have rungs of its own? */
const hasOwnLadder = async (sequelize, companyId, transaction = null) => {
  if (!companyId) return false;
  const rows = await sequelize.query(
    'SELECT 1 AS present FROM realtor_levels WHERE company_id = :companyId LIMIT 1',
    { replacements: { companyId }, type: QueryTypes.SELECT, transaction },
  );
  return rows.length > 0;
};

/**
 * Whose rungs this company climbs: its own id, or null for the platform's.
 *
 * The answer every caller needs, and the only question worth asking — pass it
 * straight into a `company_id = :owner` / `IS NULL` comparison.
 */
const ladderOwnerFor = async (sequelize, companyId, transaction = null) => (
  await hasOwnLadder(sequelize, companyId, transaction) ? companyId : null
);

/** A Sequelize where-fragment for the rungs this company is on. */
const ladderWhereFor = async (sequelize, companyId, transaction = null) => ({
  company_id: await ladderOwnerFor(sequelize, companyId, transaction),
});

/**
 * The level a brand-new realtor starts on: the lowest active rung of the
 * ladder in force for their company.
 *
 * Resolved by position rather than by matching the name "Basic", so a company
 * that renames or replaces its first rung still gets a sensible default.
 *
 * Best effort by design — returns null if the ladder is empty or the lookup
 * fails. Creating an account must never break because levels are unconfigured.
 */
const defaultRealtorLevelId = async (sequelize, companyId = null) => {
  try {
    const owner = await ladderOwnerFor(sequelize, companyId);
    // `is_active IS TRUE`, never `= 1` — Postgres rejects comparing a BOOLEAN
    // against an integer, and the catch below dressed that failure up as an
    // empty ladder, so new realtors quietly got no starting level.
    const rows = await sequelize.query(
      `SELECT id FROM realtor_levels
        WHERE is_active IS TRUE
          AND ${owner ? 'company_id = :owner' : 'company_id IS NULL'}
        ORDER BY position ASC, id ASC
        LIMIT 1`,
      { replacements: { owner: owner ?? null }, type: QueryTypes.SELECT },
    );
    return rows[0]?.id ?? null;
  } catch (error) {
    console.error('[realtor-level] default lookup failed:', error.message);
    return null;
  }
};

/** Every active rung of the ladder in force, lowest first. */
const ladderFor = async (sequelize, companyId = null) => {
  const owner = await ladderOwnerFor(sequelize, companyId);
  return sequelize.query(
    `SELECT id, name, commission_percentage, levelup_fee_minor, position
       FROM realtor_levels
      WHERE is_active IS TRUE
        AND ${owner ? 'company_id = :owner' : 'company_id IS NULL'}
      ORDER BY position ASC, id ASC`,
    { replacements: { owner: owner ?? null }, type: QueryTypes.SELECT },
  );
};

module.exports = {
  defaultRealtorLevelId, hasOwnLadder, ladderOwnerFor, ladderWhereFor, ladderFor,
};

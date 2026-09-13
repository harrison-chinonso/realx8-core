const { QueryTypes } = require('sequelize');
const { isPostgres, isDuplicateError } = require('./dialect');
const { randomCode, normalizeCode } = require('./shortCode');

/**
 * Short share codes, for every kind of link this application hands out.
 *
 * `referral_links` is owned by user-service. property-service mints and
 * resolves rows in it directly, for the reason invoiceGateway.js states about
 * `invoices`: all services share one database, and the alternative here is
 * worse than the coupling. A second table of property codes would be a second
 * NAMESPACE, and two independently generated seven-character codes will
 * eventually collide — at which point `/p/K7M2QXV` is ambiguous and the link
 * that resolves is whichever table was consulted first. One table, one unique
 * index, no ambiguity.
 *
 * A row says what its link MEANS:
 *
 *   company_id + no realtor + no property   a company's sign-up link
 *   company_id + realtor_code               that realtor's personal sign-up link
 *   company_id + property_id                a company's link to one property
 *   company_id + realtor_code + property_id that realtor's link to one property
 *
 * Nothing here is a credential. The code grants no access; it names who a
 * prospect came from, and every claim in it is re-validated server-side when an
 * account is actually created.
 */

/**
 * Null-safe equality, for looking a row up by a key whose parts may be null.
 *
 * `realtor_code = NULL` is never true, so a plain equality lookup for a
 * company-level link finds nothing and mints a fresh code on every call — which
 * is exactly the behaviour a printed link cannot survive. Both engines have an
 * operator for this; they spell it differently.
 */
const sameAs = (sequelize, column, param) => (isPostgres(sequelize)
  ? `${column} IS NOT DISTINCT FROM :${param}`
  : `${column} <=> :${param}`);

const ATTEMPTS = 5;

const findCode = async (sequelize, key) => {
  const [row] = await sequelize.query(
    `SELECT code FROM referral_links
      WHERE company_id = :companyId
        AND ${sameAs(sequelize, 'realtor_code', 'realtorCode')}
        AND ${sameAs(sequelize, 'property_id', 'propertyId')}
        AND revoked_at IS NULL
      LIMIT 1`,
    { replacements: key, type: QueryTypes.SELECT },
  );
  return row?.code || null;
};

/**
 * The stable short code for one (company, realtor, property), creating it on
 * first ask.
 *
 * Idempotent on purpose. Somebody who opens their referral screen — or shares
 * the same property — twice must get the SAME code both times: they print it,
 * put it in a bio, read it down the phone, and a second call that quietly
 * minted another code would orphan the one already in circulation. The unique
 * index is what actually guarantees that; the lookup above is the fast path and
 * the duplicate branch below is what makes it correct when two requests arrive
 * together.
 *
 * Returns null rather than throwing if no code could be minted — a link panel
 * should degrade to the longer link instead of failing the whole screen.
 */
const mintShareCode = async (sequelize, {
  companyId, realtorCode = null, propertyId = null, createdBy = null,
}) => {
  if (!companyId) return null;
  const key = {
    companyId: Number(companyId),
    realtorCode: realtorCode ? normalizeCode(realtorCode) : null,
    propertyId: propertyId ? Number(propertyId) : null,
  };

  const existing = await findCode(sequelize, key);
  if (existing) return existing;

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const code = randomCode();
    try {
      // eslint-disable-next-line no-await-in-loop
      await sequelize.query(
        `INSERT INTO referral_links (code, company_id, realtor_code, property_id, created_by, created_at)
         VALUES (:code, :companyId, :realtorCode, :propertyId, :createdBy, NOW())`,
        { replacements: { ...key, code, createdBy: createdBy || null }, type: QueryTypes.INSERT },
      );
      return code;
    } catch (error) {
      if (!isDuplicateError(error)) throw error;
      /**
       * Two ways to land here, and they need opposite responses.
       *
       * Either another request created the row for this same key — in which
       * case that row is the answer and we must return it — or the random code
       * collided with an unrelated link, in which case we try another. Reading
       * the row back distinguishes them.
       */
      // eslint-disable-next-line no-await-in-loop
      const raced = await findCode(sequelize, key);
      if (raced) return raced;
    }
  }
  return null;
};

/**
 * The row behind a code, or null if it is unknown or revoked.
 *
 * Revoked rows are kept rather than deleted: deleting would free the code to be
 * handed out again, and a code that once pointed at one realtor must never
 * later point at another — the old link is still in somebody's chat history.
 */
const resolveShareCode = async (sequelize, code) => {
  const [row] = await sequelize.query(
    `SELECT id, code, company_id, realtor_code, property_id, revoked_at
       FROM referral_links WHERE code = :code LIMIT 1`,
    { replacements: { code: normalizeCode(code) }, type: QueryTypes.SELECT },
  );
  if (!row || row.revoked_at) return null;
  return row;
};

module.exports = { mintShareCode, resolveShareCode };

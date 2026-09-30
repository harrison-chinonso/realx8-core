const { QueryTypes } = require('sequelize');
const { cache, KEYS, TTL } = require('./cache');
const { resolveShareCode } = require('./shareLinkGateway');
const { normalizeCode } = require('./shortCode');

/**
 * A company, found by the code people actually have in hand.
 *
 * Two kinds of code reach the sign-in and sign-up pages: the company's own
 * code (`companies.referral_code`, five characters, what staff hand out and
 * what the sign-up form has always asked for) and a company-level share code
 * from referral_links. Both name one company; the company's own code is
 * tried first because it is what a person types.
 *
 * Returns { id, name, code } — never status, counts, or anything else — and
 * null for an unknown or suspended company, the same answer for both so the
 * endpoint cannot tell a prober which codes exist but are switched off.
 * Cached, since a branded login link is opened by a company's whole staff.
 */
const companyByCode = async (sequelize, raw) => {
  const code = normalizeCode(raw);
  if (!code || code.length > 12 || !/^[0-9A-Z]+$/.test(code)) return null;
  const found = await cache.wrap(KEYS.companyByCode(code), TTL.referralLink, async () => {
    const [own] = await sequelize.query(
      'SELECT id, name, referral_code, status FROM companies WHERE referral_code = :code',
      { replacements: { code }, type: QueryTypes.SELECT },
    );
    let company = own || null;
    if (!company) {
      const link = await resolveShareCode(sequelize, code).catch(() => null);
      // A realtor's or a property's code is not a company's sign-in link.
      if (link && !link.realtor_code && !link.property_id) {
        const [row] = await sequelize.query(
          'SELECT id, name, referral_code, status FROM companies WHERE id = :id',
          { replacements: { id: link.company_id }, type: QueryTypes.SELECT },
        );
        company = row || null;
      }
    }
    // Cached as `false` for an unknown code, so a mistyped link does not cost
    // a query per visitor; wrap() does not cache null.
    if (!company || company.status === 'suspended') return false;
    return { id: Number(company.id), name: company.name, code: company.referral_code || null };
  });
  return found || null;
};

/** A company's name and code by id. Cached; null when there is no such company. */
const companyById = async (sequelize, companyId) => {
  if (companyId === null || companyId === undefined) return null;
  const found = await cache.wrap(KEYS.companyById(companyId), TTL.referralLink, async () => {
    const [row] = await sequelize.query(
      'SELECT id, name, referral_code FROM companies WHERE id = :id',
      { replacements: { id: Number(companyId) }, type: QueryTypes.SELECT },
    );
    return row ? { id: Number(row.id), name: row.name, code: row.referral_code || null } : false;
  });
  return found || null;
};

module.exports = { companyByCode, companyById };

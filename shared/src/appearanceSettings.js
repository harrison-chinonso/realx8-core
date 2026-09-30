const { QueryTypes } = require('sequelize');
const { q } = require('./dialect');
const { cache, KEYS, TTL } = require('./cache');

/**
 * A company's look and feel — platform defaults with the company's own values
 * on top — for services that are not user-service.
 *
 * It exists so a sign-in can hand the branding over WITH the session. Before
 * this, the screen learned a company's colours only after the login response
 * had landed, the token had been stored, and a second request to
 * /settings/appearance had come back: a visible beat of platform navy on every
 * sign-in.
 *
 * ── Same key, same shape ────────────────────────────────────────────────────
 *
 * Reads through the SAME cache entry user-service's getSettingsForCompany
 * uses, and builds the same object the same way (rows in id order, last row
 * per key wins within a tier, company over platform). That is what makes the
 * two interchangeable: whichever service fills the entry, the other can serve
 * it, and a settings save — which calls evictSettings on that key — retires
 * both at once. Change the merge rule in one place and it must change here.
 */
const loadAppearance = (sequelize, companyId = null) => {
  const scoped = companyId === null || companyId === undefined ? null : Number(companyId);
  return cache.wrap(KEYS.settings('appearance', scoped), TTL.settings, async () => {
    const rows = await sequelize.query(
      `SELECT ${q(sequelize, 'key')} AS k, value, company_id
         FROM settings
        WHERE ${q(sequelize, 'group')} = :group
          AND (company_id IS NULL ${scoped === null ? '' : 'OR company_id = :companyId'})
        ORDER BY id ASC`,
      { replacements: { group: 'appearance', companyId: scoped }, type: QueryTypes.SELECT },
    );
    const platform = {};
    const company = {};
    rows.forEach((row) => {
      if (row.company_id === null || row.company_id === undefined) platform[row.k] = row.value;
      else if (scoped !== null && Number(row.company_id) === scoped) company[row.k] = row.value;
    });
    return { ...platform, ...company };
  });
};

module.exports = { loadAppearance };

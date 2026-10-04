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
/**
 * A company's name and logo are its identity, so they never come from the
 * platform.
 *
 * The merge hands a company the platform's value for anything it has not set
 * itself — right for a colour or a font, wrong for a name: a company that never
 * opened Appearance showed its clients and realtors the PLATFORM's name and
 * logo on every screen, as though they had signed up to the platform rather
 * than to the company. So for a company, app_name and app_logo come from its
 * own settings, then its own record (the name it was created with, its logo),
 * and never from the platform tier. companySettings.brandForCompany applies the
 * same rule to email and receipts.
 *
 * Exported for user-service, whose loader fills the same cache entry and must
 * produce the same object.
 */
const IDENTITY_KEYS = ['app_name', 'app_logo'];

const withCompanyIdentity = async (sequelize, group, companyId, platform, company) => {
  const merged = { ...platform, ...company };
  if (group !== 'appearance' || companyId === null || companyId === undefined) return merged;
  const [record] = await sequelize.query(
    'SELECT name, logo_url FROM companies WHERE id = :id LIMIT 1',
    { replacements: { id: Number(companyId) }, type: QueryTypes.SELECT },
  ).catch(() => []);
  if (!record) return merged; // no such company: nothing better to say than the merge
  IDENTITY_KEYS.forEach((key) => { delete merged[key]; });
  merged.app_name = company.app_name || record.name || '';
  merged.app_logo = company.app_logo || record.logo_url || null;
  return merged;
};

const loadSettingsGroup = (sequelize, group, companyId = null) => {
  const scoped = companyId === null || companyId === undefined ? null : Number(companyId);
  return cache.wrap(KEYS.settings(group, scoped), TTL.settings, async () => {
    const rows = await sequelize.query(
      `SELECT ${q(sequelize, 'key')} AS k, value, company_id
         FROM settings
        WHERE ${q(sequelize, 'group')} = :group
          AND (company_id IS NULL ${scoped === null ? '' : 'OR company_id = :companyId'})
        ORDER BY id ASC`,
      { replacements: { group, companyId: scoped }, type: QueryTypes.SELECT },
    );
    const platform = {};
    const company = {};
    rows.forEach((row) => {
      if (row.company_id === null || row.company_id === undefined) platform[row.k] = row.value;
      else if (scoped !== null && Number(row.company_id) === scoped) company[row.k] = row.value;
    });
    return withCompanyIdentity(sequelize, group, scoped, platform, company);
  });
};

const loadAppearance = (sequelize, companyId = null) => loadSettingsGroup(sequelize, 'appearance', companyId);

module.exports = { loadAppearance, loadSettingsGroup, withCompanyIdentity };

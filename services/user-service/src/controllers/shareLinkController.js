const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize } = require('../models');
const { sealShareToken, openShareToken } = require('../../../../shared/src/shareLink');
const { getSettingsForCompany } = require('./userController');

/**
 * Sealed share links.
 *
 * Minting is driven entirely by the caller's own identity — never by request
 * body — so nobody can issue a link that attributes prospects to another
 * company or another realtor. Resolving is public, because the whole point is
 * that a prospect with no account can open the page already branded.
 */

const effectiveType = (req) => req.user?.effectiveType || req.user?.type;
const BRAND_KEYS = ['app_name', 'app_logo', 'primary_color', 'secondary_color', 'dark_primary_color'];

const pickBrand = (appearance = {}) => BRAND_KEYS.reduce((acc, key) => {
  if (appearance[key]) acc[key] = appearance[key];
  return acc;
}, {});

/**
 * Mint a link token for whoever is calling.
 *
 * A realtor's token carries their realtor code so the prospect is attributed to
 * them; a company admin's carries the company only.
 */
const createShareToken = asyncHandler(async (req, res) => {
  const isSuperior = req.user?.isSuperiorAdmin === true || req.user?.type === 'superior_admin';
  // A platform admin has no company of their own, so they must name one.
  const companyId = isSuperior
    ? (req.query.company_id ? Number(req.query.company_id) : null)
    : (req.user?.company_id ?? null);

  if (!companyId) {
    return res.status(400).json({
      message: isSuperior
        ? 'Specify company_id to generate a link for a company.'
        : 'Your account is not attached to a company, so a branded link cannot be generated.',
    });
  }

  const [company] = await sequelize.query(
    'SELECT id, name, referral_code, status FROM companies WHERE id = :id LIMIT 1',
    { replacements: { id: companyId }, type: QueryTypes.SELECT },
  );
  if (!company) return res.status(404).json({ message: 'Company not found' });
  if (company.status === 'suspended') {
    return res.status(403).json({ message: 'This company account is currently suspended.' });
  }

  // Only a realtor's own code, read from their record rather than the request.
  let realtorCode = null;
  if (effectiveType(req) === 'realtor') {
    const [me] = await sequelize.query(
      'SELECT realtor_code FROM users WHERE id = :id AND deleted_at IS NULL LIMIT 1',
      { replacements: { id: req.user.id }, type: QueryTypes.SELECT },
    );
    realtorCode = me?.realtor_code || null;
  }

  const { data: appearance } = await getSettingsForCompany('appearance', companyId);

  // The brand snapshot is a fallback only — resolve prefers live settings, so a
  // rebrand reaches links that were already shared.
  const token = sealShareToken({
    ci: company.id,
    cc: company.referral_code || null,
    rc: realtorCode,
    b: pickBrand(appearance),
  });

  if (!token) return res.status(500).json({ message: 'Could not generate the link.' });

  res.json({
    data: {
      token,
      company_code: company.referral_code || null,
      realtor_code: realtorCode,
    },
  });
});

/**
 * Public: turn a sealed token back into branding for the sign-up and property
 * pages. Deliberately returns no counts, ids of other records, or anything the
 * holder of a shared link should not see.
 */
const resolveShareToken = asyncHandler(async (req, res) => {
  const payload = openShareToken(req.params.token);
  // Tampered, truncated and unknown tokens are all the same answer on purpose.
  if (!payload) return res.status(404).json({ message: 'This link is not valid.' });

  const [company] = await sequelize.query(
    'SELECT id, name, referral_code, status FROM companies WHERE id = :id LIMIT 1',
    { replacements: { id: payload.ci }, type: QueryTypes.SELECT },
  );
  if (!company || company.status === 'suspended') {
    return res.status(404).json({ message: 'This link is no longer active.' });
  }

  // Re-checked against the company every time: a realtor who has since left, or
  // been moved, must not keep collecting attribution through old links.
  let realtor = null;
  if (payload.rc) {
    const [row] = await sequelize.query(
      `SELECT name, realtor_code FROM users
        WHERE UPPER(realtor_code) = UPPER(:code) AND type = 'realtor'
          AND company_id = :companyId AND deleted_at IS NULL
        LIMIT 1`,
      { replacements: { code: payload.rc, companyId: company.id }, type: QueryTypes.SELECT },
    );
    if (row) realtor = { code: row.realtor_code, name: row.name };
  }

  const { data: appearance } = await getSettingsForCompany('appearance', company.id);
  // Live settings win; the sealed snapshot only fills gaps.
  const branding = { ...(payload.b || {}), ...pickBrand(appearance) };

  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    data: {
      company: { name: company.name, code: company.referral_code || null },
      realtor,
      branding,
    },
  });
});

module.exports = { createShareToken, resolveShareToken };

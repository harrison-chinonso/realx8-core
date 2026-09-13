const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize } = require('../models');
const { sealShareToken, openShareToken } = require('../../../../shared/src/shareLink');
const { getSettingsForCompany } = require('./userController');
const { cache, KEYS, TTL } = require('../../../../shared/src/cache');
const { looksLikeShortCode, normalizeCode } = require('../../../../shared/src/shortCode');
const { mintShareCode, resolveShareCode } = require('../../../../shared/src/shareLinkGateway');

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
 * Everything a prospect's landing page needs, from a short code.
 *
 * Split out so it can be cached as one value: a link pasted into a group chat
 * is opened by many people at once, and each of them would otherwise cost the
 * same three queries.
 *
 * One resolver for every kind of code, because there is one code namespace. A
 * property link and a sign-up link differ only by whether the row names a
 * property, and the sign-up page wants the same answer from both: who shared
 * this, and how should the page look.
 */
const resolveShortCode = async (code) => {
  const link = await resolveShareCode(sequelize, code);
  if (!link) return null;

  const [company] = await sequelize.query(
    'SELECT id, name, referral_code, status FROM companies WHERE id = :id LIMIT 1',
    { replacements: { id: link.company_id }, type: QueryTypes.SELECT },
  );
  if (!company || company.status === 'suspended') return null;

  // Re-checked every time, exactly as the sealed token was: a realtor who has
  // since left, or been moved, must not keep collecting attribution.
  let realtor = null;
  if (link.realtor_code) {
    const [row] = await sequelize.query(
      `SELECT name, realtor_code FROM users
        WHERE UPPER(realtor_code) = UPPER(:code) AND type = 'realtor'
          AND company_id = :companyId AND deleted_at IS NULL
        LIMIT 1`,
      { replacements: { code: link.realtor_code, companyId: company.id }, type: QueryTypes.SELECT },
    );
    if (row) realtor = { code: row.realtor_code, name: row.name };
  }

  const { data: appearance } = await getSettingsForCompany('appearance', company.id);

  return {
    company: { name: company.name, code: company.referral_code || null },
    realtor,
    branding: pickBrand(appearance),
    /**
     * Present only on a property link, and only as an id.
     *
     * The sign-up page uses it for nothing; it is here so that a visitor who
     * arrives at /register from a shared property can be sent back to that
     * property afterwards without the caller having to hold the code twice.
     * The property's own details come from property-service, which is the
     * service that decides what a stranger may see of a property.
     */
    property_id: link.property_id ?? null,
  };
};

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

  const code = await mintShareCode(sequelize, {
    companyId: company.id,
    realtorCode,
    createdBy: req.user?.id ?? null,
  });

  /**
   * The sealed token is still returned alongside the code.
   *
   * Not because anything new should use it, but because a client built before
   * the short code existed still asks for `token` and would otherwise fall back
   * to the bare ?company_code=&realtor_code= form — which is the tamperable
   * shape the seal was introduced to remove. It costs one field to keep those
   * clients on a safe link until they are updated.
   */
  if (!code && !token) return res.status(500).json({ message: 'Could not generate the link.' });

  res.json({
    data: {
      code,
      token,
      company_code: company.referral_code || null,
      realtor_code: realtorCode,
    },
  });
});

/**
 * Public: turn a link — short code or legacy sealed token — into the branding
 * the sign-up and property pages need.
 *
 * Deliberately returns no counts, no ids of other records, and nothing else the
 * holder of a shared link should not see.
 *
 * ── Both shapes are accepted, and that is not temporary ─────────────────────
 *
 * Sealed tokens are sitting in chat histories and inboxes right now. They have
 * no expiry and nobody can be asked to re-share them, so the branch that opens
 * them stays. The short code is what gets MINTED; the token is what still gets
 * HONOURED.
 */
const resolveShareToken = asyncHandler(async (req, res) => {
  const param = req.params.token;

  if (looksLikeShortCode(param)) {
    // Upper-cased before it becomes a cache key, so a link retyped in lower
    // case shares the entry its canonical form already populated.
    const code = normalizeCode(param);
    /**
     * Read through the cache.
     *
     * The answer is the same for every prospect who opens the link, so the
     * common case — a link shared into a group and opened twenty times in a
     * minute — costs one lookup rather than twenty. The TTL is the bound on how
     * long a revoked link stays live; see cache.js.
     */
    const resolved = await cache.wrap(
      KEYS.referralLink(code),
      TTL.referralLink,
      () => resolveShortCode(code),
    );

    if (!resolved) return res.status(404).json({ message: 'This link is not valid.' });

    res.set('Cache-Control', 'public, max-age=60');
    return res.json({ data: resolved });
  }

  const payload = openShareToken(param);
  // Tampered, truncated and unknown tokens are all the same answer on purpose.
  if (!payload) return res.status(404).json({ message: 'This link is not valid.' });

  const [company] = await sequelize.query(
    'SELECT id, name, referral_code, status FROM companies WHERE id = :id LIMIT 1',
    { replacements: { id: payload.ci }, type: QueryTypes.SELECT },
  );
  if (!company || company.status === 'suspended') {
    return res.status(404).json({ message: 'This link is no longer active.' });
  }

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
  return res.json({
    data: {
      company: { name: company.name, code: company.referral_code || null },
      realtor,
      branding,
    },
  });
});

module.exports = { createShareToken, resolveShareToken };

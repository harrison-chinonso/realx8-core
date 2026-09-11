const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize } = require('../models');
const { sealShareToken, openShareToken } = require('../../../../shared/src/shareLink');
const { getSettingsForCompany } = require('./userController');
const { cache, KEYS, TTL } = require('../../../../shared/src/cache');
const { isDuplicateError } = require('../../../../shared/src/dialect');
const { ReferralLink } = require('../models');

/**
 * The alphabet a referral code is drawn from.
 *
 * No 0/O and no 1/I/L. These codes get read aloud down a phone, written on the
 * back of a card and retyped from a photograph, and those are the pairs people
 * get wrong. Thirty characters over seven positions is about 2x10^10 codes,
 * which is far more than this will ever need and long enough that guessing one
 * at random is not a way to find a live link.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 7;

const randomCode = () => Array.from(crypto.randomBytes(CODE_LENGTH))
  .map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length])
  .join('');

/** Anything this short and from this alphabet is a code, not a sealed token. */
const looksLikeShortCode = (value) => typeof value === 'string'
  && value.length <= 12
  && /^[0-9A-Z]+$/i.test(value);

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
 * The stable short code for (company, realtor), creating it on first ask.
 *
 * Idempotent on purpose. A realtor who opens their referral screen twice must
 * see the SAME code both times — they print it, put it in a bio, read it down
 * the phone — so a second call has to return the first code rather than quietly
 * minting another and orphaning the one already in circulation. The unique
 * index on (company_id, realtor_code) is what actually guarantees that; the
 * lookup below is the fast path, and the duplicate branch is what makes it
 * correct when two requests arrive together.
 */
const ATTEMPTS = 5;

const shortCodeFor = async (companyId, realtorCode) => {
  const where = { company_id: companyId, realtor_code: realtorCode || null };

  const existing = await ReferralLink.findOne({ where });
  if (existing) return existing.code;

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const created = await ReferralLink.create({ ...where, code: randomCode() });
      return created.code;
    } catch (error) {
      if (!isDuplicateError(error)) throw error;
      /**
       * Two ways to land here, and they need opposite responses.
       *
       * Either another request created the row for this same realtor — in which
       * case that row is the answer and we must return it — or the random code
       * collided with an unrelated link, in which case we try another. Reading
       * the row back distinguishes them.
       */
      // eslint-disable-next-line no-await-in-loop
      const raced = await ReferralLink.findOne({ where });
      if (raced) return raced.code;
    }
  }
  return null;
};

/**
 * Everything a prospect's landing page needs, from a short code.
 *
 * Split out so it can be cached as one value: a link pasted into a group chat
 * is opened by many people at once, and each of them would otherwise cost the
 * same three queries.
 */
const resolveShortCode = async (code) => {
  const link = await ReferralLink.findOne({
    where: { code: String(code).toUpperCase() },
  });
  if (!link || link.revoked_at) return null;

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

  const code = await shortCodeFor(company.id, realtorCode);

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
    /**
     * Read through the cache.
     *
     * The answer is the same for every prospect who opens the link, so the
     * common case — a link shared into a group and opened twenty times in a
     * minute — costs one lookup rather than twenty. The TTL is the bound on how
     * long a revoked link stays live; see cache.js.
     */
    const resolved = await cache.wrap(
      KEYS.referralLink(param),
      TTL.referralLink,
      () => resolveShortCode(param),
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

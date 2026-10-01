const { QueryTypes } = require('sequelize');
const { cache } = require('./cache');

/**
 * The Realx8 Terms of Use and Privacy Policy, and who has agreed to which
 * version of it.
 *
 * ── Versions ────────────────────────────────────────────────────────────────
 *
 * One working DRAFT, which a platform admin edits freely, and an append-only
 * line of PUBLISHED versions. Publishing copies the draft into version N+1,
 * stamped with the moment it was published — that stamp is the document's
 * "Last Updated" date, so every published edit moves it, exactly as clause
 * 67.2 promises. A published version is never changed afterwards: an
 * agreement records the version it was given to, and that text has to stay
 * what the person actually read.
 *
 * ── Who must agree, and to what ─────────────────────────────────────────────
 *
 * Realtors and clients. Each publish says whether it needs fresh acceptance
 * (a material change, clause 67.2); the first version always does. A person
 * is up to date when they have accepted a version at least as new as the
 * newest one that asked for acceptance. Nothing published yet means nothing
 * to agree to, and nobody is held up.
 *
 * Tables live in user-service (models legalDocumentVersion, legalAcceptance);
 * this module reads and writes them for any service, as the shared database
 * allows. Portable SQL only — both engines run it.
 */

const SLUG = 'terms-privacy';
const MUST_ACCEPT_TYPES = ['realtor', 'client'];
const CACHE_KEY = `legal:${SLUG}:current`;
const CACHE_TTL = 600;

/**
 * Anything that is still a placeholder: `[Insert …]` and other bracketed
 * notes (a Markdown link `[text](url)` is not one), a run of underscores left
 * for a value, or TBD / XXX.
 */
const PLACEHOLDER_PATTERNS = [
  /\[[^\]\n]+\](?!\()/g,
  /_{3,}/g,
  /\b(TBD|TBC|XXX+)\b/g,
];

const findPlaceholders = (content = '') => {
  const found = [];
  String(content).split('\n').forEach((line, index) => {
    PLACEHOLDER_PATTERNS.forEach((pattern) => {
      for (const match of line.matchAll(pattern)) found.push({ text: match[0], line: index + 1 });
    });
  });
  return found;
};

/** The current published version and the newest version that asked for acceptance. Cached. */
const currentTerms = async (sequelize) => {
  const hit = await cache.get(CACHE_KEY);
  if (hit) return hit.current ? hit : { current: null, requiredVersion: null };

  const [current] = await sequelize.query(
    `SELECT id, version, title, content, effective_date, published_at, requires_acceptance
       FROM legal_document_versions
      WHERE slug = :slug AND status = 'published'
      ORDER BY version DESC
      LIMIT 1`,
    { replacements: { slug: SLUG }, type: QueryTypes.SELECT },
  );
  const [required] = await sequelize.query(
    `SELECT MAX(version) AS version FROM legal_document_versions
      WHERE slug = :slug AND status = 'published' AND requires_acceptance = :yes`,
    { replacements: { slug: SLUG, yes: true }, type: QueryTypes.SELECT },
  );
  const value = {
    current: current ? {
      id: Number(current.id),
      version: Number(current.version),
      title: current.title,
      content: current.content,
      effective_date: current.effective_date,
      last_updated: current.published_at,
      requires_acceptance: Boolean(current.requires_acceptance),
    } : null,
    requiredVersion: required?.version ? Number(required.version) : null,
  };
  await cache.set(CACHE_KEY, value, CACHE_TTL);
  return value;
};

const evictCurrentTerms = () => cache.del(CACHE_KEY);

/** Whether this kind of account is asked to agree at all. */
const mustAgree = (user) => Boolean(user) && (
  MUST_ACCEPT_TYPES.includes(user.type) || MUST_ACCEPT_TYPES.includes(user.effectiveType)
);

const latestAcceptance = async (sequelize, userId) => {
  const [row] = await sequelize.query(
    `SELECT version, version_id, accepted_at FROM legal_acceptances
      WHERE user_id = :userId AND document_slug = :slug
      ORDER BY version DESC, accepted_at DESC
      LIMIT 1`,
    { replacements: { userId, slug: SLUG }, type: QueryTypes.SELECT },
  );
  return row ? { version: Number(row.version), version_id: Number(row.version_id), accepted_at: row.accepted_at } : null;
};

/** What the signed-in person owes: whether they must accept, and what they last accepted. */
const acceptanceStatus = async (sequelize, user) => {
  const { current, requiredVersion } = await currentTerms(sequelize);
  if (!current || !mustAgree(user)) {
    return { required: false, current: current ? meta(current) : null, accepted: null };
  }
  const accepted = await latestAcceptance(sequelize, user.id);
  const upToDate = Boolean(accepted) && accepted.version >= (requiredVersion || current.version);
  return { required: !upToDate, current: meta(current), accepted };
};

const meta = (version) => ({
  id: version.id,
  version: version.version,
  title: version.title,
  effective_date: version.effective_date,
  last_updated: version.last_updated,
});

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

/**
 * Checks an agreement before anything is created: the version must be the
 * one currently published (a document that changed while the form was open
 * must be read again, not silently agreed to), and both required statements
 * must be ticked. Returns the version, or null when nothing is published.
 */
const validateAgreement = async (sequelize, { versionId, acceptTerms, acceptPrivacy }) => {
  const { current } = await currentTerms(sequelize);
  if (!current) return null;
  if (Number(versionId) !== current.id) {
    throw httpError(409, 'The Terms of Use and Privacy Policy were updated while you were reading them. Please review the latest version and agree again.', {
      code: 'TERMS_CHANGED', current: meta(current),
    });
  }
  if (!acceptTerms || !acceptPrivacy) {
    throw httpError(422, 'Please confirm that you agree to the Terms of Use and the Privacy Policy to continue.', {
      code: 'TERMS_REQUIRED',
    });
  }
  return current;
};

/**
 * Records one agreement, with the moment it was given and where from. The
 * person's name, email and type are kept on the row as they were then, so
 * the record still reads correctly if the account is later renamed or closed.
 */
const recordAcceptance = async (sequelize, {
  user, versionId, acceptTerms, acceptPrivacy, marketingOptIn = false,
  context = 'signup', ip = null, userAgent = null, transaction = null,
}) => {
  const current = await validateAgreement(sequelize, { versionId, acceptTerms, acceptPrivacy });
  if (!current) return null;
  // Stamped by the database (NOW()), not from JavaScript: a Date bound into
  // raw SQL is written as local time by the MySQL driver and read back as UTC.
  const at = new Date();
  await sequelize.query(
    `INSERT INTO legal_acceptances
       (user_id, company_id, user_name, user_email, user_type, document_slug, version_id, version,
        accepted_terms, accepted_privacy, marketing_opt_in, context, ip_address, user_agent,
        accepted_at, created_at)
     VALUES
       (:userId, :companyId, :name, :email, :type, :slug, :versionId, :version,
        :terms, :privacy, :marketing, :context, :ip, :agent, NOW(), NOW())`,
    {
      replacements: {
        userId: user.id,
        companyId: user.company_id ?? null,
        name: user.name ? String(user.name).slice(0, 255) : null,
        email: user.email ? String(user.email).slice(0, 255) : null,
        type: user.effectiveType || user.type || null,
        slug: SLUG,
        versionId: current.id,
        version: current.version,
        terms: Boolean(acceptTerms),
        privacy: Boolean(acceptPrivacy),
        marketing: Boolean(marketingOptIn),
        context: String(context).slice(0, 32),
        ip: ip ? String(ip).slice(0, 64) : null,
        agent: userAgent ? String(userAgent).slice(0, 500) : null,
      },
      type: QueryTypes.INSERT,
      transaction,
    },
  );
  return { version_id: current.id, version: current.version, accepted_at: at };
};

/** The caller's address, for the record: the first X-Forwarded-For hop behind a proxy. */
const clientIp = (req) => String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
  || req?.clientIp || req?.ip || req?.socket?.remoteAddress || null;

module.exports = {
  SLUG,
  MUST_ACCEPT_TYPES,
  findPlaceholders,
  currentTerms,
  evictCurrentTerms,
  mustAgree,
  latestAcceptance,
  acceptanceStatus,
  validateAgreement,
  recordAcceptance,
  clientIp,
};

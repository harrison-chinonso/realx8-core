const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize } = require('../models');
const legal = require('../../../../shared/src/legalTerms');

/**
 * The Terms of Use and Privacy Policy: reading it, agreeing to it, and — for
 * platform admins only — editing it, publishing versions and seeing who
 * agreed to what, and when. See shared/src/legalTerms.js for the model.
 */

const isSuperiorAdmin = (req) => req.user?.isSuperiorAdmin === true || req.user?.type === 'superior_admin';

/** Platform admins only. The register of agreements is personal data about every user. */
const requireSuperiorAdmin = (req, res, next) => (isSuperiorAdmin(req)
  ? next()
  : res.status(403).json({ message: 'Only a platform administrator can do this.' }));

const sendError = (res, error) => res.status(error.status || 500).json({
  message: error.message, code: error.code, current: error.current, placeholders: error.placeholders,
});

// ── Everyone ────────────────────────────────────────────────────────────────

/** Public: the current published version, to read before signing up or at any time. */
const getPublicTerms = asyncHandler(async (req, res) => {
  const { current } = await legal.currentTerms(sequelize);
  if (!current) return res.status(404).json({ message: 'The Terms of Use and Privacy Policy have not been published yet.' });
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ data: current });
});

/** The signed-in person: must they agree now, and what did they last agree to? */
const getMyStatus = asyncHandler(async (req, res) => {
  res.json({ data: await legal.acceptanceStatus(sequelize, req.user) });
});

/** The signed-in person agrees to the current version (an existing account, or straight after Google sign-up). */
const acceptMine = asyncHandler(async (req, res) => {
  try {
    const result = await legal.recordAcceptance(sequelize, {
      user: req.user,
      versionId: req.body?.version_id,
      acceptTerms: req.body?.accept_terms === true,
      acceptPrivacy: req.body?.accept_privacy === true,
      marketingOptIn: req.body?.marketing_opt_in === true,
      context: req.body?.context === 'google_signup' ? 'google_signup' : 'in_app',
      ip: legal.clientIp(req),
      userAgent: req.headers?.['user-agent'],
    });
    if (!result) return res.status(404).json({ message: 'There is nothing to agree to yet.' });
    res.status(201).json({ data: result });
  } catch (error) {
    if (error.status) return sendError(res, error);
    throw error;
  }
});

// ── Platform admins ─────────────────────────────────────────────────────────

const loadDraft = async () => {
  const [draft] = await sequelize.query(
    `SELECT id, title, content, effective_date, updated_at, updated_by
       FROM legal_document_versions WHERE slug = :slug AND status = 'draft'
      ORDER BY id DESC LIMIT 1`,
    { replacements: { slug: legal.SLUG }, type: QueryTypes.SELECT },
  );
  return draft || null;
};

/** The draft being edited, every published version, and what still needs filling in. */
const adminGetDocument = asyncHandler(async (req, res) => {
  const draft = await loadDraft();
  const versions = await sequelize.query(
    `SELECT v.id, v.version, v.title, v.effective_date, v.published_at, v.requires_acceptance,
            v.change_note, u.name AS published_by_name,
            (SELECT COUNT(*) FROM legal_acceptances a WHERE a.version_id = v.id) AS acceptances
       FROM legal_document_versions v
       LEFT JOIN users u ON u.id = v.published_by
      WHERE v.slug = :slug AND v.status = 'published'
      ORDER BY v.version DESC`,
    { replacements: { slug: legal.SLUG }, type: QueryTypes.SELECT },
  );
  res.json({
    data: {
      draft: draft ? { ...draft, placeholders: legal.findPlaceholders(draft.content) } : null,
      versions: versions.map((v) => ({ ...v, acceptances: Number(v.acceptances) || 0, requires_acceptance: Boolean(v.requires_acceptance) })),
    },
  });
});

/** One published version in full — exactly the text people agreed to. */
const adminGetVersion = asyncHandler(async (req, res) => {
  const [row] = await sequelize.query(
    `SELECT id, version, title, content, effective_date, published_at, requires_acceptance, change_note
       FROM legal_document_versions WHERE id = :id AND slug = :slug AND status = 'published'`,
    { replacements: { id: Number(req.params.id), slug: legal.SLUG }, type: QueryTypes.SELECT },
  );
  if (!row) return res.status(404).json({ message: 'No such version.' });
  res.json({ data: row });
});

/** Save the working draft. Saving does not publish; users keep seeing the current version. */
const adminSaveDraft = asyncHandler(async (req, res) => {
  const title = String(req.body?.title || '').trim();
  const content = String(req.body?.content || '');
  const effectiveDate = req.body?.effective_date || null;
  if (!title) return res.status(400).json({ message: 'Give the document a title.' });
  if (!content.trim()) return res.status(400).json({ message: 'The document cannot be empty.' });
  if (effectiveDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(effectiveDate))) {
    return res.status(400).json({ message: 'Effective date must be a date (YYYY-MM-DD).' });
  }

  // Stamped by the database (NOW()), not from JavaScript: a Date bound into
  // raw SQL is written as local time by the MySQL driver and read back as UTC.
  const now = new Date();
  const draft = await loadDraft();
  if (draft) {
    await sequelize.query(
      `UPDATE legal_document_versions
          SET title = :title, content = :content, effective_date = :effective, updated_by = :by, updated_at = NOW()
        WHERE id = :id`,
      { replacements: { id: draft.id, title, content, effective: effectiveDate, by: req.user.id }, type: QueryTypes.UPDATE },
    );
  } else {
    await sequelize.query(
      `INSERT INTO legal_document_versions
         (slug, version, status, title, content, effective_date, requires_acceptance, updated_by, created_at, updated_at)
       VALUES (:slug, NULL, 'draft', :title, :content, :effective, :yes, :by, NOW(), NOW())`,
      { replacements: { slug: legal.SLUG, title, content, effective: effectiveDate, yes: true, by: req.user.id }, type: QueryTypes.INSERT },
    );
  }
  res.json({ data: { saved_at: now, placeholders: legal.findPlaceholders(content) } });
});

/**
 * Publish the draft as the next version. Refused while any placeholder
 * remains — nobody is ever asked to agree to "[Insert …]". The publish time
 * becomes the document's "Last Updated" date. `requires_acceptance` asks every
 * realtor and client to agree again (a material change, clause 67.2); the
 * first version always does.
 */
const adminPublish = asyncHandler(async (req, res) => {
  const draft = await loadDraft();
  if (!draft) return res.status(404).json({ message: 'There is no draft to publish.' });
  const placeholders = legal.findPlaceholders(draft.content);
  if (placeholders.length) {
    return sendError(res, Object.assign(new Error(
      `The document still has ${placeholders.length} placeholder${placeholders.length === 1 ? '' : 's'} to fill in before it can be published.`,
    ), { status: 422, code: 'PLACEHOLDERS', placeholders }));
  }

  const [{ latest }] = await sequelize.query(
    "SELECT MAX(version) AS latest FROM legal_document_versions WHERE slug = :slug AND status = 'published'",
    { replacements: { slug: legal.SLUG }, type: QueryTypes.SELECT },
  );
  const version = (Number(latest) || 0) + 1;
  const requiresAcceptance = version === 1 ? true : req.body?.requires_acceptance === true;
  const now = new Date();
  await sequelize.query(
    `INSERT INTO legal_document_versions
       (slug, version, status, title, content, effective_date, requires_acceptance, change_note,
        published_at, published_by, updated_by, created_at, updated_at)
     VALUES (:slug, :version, 'published', :title, :content, :effective, :requires, :note,
        NOW(), :by, :by, NOW(), NOW())`,
    {
      replacements: {
        slug: legal.SLUG,
        version,
        title: draft.title,
        content: draft.content,
        effective: draft.effective_date || now.toISOString().slice(0, 10),
        requires: requiresAcceptance,
        note: req.body?.change_note ? String(req.body.change_note).slice(0, 500) : null,
        by: req.user.id,
      },
      type: QueryTypes.INSERT,
    },
  );
  await legal.evictCurrentTerms();
  // The stamp as stored — the document's "Last Updated" date.
  const [{ published_at: publishedAt }] = await sequelize.query(
    'SELECT published_at FROM legal_document_versions WHERE slug = :slug AND version = :version',
    { replacements: { slug: legal.SLUG, version }, type: QueryTypes.SELECT },
  );
  res.status(201).json({ data: { version, published_at: publishedAt, requires_acceptance: requiresAcceptance } });
});

/** Shared filter for the register and its export: search, version, account type, company. */
const acceptanceFilter = (query) => {
  const where = ['a.document_slug = :slug'];
  const replacements = { slug: legal.SLUG };
  const search = String(query.search || '').trim().toLowerCase();
  if (search) {
    where.push('(LOWER(a.user_name) LIKE :search OR LOWER(a.user_email) LIKE :search OR LOWER(c.name) LIKE :search)');
    replacements.search = `%${search}%`;
  }
  if (query.version) { where.push('a.version = :version'); replacements.version = Number(query.version); }
  if (query.type) { where.push('a.user_type = :type'); replacements.type = String(query.type); }
  if (query.company_id) { where.push('a.company_id = :companyId'); replacements.companyId = Number(query.company_id); }
  return { where: where.join(' AND '), replacements };
};

const ACCEPTANCE_COLUMNS = `a.id, a.user_id, a.user_name, a.user_email, a.user_type, a.company_id, c.name AS company_name,
  a.version, a.version_id, a.accepted_terms, a.accepted_privacy, a.marketing_opt_in, a.context,
  a.ip_address, a.user_agent, a.accepted_at`;

/** Who agreed to which version, and when — newest first, paged. */
const adminListAcceptances = asyncHandler(async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 200);
  const { where, replacements } = acceptanceFilter(req.query);
  const [rows, [{ total }]] = await Promise.all([
    sequelize.query(
      `SELECT ${ACCEPTANCE_COLUMNS}
         FROM legal_acceptances a LEFT JOIN companies c ON c.id = a.company_id
        WHERE ${where}
        ORDER BY a.accepted_at DESC, a.id DESC
        LIMIT :limit OFFSET :offset`,
      { replacements: { ...replacements, limit, offset: (page - 1) * limit }, type: QueryTypes.SELECT },
    ),
    sequelize.query(
      `SELECT COUNT(*) AS total FROM legal_acceptances a LEFT JOIN companies c ON c.id = a.company_id WHERE ${where}`,
      { replacements, type: QueryTypes.SELECT },
    ),
  ]);
  const count = Number(total) || 0;
  res.json({
    data: rows.map((r) => ({
      ...r,
      accepted_terms: Boolean(r.accepted_terms),
      accepted_privacy: Boolean(r.accepted_privacy),
      marketing_opt_in: Boolean(r.marketing_opt_in),
    })),
    pagination: { page, limit, total: count, totalPages: Math.max(Math.ceil(count / limit), 1) },
  });
});

const csvCell = (value) => {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  // A leading = + - @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The same register as a CSV file, with the same filters. */
const adminExportAcceptances = asyncHandler(async (req, res) => {
  const { where, replacements } = acceptanceFilter(req.query);
  const rows = await sequelize.query(
    `SELECT ${ACCEPTANCE_COLUMNS}
       FROM legal_acceptances a LEFT JOIN companies c ON c.id = a.company_id
      WHERE ${where}
      ORDER BY a.accepted_at DESC, a.id DESC`,
    { replacements, type: QueryTypes.SELECT },
  );
  const header = ['Accepted at (UTC)', 'Name', 'Email', 'Account type', 'Company', 'Version', 'Terms of Use', 'Privacy Policy', 'Marketing', 'How', 'IP address', 'Device', 'User ID'];
  const lines = [header.join(',')].concat(rows.map((r) => [
    new Date(r.accepted_at), r.user_name, r.user_email, r.user_type, r.company_name, r.version,
    r.accepted_terms ? 'Agreed' : 'No', r.accepted_privacy ? 'Agreed' : 'No', r.marketing_opt_in ? 'Opted in' : 'No',
    r.context, r.ip_address, r.user_agent, r.user_id,
  ].map(csvCell).join(',')));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="terms-acceptances-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(`${lines.join('\n')}\n`);
});

module.exports = {
  requireSuperiorAdmin,
  getPublicTerms,
  getMyStatus,
  acceptMine,
  adminGetDocument,
  adminGetVersion,
  adminSaveDraft,
  adminPublish,
  adminListAcceptances,
  adminExportAcceptances,
};

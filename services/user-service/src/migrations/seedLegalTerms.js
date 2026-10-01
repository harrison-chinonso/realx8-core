const fs = require('fs');
const path = require('path');
const { QueryTypes } = require('sequelize');
const { SLUG } = require('../../../../shared/src/legalTerms');

/**
 * Loads the Realx8 Terms of Use and Privacy Policy as the first DRAFT.
 *
 * Only when the document does not exist yet — once a platform admin has
 * touched it, the database is the source of truth and this never writes again.
 * It loads as a draft, not a published version, because the text still holds
 * the business details only Realx8 can supply (RC number, addresses, the
 * DPO); the editor will not publish while any placeholder remains, so nobody
 * is ever asked to agree to "[Insert …]".
 *
 * Runs after sync, which creates the table on first boot.
 */
const SOURCE = path.join(__dirname, '..', '..', '..', '..', 'shared', 'src', 'legal', 'termsAndPrivacy.md');

module.exports = async (sequelize) => {
  const [existing] = await sequelize.query(
    'SELECT id FROM legal_document_versions WHERE slug = :slug LIMIT 1',
    { replacements: { slug: SLUG }, type: QueryTypes.SELECT },
  );
  if (existing) return;
  await sequelize.query(
    `INSERT INTO legal_document_versions
       (slug, version, status, title, content, effective_date, requires_acceptance, created_at, updated_at)
     VALUES (:slug, NULL, 'draft', :title, :content, :effective, :yes, NOW(), NOW())`,
    {
      replacements: {
        slug: SLUG,
        title: 'Realx8 Terms of Use and Privacy Policy',
        content: fs.readFileSync(SOURCE, 'utf8'),
        effective: '2026-10-01',
        yes: true,
      },
      type: QueryTypes.INSERT,
    },
  );
};

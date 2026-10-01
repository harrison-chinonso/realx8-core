module.exports = (sequelize, DataTypes) => {
  /**
   * The Terms of Use and Privacy Policy, versioned (see shared/src/legalTerms.js).
   *
   * One `draft` row per document — the working copy a platform admin edits —
   * and one `published` row per released version, numbered 1, 2, 3… and never
   * changed once written: an agreement points at the exact text it was given
   * to. `published_at` is that version's "Last Updated" date.
   */
  const LegalDocumentVersion = sequelize.define('LegalDocumentVersion', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    slug: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'terms-privacy' },
    /** null on the draft; 1, 2, 3… on published versions. */
    version: { type: DataTypes.INTEGER, allowNull: true },
    /** 'draft' or 'published'. A string rather than an enum: no enum to keep in step on Postgres. */
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'draft' },
    title: { type: DataTypes.STRING(255), allowNull: false },
    /** Markdown: headings, paragraphs, lists, tables and bold. */
    content: { type: DataTypes.TEXT('long'), allowNull: false },
    effective_date: { type: DataTypes.DATEONLY, allowNull: true },
    /** Whether users must accept this version again (clause 67.2). The first version always does. */
    requires_acceptance: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    change_note: { type: DataTypes.STRING(500), allowNull: true },
    published_at: { type: DataTypes.DATE, allowNull: true },
    published_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    updated_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
  }, {
    tableName: 'legal_document_versions',
    underscored: true,
    indexes: [
      { fields: ['slug', 'status'], name: 'ix_legal_versions_slug_status' },
      { unique: true, fields: ['slug', 'version'], name: 'ux_legal_versions_slug_version' },
    ],
  });
  return LegalDocumentVersion;
};

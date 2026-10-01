module.exports = (sequelize, DataTypes) => {
  /**
   * One person agreeing to one version of the Terms of Use and Privacy Policy.
   *
   * Append-only: a new version agreed to is a new row, so the history of what
   * somebody agreed to, and when, is kept whole. The name, email and type are
   * copied as they were at the time, so the record still reads correctly if
   * the account is renamed or closed. Read by platform admins only.
   */
  const LegalAcceptance = sequelize.define('LegalAcceptance', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    user_name: { type: DataTypes.STRING(255), allowNull: true },
    user_email: { type: DataTypes.STRING(255), allowNull: true },
    user_type: { type: DataTypes.STRING(32), allowNull: true },
    document_slug: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'terms-privacy' },
    version_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false },
    accepted_terms: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    accepted_privacy: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    marketing_opt_in: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    /** 'signup', 'google_signup' or 'in_app' (an existing account asked to accept). */
    context: { type: DataTypes.STRING(32), allowNull: true },
    ip_address: { type: DataTypes.STRING(64), allowNull: true },
    user_agent: { type: DataTypes.STRING(500), allowNull: true },
    accepted_at: { type: DataTypes.DATE, allowNull: false },
  }, {
    tableName: 'legal_acceptances',
    underscored: true,
    updatedAt: false,
    indexes: [
      { fields: ['user_id', 'document_slug'], name: 'ix_legal_acceptances_user' },
      { fields: ['version_id'], name: 'ix_legal_acceptances_version' },
      { fields: ['accepted_at'], name: 'ix_legal_acceptances_at' },
    ],
  });
  return LegalAcceptance;
};

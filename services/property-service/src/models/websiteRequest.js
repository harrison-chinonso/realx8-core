module.exports = (sequelize, DataTypes) => {
  /**
   * A request from the public website (realx8.net): someone asking to be
   * onboarded, or asking a question the website assistant could not answer.
   *
   * Platform-level, not company-scoped — the person is not anyone's user yet.
   * Platform admins work through these on Website requests in the app, moving
   * each from new → contacted → onboarded (or closed).
   */
  const WebsiteRequest = sequelize.define('WebsiteRequest', {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    /** What the person is given to quote back, e.g. RX-2026-0042. Set after insert, from the id. */
    reference: { type: DataTypes.STRING(20) },
    /** 'onboarding' (set my company up) or 'enquiry' (a question for the team). */
    kind: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'onboarding' },
    company_name: { type: DataTypes.STRING(160) },
    contact_name: { type: DataTypes.STRING(120), allowNull: false },
    email: { type: DataTypes.STRING(160), allowNull: false },
    phone: { type: DataTypes.STRING(40) },
    business_type: { type: DataTypes.STRING(60) },
    realtor_count: { type: DataTypes.STRING(40) },
    /** The features they ticked, as a comma-separated list of labels. */
    interests: { type: DataTypes.STRING(500) },
    message: { type: DataTypes.TEXT },
    /** 'form' or 'assistant' — which part of the website raised it. */
    source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'form' },
    /** new | contacted | onboarded | closed. Text, not an enum, so a stage can be added without a migration. */
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'new' },
    /** Platform admins' own notes on the follow-up. */
    admin_notes: { type: DataTypes.TEXT },
    handled_by: { type: DataTypes.INTEGER.UNSIGNED },
    ip_address: { type: DataTypes.STRING(64) },
    user_agent: { type: DataTypes.STRING(255) },
  }, {
    tableName: 'website_requests',
    indexes: [
      { fields: ['status'] },
      { fields: ['email'] },
    ],
  });

  return WebsiteRequest;
};

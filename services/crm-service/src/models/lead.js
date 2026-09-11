module.exports = (sequelize, DataTypes) => {
  const Lead = sequelize.define('Lead', {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    name: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING },
    phone: { type: DataTypes.STRING },
    source_id: { type: DataTypes.INTEGER.UNSIGNED },
    pipeline_id: { type: DataTypes.INTEGER.UNSIGNED },
    stage_id: { type: DataTypes.INTEGER.UNSIGNED },
    label_id: { type: DataTypes.INTEGER.UNSIGNED },
    status: { type: DataTypes.STRING, defaultValue: 'new' },
    assigned_to: { type: DataTypes.INTEGER.UNSIGNED },
    // Who raised the lead — lets a realtor see leads they created as well as
    // those assigned to them.
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
    description: { type: DataTypes.TEXT },
    budget_category: { type: DataTypes.STRING },
    property_profile: { type: DataTypes.STRING },
    intent_driver: { type: DataTypes.STRING },
    purchase_window: { type: DataTypes.STRING },
    lead_thermal: { type: DataTypes.STRING, defaultValue: 'Cold' },
// Add ai_score field
    // SMALLINT rather than TINYINT: Postgres has no native TINYINT, and
    // Sequelize cannot translate it there (unlike UNSIGNED, which it can
    // just drop) — the score only needs to hold 0-100 either way.
    ai_score: {
      type: DataTypes.SMALLINT.UNSIGNED,
      defaultValue: 0,
    },
  
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
    }, { tableName: 'leads', updatedAt: false });

  return Lead;
};

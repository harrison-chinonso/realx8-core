module.exports = (sequelize, DataTypes) => {
  const TrainingModule = sequelize.define('TrainingModule', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    title: { type: DataTypes.STRING, allowNull: false },
    category: { type: DataTypes.ENUM('sales', 'legal', 'operations', 'sop'), allowNull: false },
    duration: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT },
    video_url: { type: DataTypes.STRING },
    resource_links: { type: DataTypes.JSON, defaultValue: [] },
    status: { type: DataTypes.ENUM('draft', 'active'), defaultValue: 'draft' },
    has_quiz: { type: DataTypes.BOOLEAN, defaultValue: false },
    quiz_data: { type: DataTypes.JSON, defaultValue: [] },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
    /**
     * The company this module belongs to, or NULL when it was published by a
     * platform admin. Company-scoped modules are visible only to that
     * company's own managers and realtors; a NULL one is a platform-wide
     * module visible to everyone (see realtorHubController's trainingScopeFor).
     */
    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
  }, { tableName: 'training_modules' });

  return TrainingModule;
};

module.exports = (sequelize, DataTypes) => {
  const LeadStage = sequelize.define('LeadStage', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false },
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
  }, { tableName: 'lead_stages', updatedAt: false });

  return LeadStage;
};

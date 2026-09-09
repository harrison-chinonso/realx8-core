module.exports = (sequelize, DataTypes) => {
  const Activity = sequelize.define('Activity', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    lead_id: { type: DataTypes.INTEGER.UNSIGNED },
    deal_id: { type: DataTypes.INTEGER.UNSIGNED },
    type: { type: DataTypes.ENUM('call', 'email', 'meeting', 'note', 'follow_up'), allowNull: false },
    description: { type: DataTypes.TEXT },
    activity_date: { type: DataTypes.DATEONLY },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
  }, { tableName: 'activities' });

  return Activity;
};

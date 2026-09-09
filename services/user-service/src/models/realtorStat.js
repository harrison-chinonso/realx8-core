module.exports = (sequelize, DataTypes) => {
  const RealtorStat = sequelize.define('RealtorStat', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    realtor_id: { type: DataTypes.INTEGER.UNSIGNED },
    realtor_name: { type: DataTypes.STRING, allowNull: false },
    branch: { type: DataTypes.STRING, allowNull: false },
    total_sales: { type: DataTypes.DECIMAL(14, 2), defaultValue: 0 },
    inspections_count: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
    leads_closed: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
    active_deals: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
    points: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
    period_start: { type: DataTypes.DATEONLY },
    period_end: { type: DataTypes.DATEONLY },
  }, { tableName: 'realtor_stats' });

  return RealtorStat;
};

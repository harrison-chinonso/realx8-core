module.exports = (sequelize, DataTypes) => {
  const Recruit = sequelize.define('Recruit', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, allowNull: false },
    phone: { type: DataTypes.STRING },
    status: { type: DataTypes.ENUM('applied', 'training', 'active', 'inactive'), defaultValue: 'applied' },
    join_date: { type: DataTypes.DATEONLY, allowNull: false },
    referred_by_id: { type: DataTypes.INTEGER.UNSIGNED },
    referred_by_name: { type: DataTypes.STRING, allowNull: false },
    commission_earned: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
    notes: { type: DataTypes.TEXT },
  }, { tableName: 'recruits' });

  return Recruit;
};

module.exports = (sequelize, DataTypes) => {
  const CareAlert = sequelize.define('CareAlert', {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    client_name: { type: DataTypes.STRING, allowNull: false },
    alert_type: { type: DataTypes.ENUM('birthday', 'festival', 'maturity', 'balance', 'payment', 'welcome'), allowNull: false },
    trigger_date: { type: DataTypes.DATEONLY, allowNull: false },
    message: { type: DataTypes.TEXT, allowNull: false },
    status: { type: DataTypes.ENUM('pending', 'sent'), allowNull: false, defaultValue: 'pending' },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
  
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
    }, { tableName: 'care_alerts' });

  return CareAlert;
};

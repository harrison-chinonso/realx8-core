module.exports = (sequelize, DataTypes) => {
  const CommunicationLog = sequelize.define('CommunicationLog', {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    client_name: { type: DataTypes.STRING, allowNull: false },
    type: { type: DataTypes.ENUM('birthday', 'festival', 'maturity', 'balance', 'custom'), allowNull: false, defaultValue: 'custom' },
    message: { type: DataTypes.TEXT, allowNull: false },
    sent_at: { type: DataTypes.DATE },
    delivery_status: { type: DataTypes.ENUM('pending', 'sent', 'failed'), allowNull: false, defaultValue: 'pending' },
    scheduled_at: { type: DataTypes.DATE },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
  
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
    }, { tableName: 'communication_logs' });

  return CommunicationLog;
};

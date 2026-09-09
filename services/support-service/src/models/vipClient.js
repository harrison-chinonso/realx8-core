module.exports = (sequelize, DataTypes) => {
  const VipClient = sequelize.define('VipClient', {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    client_id: { type: DataTypes.INTEGER.UNSIGNED },
    client_name: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING },
    phone: { type: DataTypes.STRING },
    total_amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    investment_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    tier: { type: DataTypes.ENUM('gold', 'platinum'), allowNull: false, defaultValue: 'gold' },
    status: { type: DataTypes.ENUM('active', 'inactive'), allowNull: false, defaultValue: 'active' },
    notes: { type: DataTypes.TEXT },
  
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
    }, { tableName: 'vip_clients' });

  return VipClient;
};

module.exports = (sequelize, DataTypes) => {
  const Visitor = sequelize.define('Visitor', {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    pass_number: { type: DataTypes.STRING, allowNull: false, unique: true },
    full_name: { type: DataTypes.STRING, allowNull: false },
    phone: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING },
    purpose: { type: DataTypes.STRING, allowNull: false },
    host_name: { type: DataTypes.STRING, allowNull: false },
    check_in: { type: DataTypes.DATE, allowNull: false },
    check_out: { type: DataTypes.DATE },
    status: { type: DataTypes.ENUM('in', 'out'), allowNull: false, defaultValue: 'in' },
    note: { type: DataTypes.TEXT },
  
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
    }, { tableName: 'visitors' });

  return Visitor;
};

module.exports = (sequelize, DataTypes) => {
  const Commission = sequelize.define('Commission', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    employee_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    title: { type: DataTypes.STRING, allowNull: false },
    type: { type: DataTypes.ENUM('fixed', 'percentage'), defaultValue: 'fixed' },
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    status: { type: DataTypes.ENUM('pending', 'approved', 'paid', 'cancelled'), defaultValue: 'pending' },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
  
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
    }, { tableName: 'commissions', updatedAt: false });

  return Commission;
};

module.exports = (sequelize, DataTypes) => {
  const PaymentReminder = sequelize.define('PaymentReminder', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    invoice_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    client_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    reminder_date: { type: DataTypes.DATE, allowNull: false },
    message: { type: DataTypes.TEXT },
    status: { type: DataTypes.ENUM('pending', 'sent', 'cancelled'), defaultValue: 'pending' },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
  
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
    }, { tableName: 'payment_reminders', updatedAt: false });

  return PaymentReminder;
};

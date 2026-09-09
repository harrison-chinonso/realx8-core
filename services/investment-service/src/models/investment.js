module.exports = (sequelize, DataTypes) => {
      const Investment = sequelize.define('Investment', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
plan_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
status: { type: DataTypes.ENUM('pending', 'active', 'completed', 'cancelled'), defaultValue: 'pending' },
start_date: { type: DataTypes.DATE },
end_date: { type: DataTypes.DATE },
// Cash-out request workflow
cash_out_status: {
  type: DataTypes.ENUM('not_requested', 'requested', 'approved', 'rejected', 'paid'),
  defaultValue: 'not_requested',
},
cash_out_requested_at: { type: DataTypes.DATE },
cash_out_notes: { type: DataTypes.TEXT },
cash_out_approved_by: { type: DataTypes.INTEGER.UNSIGNED },
created_by: { type: DataTypes.INTEGER.UNSIGNED },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'investments', updatedAt: false });

      return Investment;
    };

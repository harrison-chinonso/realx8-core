module.exports = (sequelize, DataTypes) => {
      const Deal = sequelize.define('Deal', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

name: { type: DataTypes.STRING, allowNull: false },
amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
pipeline_id: { type: DataTypes.INTEGER.UNSIGNED },
stage_id: { type: DataTypes.INTEGER.UNSIGNED },
lead_id: { type: DataTypes.INTEGER.UNSIGNED },
status: { type: DataTypes.STRING, defaultValue: 'open' },
assigned_to: { type: DataTypes.INTEGER.UNSIGNED },
expected_close_date: { type: DataTypes.DATE },
created_by: { type: DataTypes.INTEGER.UNSIGNED },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'deals', updatedAt: false });

      return Deal;
    };

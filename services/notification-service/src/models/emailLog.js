module.exports = (sequelize, DataTypes) => {
      const EmailLog = sequelize.define('EmailLog', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

to: { type: DataTypes.STRING, allowNull: false },
subject: { type: DataTypes.STRING, allowNull: false },
body: { type: DataTypes.TEXT, allowNull: false },
status: { type: DataTypes.STRING, defaultValue: 'queued' },
error: { type: DataTypes.TEXT },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'email_logs', updatedAt: false });

      return EmailLog;
    };

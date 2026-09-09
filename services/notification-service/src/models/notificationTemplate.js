module.exports = (sequelize, DataTypes) => {
      const NotificationTemplate = sequelize.define('NotificationTemplate', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

name: { type: DataTypes.STRING, allowNull: false },
subject: { type: DataTypes.STRING },
body: { type: DataTypes.TEXT, allowNull: false },
type: { type: DataTypes.ENUM('email', 'sms', 'push'), allowNull: false },
variables: { type: DataTypes.JSON },
created_by: { type: DataTypes.INTEGER.UNSIGNED },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'notification_templates', updatedAt: false });

      return NotificationTemplate;
    };

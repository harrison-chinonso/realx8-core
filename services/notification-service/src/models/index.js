const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const NotificationTemplate = require('./notificationTemplate')(sequelize, DataTypes);
const Notification = require('./notification')(sequelize, DataTypes);
const EmailLog = require('./emailLog')(sequelize, DataTypes);
// Who hears about a purchase-journey event, per company (FRD 12.1).
const NotificationConfig = require('./notificationConfig')(sequelize, DataTypes);

module.exports = { sequelize, NotificationTemplate, Notification, EmailLog, NotificationConfig };

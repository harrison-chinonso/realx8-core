const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const NotificationTemplate = require('./notificationTemplate')(sequelize, DataTypes);
const Notification = require('./notification')(sequelize, DataTypes);
const EmailLog = require('./emailLog')(sequelize, DataTypes);

module.exports = { sequelize, NotificationTemplate, Notification, EmailLog };

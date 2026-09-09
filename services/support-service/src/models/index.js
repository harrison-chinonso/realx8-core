const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Support = require('./support')(sequelize, DataTypes);
const SupportReply = require('./supportReply')(sequelize, DataTypes);
const Visitor = require('./visitor')(sequelize, DataTypes);
const Attendance = require('./attendance')(sequelize, DataTypes);
const VipClient = require('./vipClient')(sequelize, DataTypes);
const CommunicationLog = require('./communicationLog')(sequelize, DataTypes);
const CareAlert = require('./careAlert')(sequelize, DataTypes);
const AssistantConversation = require('./assistantConversation')(sequelize, DataTypes);
const AssistantMessage = require('./assistantMessage')(sequelize, DataTypes);

AssistantConversation.hasMany(AssistantMessage, { foreignKey: 'conversation_id', as: 'messages', onDelete: 'CASCADE' });
AssistantMessage.belongsTo(AssistantConversation, { foreignKey: 'conversation_id', as: 'conversation' });

Support.hasMany(SupportReply, { foreignKey: 'support_id', as: 'replies' });
SupportReply.belongsTo(Support, { foreignKey: 'support_id', as: 'ticket' });

module.exports = {
  sequelize,
  Support,
  SupportReply,
  Visitor,
  Attendance,
  VipClient,
  CommunicationLog,
  CareAlert,
  AssistantConversation,
  AssistantMessage,
};

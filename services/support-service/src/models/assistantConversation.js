module.exports = (sequelize, DataTypes) => sequelize.define('AssistantConversation', {
  id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
  // Whose conversation this is. Every read is filtered on it — a conversation
  // holds someone's finances and plans, so it is private to that user, not
  // shared with their company's admins.
  user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  company_id: { type: DataTypes.INTEGER.UNSIGNED },
  // First few words of the opening message, for the history list.
  title: { type: DataTypes.STRING },
}, {
  tableName: 'assistant_conversations',
  indexes: [{ fields: ['user_id'] }],
});

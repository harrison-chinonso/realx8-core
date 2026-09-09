module.exports = (sequelize, DataTypes) => sequelize.define('AssistantMessage', {
  id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
  conversation_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  role: { type: DataTypes.ENUM('user', 'assistant'), allowNull: false },
  content: { type: DataTypes.TEXT('medium'), allowNull: false },
  // Which tools produced this answer — useful when a figure is questioned later.
  tools_used: { type: DataTypes.STRING },
}, {
  tableName: 'assistant_messages',
  updatedAt: false,
  indexes: [{ fields: ['conversation_id'] }],
});

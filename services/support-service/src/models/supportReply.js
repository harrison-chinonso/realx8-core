module.exports = (sequelize, DataTypes) => {
      const SupportReply = sequelize.define('SupportReply', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

support_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
message: { type: DataTypes.TEXT, allowNull: false },
attachments: { type: DataTypes.JSON },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'support_replies', updatedAt: false });

      return SupportReply;
    };

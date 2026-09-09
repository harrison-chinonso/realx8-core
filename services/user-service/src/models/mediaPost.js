module.exports = (sequelize, DataTypes) => {
  const MediaPost = sequelize.define('MediaPost', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    title: { type: DataTypes.STRING, allowNull: false },
    type: { type: DataTypes.ENUM('social', 'blog'), allowNull: false, defaultValue: 'social' },
    content: { type: DataTypes.TEXT },
    caption: { type: DataTypes.TEXT },
    excerpt: { type: DataTypes.TEXT },
    channels: { type: DataTypes.JSON },
    media_files: { type: DataTypes.JSON, defaultValue: [] },
    platform_post_ids: { type: DataTypes.JSON, defaultValue: {} },
    impressions_synced_at: { type: DataTypes.DATE },
    tags: { type: DataTypes.STRING },
    category: { type: DataTypes.STRING },
    status: {
      type: DataTypes.ENUM('draft', 'review', 'approved', 'scheduled', 'published'),
      allowNull: false,
      defaultValue: 'draft',
    },
    rejection_reason: { type: DataTypes.TEXT },
    scheduled_at: { type: DataTypes.DATE },
    published_at: { type: DataTypes.DATE },
    reach: { type: DataTypes.INTEGER, defaultValue: 0 },
    impressions: { type: DataTypes.INTEGER, defaultValue: 0 },
    engagement_rate: { type: DataTypes.FLOAT, defaultValue: 0 },
    leads_generated: { type: DataTypes.INTEGER, defaultValue: 0 },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
    reviewed_by: { type: DataTypes.INTEGER.UNSIGNED },
  }, { tableName: 'media_posts' });

  return MediaPost;
};

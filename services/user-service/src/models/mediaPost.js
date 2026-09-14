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
    /**
     * Which company's post this is.
     *
     * Absent until now, and the absence was the whole of the problem: the
     * listing filtered on nothing, so every company saw every other company's
     * drafts, and every id-addressed route accepted any id from any caller.
     *
     * Nullable, for two reasons that are not the same. A platform-level post
     * genuinely belongs to no company. And a post whose author has since been
     * deleted cannot be attributed to one after the fact — `created_by` is the
     * only link there was, and it is now SET NULL rather than cascading. Those
     * rows are visible to platform admins and to nobody else, which is the
     * honest answer rather than showing them to whoever asks first.
     */
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
  }, { tableName: 'media_posts' });

  return MediaPost;
};

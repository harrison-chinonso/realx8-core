module.exports = (sequelize, DataTypes) => {
  const RealtorLevelRequest = sequelize.define('RealtorLevelRequest', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    // Snapshot of where the realtor stood when they asked, so the record still
    // reads correctly after the level is granted or renamed.
    current_level_id: { type: DataTypes.INTEGER.UNSIGNED },
    current_level_name: { type: DataTypes.STRING },
    requested_level_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    requested_level_name: { type: DataTypes.STRING },
    reason: { type: DataTypes.TEXT },
    status: {
      type: DataTypes.ENUM('pending', 'approved', 'rejected'),
      allowNull: false,
      defaultValue: 'pending',
    },
    review_notes: { type: DataTypes.TEXT },
    reviewed_by: { type: DataTypes.INTEGER.UNSIGNED },
    reviewed_at: { type: DataTypes.DATE },
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
  }, { tableName: 'realtor_level_requests' });

  return RealtorLevelRequest;
};

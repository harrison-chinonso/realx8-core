module.exports = (sequelize, DataTypes) => {
  const Inspection = sequelize.define('Inspection', {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    ref_number: { type: DataTypes.STRING, allowNull: false },
    property_id: { type: DataTypes.INTEGER.UNSIGNED },
    property_name: { type: DataTypes.STRING, allowNull: false },
    // The lead being shown the property. client_name/phone are kept as a
    // denormalised snapshot so history survives lead edits or deletion.
    lead_id: { type: DataTypes.INTEGER.UNSIGNED },
    client_name: { type: DataTypes.STRING, allowNull: false },
    client_phone: { type: DataTypes.STRING, allowNull: false },
    realtor_name: { type: DataTypes.STRING, allowNull: false },
    // Set on create so inspections can be scoped to the assigned realtor;
    // realtor_name alone is not a safe key (duplicates, renames).
    realtor_id: { type: DataTypes.INTEGER.UNSIGNED },
    scheduled_at: { type: DataTypes.DATE, allowNull: false },
    status: { type: DataTypes.ENUM('pending', 'confirmed', 'completed', 'cancelled'), allowNull: false, defaultValue: 'pending' },
    notes: { type: DataTypes.TEXT },
    // How many people are attending the viewing.
    attendees: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 1 },
    // Realtor-scheduled inspections need admin sign-off; staff-created ones are
    // approved on creation.
    approval_status: {
      type: DataTypes.ENUM('pending_approval', 'approved', 'rejected'),
      defaultValue: 'approved',
    },
    approval_notes: { type: DataTypes.TEXT },
    approved_by: { type: DataTypes.INTEGER.UNSIGNED },
    approved_at: { type: DataTypes.DATE },
    client_satisfaction: { type: DataTypes.INTEGER.UNSIGNED },
    client_feedback: { type: DataTypes.TEXT },
    realtor_notes: { type: DataTypes.TEXT },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
  
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
    }, { tableName: 'inspections', indexes: [{ unique: true, fields: ['ref_number'], name: 'ref_number' }] });

  return Inspection;
};

module.exports = (sequelize, DataTypes) => {
  const Objection = sequelize.define('Objection', {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    lead_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    type: {
      type: DataTypes.ENUM(
        'Lack of Funds',
        'Trust Issues',
        'Documentation Concerns',
        'Location Concerns',
        'Price Too High',
        'Not Ready',
        'Other'
      ),
      allowNull: false,
    },
    description: { type: DataTypes.TEXT, allowNull: false },
    resolution_strategy: { type: DataTypes.TEXT },
    objection_date: { type: DataTypes.DATEONLY, allowNull: false, defaultValue: DataTypes.NOW },
    logged_by: { type: DataTypes.INTEGER.UNSIGNED },
    logged_by_name: { type: DataTypes.STRING },
  
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
    }, { tableName: 'objections', updatedAt: false });

  return Objection;
};

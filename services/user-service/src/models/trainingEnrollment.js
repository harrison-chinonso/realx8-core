module.exports = (sequelize, DataTypes) => {
  const TrainingEnrollment = sequelize.define('TrainingEnrollment', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    module_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    realtor_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    realtor_name: { type: DataTypes.STRING, allowNull: false },
    score: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
    status: { type: DataTypes.ENUM('enrolled', 'in_progress', 'passed', 'failed'), defaultValue: 'enrolled' },
    completed_at: { type: DataTypes.DATE },
    answers: { type: DataTypes.JSON, defaultValue: [] },
  }, { tableName: 'training_enrollments' });

  return TrainingEnrollment;
};

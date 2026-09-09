module.exports = (sequelize, DataTypes) => {
  const Attendance = sequelize.define('Attendance', {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    employee_name: { type: DataTypes.STRING, allowNull: false },
    employee_role: { type: DataTypes.STRING },
    check_in: { type: DataTypes.DATE },
    check_out: { type: DataTypes.DATE },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    status: { type: DataTypes.ENUM('present', 'late', 'absent'), allowNull: false, defaultValue: 'present' },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
  
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
    }, { tableName: 'attendances' });

  return Attendance;
};

const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const User = require('./user')(sequelize, DataTypes);
const UserProfile = require('./userProfile')(sequelize, DataTypes);
const Role = require('./role')(sequelize, DataTypes);
const Permission = require('./permission')(sequelize, DataTypes);
const UserRole = require('./userRole')(sequelize, DataTypes);
const RolePermission = require('./rolePermission')(sequelize, DataTypes);
const Setting = require('./setting')(sequelize, DataTypes);
const Company = require('./company')(sequelize, DataTypes);
const MediaPost = require('./mediaPost')(sequelize, DataTypes);
const SocialAccount = require('./socialAccount')(sequelize, DataTypes);
const Recruit = require('./recruit')(sequelize, DataTypes);
const RealtorLevel = require('./realtorLevel')(sequelize, DataTypes);
const RealtorLevelRequest = require('./realtorLevelRequest')(sequelize, DataTypes);
const RealtorKyc = require('./realtorKyc')(sequelize, DataTypes);
const RealtorStat = require('./realtorStat')(sequelize, DataTypes);
const TrainingEnrollment = require('./trainingEnrollment')(sequelize, DataTypes);
const TrainingModule = require('./trainingModule')(sequelize, DataTypes);
const ReferralLink = require('./referralLink')(sequelize, DataTypes);
const AuditLog = require('./auditLog')(sequelize, DataTypes);

User.hasOne(UserProfile, { foreignKey: 'user_id', as: 'profile' });
UserProfile.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
User.belongsTo(Company, { foreignKey: 'company_id', as: 'company' });
Company.hasMany(User, { foreignKey: 'company_id', as: 'users' });
User.belongsToMany(Role, { through: UserRole, foreignKey: 'user_id', otherKey: 'role_id', as: 'roles' });
Role.belongsToMany(User, { through: UserRole, foreignKey: 'role_id', otherKey: 'user_id', as: 'users' });
Role.belongsToMany(Permission, { through: RolePermission, foreignKey: 'role_id', otherKey: 'permission_id', as: 'permissions' });
Permission.belongsToMany(Role, { through: RolePermission, foreignKey: 'permission_id', otherKey: 'role_id', as: 'roles' });
/**
 * A post OUTLIVES its author.
 *
 * The default was CASCADE, so deleting a user deleted every post they had
 * written — published ones included, with their engagement figures and the
 * platform post ids that tie them to what is live on social. Attribution is
 * worth less than the work: `created_by` is nullable and the listing already
 * renders a missing author as "—".
 */
User.hasMany(MediaPost, {
  foreignKey: 'created_by', as: 'mediaPosts', onDelete: 'SET NULL', onUpdate: 'CASCADE',
});
MediaPost.belongsTo(User, {
  foreignKey: 'created_by', as: 'author', onDelete: 'SET NULL', onUpdate: 'CASCADE',
});
MediaPost.belongsTo(User, {
  foreignKey: 'reviewed_by', as: 'reviewer', onDelete: 'SET NULL', onUpdate: 'CASCADE',
});
TrainingModule.hasMany(TrainingEnrollment, { foreignKey: 'module_id', as: 'enrollments' });
TrainingEnrollment.belongsTo(TrainingModule, { foreignKey: 'module_id', as: 'module' });

User.belongsTo(RealtorLevel, { foreignKey: 'realtor_level_id', as: 'realtorLevel' });
RealtorLevel.hasMany(User, { foreignKey: 'realtor_level_id', as: 'realtors' });
RealtorLevelRequest.belongsTo(User, { foreignKey: 'user_id', as: 'realtor' });
RealtorLevelRequest.belongsTo(RealtorLevel, { foreignKey: 'requested_level_id', as: 'requestedLevel' });
RealtorLevelRequest.belongsTo(RealtorLevel, { foreignKey: 'current_level_id', as: 'currentLevel' });
RealtorKyc.belongsTo(User, { foreignKey: 'user_id', as: 'realtor' });
User.hasOne(RealtorKyc, { foreignKey: 'user_id', as: 'kyc' });

module.exports = {
  ReferralLink,
  AuditLog,
  sequelize,
  User,
  UserProfile,
  Role,
  Permission,
  UserRole,
  RolePermission,
  Setting,
  Company,
  MediaPost,
  SocialAccount,
  TrainingModule,
  TrainingEnrollment,
  RealtorStat,
  Recruit,
  RealtorLevel,
  RealtorLevelRequest,
  RealtorKyc,
};

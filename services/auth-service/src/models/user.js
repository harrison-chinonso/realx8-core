const { installStatusHooks } = require('../../../../shared/src/realtorStatus');
const USER_TYPES = [
  'superior_admin',
  'super_admin',
  'admin',
  'employee',
  'realtor',
  'client',
  'coo',
  'csmo',
  'product_manager',
  'customer_care',
  'media_team',
  'branch_manager',
  'front_desk',
];

module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define('User', {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    name: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, allowNull: false, unique: true },
    password: { type: DataTypes.STRING, allowNull: false },
    phone: { type: DataTypes.STRING },
    type: { type: DataTypes.ENUM(...USER_TYPES), allowNull: false, defaultValue: 'client' },
    avatar: { type: DataTypes.STRING },
    lang: { type: DataTypes.STRING, defaultValue: 'en' },
    is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    // The realtor a client belongs to. Declared here so registration can set it —
    // Sequelize silently drops attributes a model does not declare.
    realtor_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    // Same reason: new realtors are placed on the entry level at sign-up.
    // The column and its ladder are owned by user-service; this service only
    // writes the id, and sync({ force: false }) here never reshapes the table.
    realtor_level_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    plan: { type: DataTypes.STRING },
    plan_expire_date: { type: DataTypes.DATE },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
    two_factor_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    /**
     * Mirrors user-service's model.
     *
     * auth-service defines its own User over the same table, so a column added
     * only there is silently DROPPED by writes made here — sequelize ignores
     * attributes the model does not declare. That is exactly what happened to
     * last_login_at and the passcode fields: the update returned success and
     * wrote nothing.
     */
    last_login_at: { type: DataTypes.DATE, allowNull: true },
    passcode_hash: { type: DataTypes.STRING, allowNull: true },
    passcode_set_at: { type: DataTypes.DATE, allowNull: true },
    passcode_failed_attempts: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    passcode_locked_until: { type: DataTypes.DATE, allowNull: true },
    two_factor_secret: { type: DataTypes.STRING },
    google_id: { type: DataTypes.STRING, allowNull: true, unique: true },
  }, { tableName: 'users' });

  /**
   * Every change of standing is appended to realtor_status_history.
   *
   * Installed from shared/ rather than written here because BOTH this service
   * and the other one define a model over `users`, and hooks on one do not fire
   * for the other — a realtor created through the path this model does not
   * serve would otherwise have no history at all, and the commission
   * eligibility gate refuses anybody it cannot place.
   */
  installStatusHooks(User);

  return User;
};

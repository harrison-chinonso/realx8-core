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
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, allowNull: false },
    password: { type: DataTypes.STRING, allowNull: false },
    phone: { type: DataTypes.STRING },
    type: { type: DataTypes.ENUM(...USER_TYPES), allowNull: false, defaultValue: 'client' },
    avatar: { type: DataTypes.STRING },
    lang: { type: DataTypes.STRING, defaultValue: 'en' },
    is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
    plan: { type: DataTypes.STRING },
    plan_expire_date: { type: DataTypes.DATE },
    company_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
    deleted_at: { type: DataTypes.DATE },
    two_factor_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    two_factor_secret: { type: DataTypes.STRING },
    google_id: { type: DataTypes.STRING, allowNull: true },
    // Realtor tier — used for commission rule calculation
    category: { type: DataTypes.ENUM('premium', 'professional', 'basic'), allowNull: true },
    // Tracks last meaningful activity for reactivation scheduler
    last_active_at: { type: DataTypes.DATE, allowNull: true },

    /**
     * When they last completed a FULL sign-in — password (and 2FA, where
     * enabled), not a passcode.
     *
     * Deliberately separate from last_active_at, which names itself after
     * activity and is what the reactivation scheduler reads. The passcode
     * window is a security boundary: if it were measured from an activity
     * timestamp, any future activity tracking would silently extend how long a
     * 6-digit code stays sufficient. This only moves on a real credential
     * check, and a passcode sign-in never touches it — so the window closes two
     * hours after the password was last used, however many times the passcode
     * is used inside it.
     */
    last_login_at: { type: DataTypes.DATE, allowNull: true },

    /**
     * A 6-digit convenience passcode, bcrypt-hashed like the password.
     *
     * Six digits is a million combinations — far too few to stand alone as a
     * credential, which is why it is only accepted inside a short window after
     * a full sign-in and is rate-limited below. It shortens re-authentication;
     * it does not replace authentication.
     */
    passcode_hash: { type: DataTypes.STRING, allowNull: true },
    passcode_set_at: { type: DataTypes.DATE, allowNull: true },
    // Wrong attempts since the last success, and the lockout they earn. Without
    // these, a million-combination secret is brute-forceable in an afternoon.
    passcode_failed_attempts: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    passcode_locked_until: { type: DataTypes.DATE, allowNull: true },
    // Unique referral code for realtors (auto-generated on creation)
    realtor_code: { type: DataTypes.STRING(5), allowNull: true },
    // The realtor this user belongs to. First-class link so a client's realtor
    // can be resolved directly rather than inferred from CRM leads.
    realtor_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    // Realtor tier (Basic → Ambassador). Distinct from `category`, which is the
    // commission-rule matching field.
    realtor_level_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
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

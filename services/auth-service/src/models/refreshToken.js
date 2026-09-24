module.exports = (sequelize, DataTypes) => {
      const RefreshToken = sequelize.define('RefreshToken', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
token: { type: DataTypes.STRING(255), allowNull: false, unique: true },
expires_at: { type: DataTypes.DATE, allowNull: false },
/**
 * The session this token belongs to.
 *
 * Without it, a client whose session had been superseded could still call
 * /auth/refresh and be handed a token for whichever session is now live —
 * quietly re-entering the account the one-session rule had just pushed it out
 * of. Binding the token to its own session lets refresh tell the two apart.
 *
 * Nullable, because tokens issued before this column existed have no session
 * and must keep working until they expire.
 */
sid: { type: DataTypes.STRING(64), allowNull: true },
/**
 * The accounts the password that minted this token actually opened, as JSON.
 *
 * Carried so a refresh does not forget: the set lives in the access token,
 * which lasts an hour, and without this every hourly refresh would start
 * asking for a password to enter a company the person had been moving into
 * freely all morning. See the migration for why it cannot be recomputed.
 *
 * Nullable — a token minted before this column existed proves only its own
 * account, which is the safe reading.
 */
opened_accounts: { type: DataTypes.TEXT, allowNull: true },
      }, { tableName: 'refresh_tokens', updatedAt: false });

      return RefreshToken;
    };

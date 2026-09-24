const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { User, RefreshToken, PasswordReset } = require('../models');
const { getBranding, templates } = require('../utils/emailTemplates');
const { createNotifier } = require('../../../../shared/src/notifier');
const { appSecret } = require('../../../../shared/src/appSecret');
const { appUrl } = require('../../../../shared/src/appOrigin');
const { defaultRealtorLevelId } = require('../../../../shared/src/realtorLevel');
const { createDispatcher } = require('../../../../shared/src/notificationDispatcher');
// Recipients come from configuration, not from this call site.
const notify = createDispatcher(require('../config/database').sequelize);
const { sequelize } = require('../config/database');
const { significantDigits, isPlausiblePhone, phoneMatchSql } = require('../../../../shared/src/phone');
const { cache, KEYS, TTL } = require('../../../../shared/src/cache');
const { insertIgnoring } = require('../../../../shared/src/dialect');
const { newSessionId, deriveKey } = require('../../../../shared/src/payloadCrypto');
const sessionRegistry = require('../../../../shared/src/sessionRegistry');
const { sendMail } = require('../../../../shared/src/mailTransport');
const { q } = require('../../../../shared/src/dialect');
const { evictUserAuthorisation } = require('../../../../shared/src/cacheEvict');
const { MIN_PASSWORD_LENGTH, BCRYPT_ROUNDS } = require('../../../../shared/src/passwordPolicy');
const { realtorFromCode, normaliseCode, resolveSignup } = require('../../../../shared/src/signupAttribution');
const { isDuplicateError } = require('../../../../shared/src/dialect');
const {
  accountsForEmail, normaliseEmail, emailAvailability,
  setAccountPassword, isMultiCompanyType, companiesForEmail,
  multiCompanySignupsEnabled,
} = require('../../../../shared/src/emailIdentity');
const { recordReferral, STATUS: REFERRAL_STATUS } = require('../../../../shared/src/referralRecord');

// ── DB-backed config cache (hot-reloads from settings table) ─────────────────
const CONFIG_TTL_MS = 5 * 60 * 1000; // re-read DB every 5 minutes
let _configCache = null;
let _configLoadedAt = 0;

const loadConfigFromDB = async () => {
  try {
    const { sequelize } = require('../config/database');
    const rows = await sequelize.query(
      `SELECT ${q(sequelize, 'key')}, ${q(sequelize, 'value')} FROM settings
         WHERE ${q(sequelize, 'group')} IN ('system', 'email') AND company_id IS NULL`,
      { type: QueryTypes.SELECT }
    );
    const map = {};
    rows.forEach(r => { map[r.key] = r.value; });
    _configCache = map;
    _configLoadedAt = Date.now();
  } catch {
    // DB not ready yet or table doesn't exist — keep using env vars
  }
};

const getConfig = async () => {
  if (!_configCache || Date.now() - _configLoadedAt > CONFIG_TTL_MS) {
    await loadConfigFromDB();
  }
  return _configCache || {};
};

const getCfg = async (key, envFallback) => {
  const cfg = await getConfig();
  return cfg[key] || envFallback;
};

// Force immediate reload (called by /auth/reload-config endpoint)
const reloadConfig = asyncHandler(async (req, res) => {
  await loadConfigFromDB();
  res.json({ message: 'Config reloaded from DB' });
});

const tempTokenExpiry = process.env.JWT_2FA_TEMP_EXPIRES || '10m';
const frontendGoogleCallback = process.env.FRONTEND_GOOGLE_CALLBACK_URL || 'http://localhost:5173/auth/google/callback';

const PUBLIC_REGISTRATION_ROLES = ['client', 'realtor'];

const sanitizeUser = (user, permissions) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  company_id: user.company_id ?? null,
  phone: user.phone,
  type: user.type,
  avatar: user.avatar,
  lang: user.lang,
  is_active: user.is_active,
  plan: user.plan,
  plan_expire_date: user.plan_expire_date,
  two_factor_enabled: Boolean(user.two_factor_enabled),
  /**
   * Whether a passcode exists — never whether it would work right now.
   *
   * Enough for a UI to decide whether to offer the passcode pad at all.
   * Whether it would be ACCEPTED also depends on the two-hour window and
   * the lockout clock, both of which move without the user object being
   * reissued, so a flag here would go stale; GET /auth/passcode answers
   * that question at the moment it is asked.
   */
  passcode_set: Boolean(user.passcode_hash),
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
  ...(permissions !== undefined ? { permissions } : {}),
});

const loadUserPermissions = async (userId) => {
  const { sequelize } = require('../config/database');

  const query = `
    SELECT DISTINCT p.name
    FROM user_roles ur
    JOIN role_permissions rp ON rp.role_id = ur.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = :userId
  `;

  const rows = await sequelize.query(query, { replacements: { userId }, type: QueryTypes.SELECT });

  // If no roles assigned yet, auto-assign based on user.type and retry
  if (rows.length === 0) {
    const user = await User.findByPk(userId, { attributes: ['id', 'type'] });
    if (user?.type) {
      await insertIgnoring(
        sequelize,
        'user_roles (user_id, role_id) SELECT :userId, r.id FROM roles r WHERE r.name = :type',
        { replacements: { userId, type: user.type }, type: QueryTypes.INSERT },
      );
      const retried = await sequelize.query(query, { replacements: { userId }, type: QueryTypes.SELECT });
      return retried.map((r) => r.name);
    }
  }

  return rows.map((row) => row.name);
};

/**
 * A user's permission names, cached.
 *
 * Runs on login, on every token refresh and on every /me — which the UI calls
 * on each app boot — for a three-table join whose answer changes only when
 * roles or grants change.
 *
 * ── Why an EMPTY result is never cached ──────────────────────────────────────
 *
 * loadUserPermissions is not a pure read: when a user has no roles at all it
 * assigns the role matching their type and retries. Caching [] would mean the
 * next call returns the cached empty list instead of running that repair, so a
 * user who happened to be read once before their roles existed would stay
 * permissionless for the whole TTL. An empty list is therefore treated as "ask
 * again", which is also the safe direction: the cost is a query, not a lockout.
 */
const getUserPermissions = async (userId) => {
  const cached = await cache.get(KEYS.userPermissions(userId));
  if (Array.isArray(cached) && cached.length) return cached;

  const permissions = await loadUserPermissions(userId);
  if (permissions.length) {
    await cache.set(KEYS.userPermissions(userId), permissions, TTL.authorisation);
  }
  return permissions;
};

/**
 * The user payload, permissions and all — the same object `/auth/me` returns.
 *
 * Exported so anything that CHANGES a user can hand back the whole refreshed
 * object rather than a message the client has to interpret. Without it a caller
 * that just set or cleared a passcode would still be holding the `passcode_set`
 * it was given at sign-in, and would have to guess the new value or re-fetch.
 */
const presentUser = async (user) => sanitizeUser(user, await getUserPermissions(user.id));

// Permissions only for a specific role belonging to this user
const getPermissionsForRole = async (userId, roleId) => {
  const { sequelize } = require('../config/database');
  const rows = await sequelize.query(
    `SELECT DISTINCT p.name
     FROM user_roles ur
     JOIN role_permissions rp ON rp.role_id = ur.role_id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = :userId AND ur.role_id = :roleId`,
    { replacements: { userId, roleId }, type: QueryTypes.SELECT }
  );
  return rows.map((r) => r.name);
};

// All roles assigned to this user
const loadUserRolesData = async (userId) => {
  const { sequelize } = require('../config/database');
  const roles = await sequelize.query(
    `SELECT r.id, r.name, r.display_name, r.company_id
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = :userId
     ORDER BY r.id ASC`,
    { replacements: { userId }, type: QueryTypes.SELECT }
  );
  return roles;
};

/**
 * The user's roles, cached.
 *
 * Read on every sign-in, refresh and profile switch. Like the permissions
 * above, an EMPTY result is not cached: a user with no roles yet is a state
 * getUserPermissions actively repairs, and pinning the empty answer would keep
 * them role-less for the whole TTL.
 */
const getUserRolesData = async (userId) => {
  const cached = await cache.get(KEYS.userRoles(userId));
  if (Array.isArray(cached) && cached.length) return cached;

  const roles = await loadUserRolesData(userId);
  if (roles.length) await cache.set(KEYS.userRoles(userId), roles, TTL.authorisation);
  return roles;
};

const syncUserRoles = async (userId, roleNames = []) => {
  const { sequelize } = require('../config/database');
  const names = [...new Set(roleNames.map((name) => String(name).trim()).filter(Boolean))];
  if (!names.length) return;

  const roles = await sequelize.query('SELECT id, name FROM roles WHERE name IN (:names)', {
    replacements: { names },
    type: QueryTypes.SELECT,
  });

  if (!roles.length) return;

  await sequelize.query('DELETE FROM user_roles WHERE user_id = :userId', {
    replacements: { userId },
    type: QueryTypes.DELETE,
  });

  for (const role of roles) {
    await sequelize.query('INSERT INTO user_roles (user_id, role_id) VALUES (:userId, :roleId)', {
      replacements: { userId, roleId: role.id },
      type: QueryTypes.INSERT,
    });
  }

  // This rewrites user_roles directly, so both cached views of this user's
  // authorisation are now wrong.
  await evictUserAuthorisation(userId);
};

/**
 * Profiles a user may operate under interchangeably. When one of these is the
 * active role, it becomes the user's EFFECTIVE type — services gate behaviour on
 * that rather than the static users.type column, so switching profiles actually
 * changes what the user can see and do.
 */
const SWITCHABLE_PROFILES = ['realtor', 'client'];

const effectiveTypeFor = (user, activeRoleName) =>
  (SWITCHABLE_PROFILES.includes(activeRoleName) ? activeRoleName : user.type);

/**
 * Mints an access token and, with it, the session's payload-encryption key.
 *
 * The `sid` claim is a plain random id — it authorises nothing. Its only job is
 * to let the server re-derive this session's encryption key from a secret it
 * never sends anywhere, so no key has to be stored or looked up. The key itself
 * goes to the client once, in the sign-in response.
 *
 * Returning both together means they cannot drift: a new token always comes
 * with the key that matches it, so a refresh can never leave the UI holding a
 * key for a session that has moved on.
 */
/**
 * The secret tokens are signed with.
 *
 * ── The environment wins, deliberately ──────────────────────────────────────
 *
 * Signing read jwt_secret from the SETTINGS TABLE while verification — in
 * shared/src/middleware/auth.js, which gates every request in every service —
 * read process.env.JWT_SECRET. Nothing kept the two in step, and when they
 * diverge the failure is silent and total in a very specific way: signing in
 * SUCCEEDS, because that only signs, and then every single API call returns
 * "Invalid or expired token", because nothing can verify what was signed.
 *
 * The two diverge easily. A JWT secret sitting in a settings table travels
 * with data: restore a production database from a development dump, or migrate
 * one engine to another, and development's secret arrives in production while
 * the real one sits unused in the environment.
 *
 * So the environment is authoritative wherever it is set, which is everywhere
 * that matters, and a settings row that disagrees is ignored and reported
 * rather than obeyed. The row is still honoured when no environment variable
 * exists at all, so a deployment configured entirely through the database
 * keeps working.
 *
 * A JWT secret is a deployment secret rather than tenant configuration, and
 * this is the shape that reflects that.
 */
let warnedAboutSecretMismatch = false;

const jwtSecret = async () => {
  const configured = process.env.JWT_SECRET;
  const stored = await getCfg('jwt_secret', null);

  /*
   * With no environment value, a settings row is still honoured — a deployment
   * configured entirely through the database keeps working, which is the case
   * this branch was written for. What is gone is the third option: falling
   * through to a literal from the source tree, which signed real sessions with
   * a key every reader of this repository holds. appSecret() refuses instead,
   * except in development. See shared/src/appSecret.js.
   */
  if (!configured) return stored || appSecret();

  if (stored && stored !== configured && !warnedAboutSecretMismatch) {
    warnedAboutSecretMismatch = true;
    console.warn('[auth] the jwt_secret in settings differs from JWT_SECRET in the environment. '
      + 'The environment value is being used, because it is what every service verifies with — '
      + 'signing with the other would make every request fail with "Invalid or expired token" '
      + 'immediately after a successful sign-in. Update or remove the settings row to silence this.');
  }

  return configured;
};

const createAccessToken = async (
  user, permissions = [], activeRoleId = null, activeRoleName = null, reuseSid = null,
  openedAccounts = null,
) => {
  /** At minimum this account: a session always authorises where it already is. */
  const opened = [...new Set([...(openedAccounts || []), Number(user.id)])];
  const secret = await jwtSecret();
  const expiry = await getCfg('jwt_access_expires', process.env.JWT_ACCESS_EXPIRES || '1h');
  const isSuperiorAdmin = user.type === 'superior_admin';
  /**
   * A refresh or a profile switch CONTINUES the session rather than starting
   * one, so it reuses the id. Minting a fresh one there would make an hourly
   * token refresh look like a second sign-in to the single-session rule, and
   * would needlessly rotate the payload key mid-session.
   */
  const sid = reuseSid || newSessionId();
  const token = jwt.sign(
    {
      id: user.id,
      sid,
      email: user.email,
      type: user.type,
      effectiveType: effectiveTypeFor(user, activeRoleName),
      activeRole: activeRoleName || null,
      name: user.name,
      permissions,
      company_id: user.company_id || null,
      isSuperiorAdmin,
      activeRoleId: activeRoleId || null,
      /**
       * The accounts the credential behind this session actually opened.
       *
       * Every company account has its own password now, so "this person owns
       * both rows" is no longer a reason to let a session move between them:
       * somebody who knows only the weaker password would reach the other one
       * through a switch, and the separation would be decoration. This names
       * what was proved, and the switch is allowed inside it and asks for a
       * password outside it.
       *
       * Always contains at least this account, so a session can never fail to
       * authorise the company it is already in.
       */
      openedAccounts: opened,
    },
    secret,
    { expiresIn: expiry }
  );
  return { token, sid, payloadKey: deriveKey(sid).toString('hex') };
};

const createTempToken = async (user, openedAccounts = null) => {
  const secret = await jwtSecret();
  return jwt.sign(
    /*
     * The proven set rides along, because two-factor is a detour in the middle
     * of a sign-in and the password is gone by the time the code comes back.
     * Without it, anybody at a company that enforces two-factor would come out
     * of the detour having proved only one account.
     */
    { id: user.id, purpose: '2fa', opened: openedAccounts || undefined },
    secret,
    { expiresIn: tempTokenExpiry }
  );
};

const getEncryptionKey = async () => {
  const secret = await jwtSecret();
  return crypto.createHash('sha256').update(secret).digest();
};

const encryptSecret = async (value) => {
  if (!value) return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', await getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
};

const decryptSecret = async (value) => {
  if (!value) return null;
  const [ivHex, encryptedHex] = value.split(':');
  if (!ivHex || !encryptedHex) return value;
  const decipher = crypto.createDecipheriv('aes-256-cbc', await getEncryptionKey(), Buffer.from(ivHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
};

const verifyTotpToken = (secret, token) => speakeasy.totp.verify({
  secret,
  encoding: 'base32',
  token,
  window: 1,
});

const createRefreshToken = async (user, sid = null, openedAccounts = null) => {
  const token = crypto.randomBytes(48).toString('hex');
  const days = Number(await getCfg('jwt_refresh_days', process.env.JWT_REFRESH_DAYS || 7));
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  await RefreshToken.create({
    user_id: user.id,
    token,
    expires_at: expiresAt,
    sid,
    /*
     * Stored, because the access token that also carries this expires in an
     * hour and a refresh has no password to re-derive it from. See the
     * migration for why it cannot be worked out from the hashes.
     */
    opened_accounts: JSON.stringify([...new Set([...(openedAccounts || []), Number(user.id)])]),
  });
  return token;
};

/** The set a refresh token remembers, read defensively. */
const openedFrom = (stored) => {
  try {
    const parsed = JSON.parse(stored?.opened_accounts || 'null');
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : null;
  } catch {
    return null;
  }
};

const issueSession = async (
  user, activeRoleId = null, { sid: reuseSid = null, req = null, opened = null } = {},
) => {
  const roles = await getUserRolesData(user.id);

  // Determine which role is active
  let targetRoleId = activeRoleId ? Number(activeRoleId) : null;
  if (!targetRoleId && roles.length > 0) {
    // Prefer the role whose name matches user.type, otherwise first role
    const typeMatch = roles.find((r) => r.name === user.type);
    targetRoleId = typeMatch ? typeMatch.id : roles[0].id;
  }

  let permissions;
  if (user.type === 'superior_admin') {
    // superior_admin always gets full permissions
    permissions = await getUserPermissions(user.id);
  } else if (targetRoleId) {
    permissions = await getPermissionsForRole(user.id, targetRoleId);
    // Fallback: if this role has no specific permissions, fetch all
    if (!permissions.length) permissions = await getUserPermissions(user.id);
  } else {
    permissions = await getUserPermissions(user.id);
  }

  const activeRole = roles.find((r) => r.id === targetRoleId) || roles[0] || null;

  /**
   * Both timestamps move on a FULL sign-in.
   *
   * last_active_at is what the reactivation scheduler reads; last_login_at is
   * the passcode window's anchor and moves only here, never on a passcode
   * sign-in — which is what keeps that window a fixed two hours from the last
   * time a password was actually used.
   */
  User.update(
    { last_active_at: new Date(), last_login_at: new Date() },
    { where: { id: user.id } },
  ).catch(() => {});

  const access = await createAccessToken(
    user, permissions, targetRoleId, activeRole?.name || null, reuseSid, opened,
  );

  /**
   * Registers this as the user's live session.
   *
   * Also called on refresh and role switch with the SAME id, where it acts as
   * a touch: it re-arms the inactivity TTL for a session that is demonstrably
   * still in use.
   */
  await sessionRegistry.startSession(user.id, {
    sid: access.sid,
    ip: req?.clientIp || req?.ip || null,
    userAgent: req?.headers?.['user-agent'] || null,
  });

  /**
   * Name the actor on the audit entry for this sign-in.
   *
   * The audit middleware attributes a row to req.user, and on this route there
   * is no req.user — that is the whole point of signing in. So the controller
   * supplies who it turned out to be, at the one place every route into a
   * session passes through: password, two-factor, forced enrolment, passcode
   * and role switch all end up here, and recording it at each of them instead
   * would have meant five chances to forget.
   *
   * Enrichment, not creation: the middleware still writes the row, still names
   * the action from the route, and still redacts the password out of the body.
   */
  req?.audit?.({
    actor_id: user.id,
    actor_name: user.name || null,
    actor_email: user.email || null,
    actor_type: effectiveTypeFor(user, activeRole?.name || null) || user.type || null,
    company_id: user.company_id ?? null,
    entity_type: 'session',
    entity_id: access.sid || null,
  });

  return {
    accessToken: access.token,
    /**
     * The key for this session's encrypted payloads.
     *
     * Handed over once, here, and held in the page's memory only — never in
     * localStorage, because a key that outlives the tab is a key sitting in
     * storage for anything with DOM access to read. See the UI's payloadCrypto.
     *
     * Present regardless of whether encryption is switched on, so enabling
     * PAYLOAD_ENCRYPTION_MODE needs no coordinated client release: sessions
     * already open are holding a usable key.
     */
    payloadKey: access.payloadKey,
    refreshToken: await createRefreshToken(user, access.sid, opened),
    user: {
      ...sanitizeUser(user, permissions),
      // Lets the UI gate on the active profile without decoding the token.
      effectiveType: effectiveTypeFor(user, activeRole?.name || null),
    },
    roles,
    activeRoleId: targetRoleId,
    activeRole,
    /**
     * The companies this person can switch to, handed over with the session.
     *
     * Here rather than behind its own call because every route into a session
     * passes through this function, and a switcher that had to fetch its own
     * list would be empty for the first moment of every sign-in — which reads
     * as "you only belong to one company" precisely when somebody is looking
     * for the one they just left.
     */
    companies: await switchableCompanies(user),
    /*
     * Whether a second company may be opened at all. Shipped with the session
     * so the switcher can leave the entry out rather than offer a control that
     * is going to refuse — see MULTI_COMPANY_SIGNUPS in emailIdentity.js.
     */
    multi_company_signups: multiCompanySignupsEnabled(),
  };
};

/**
 * The companies this account's owner may move between.
 *
 * Empty means "cannot hold more than one", which is every kind of staff, and
 * is how the UI knows not to draw a switcher at all.
 *
 * A single entry is NOT the same answer and is deliberately not flattened to
 * an empty one. Somebody with one company is precisely who needs the control,
 * because joining a second is done from inside it — suppressing the list for
 * them would mean the only way to reach a second company was to already have
 * one.
 */
const switchableCompanies = async (user) => {
  if (!isMultiCompanyType(user.type)) return [];
  const rows = await companiesForEmail(sequelize, user.email);
  return rows
    .filter((row) => isMultiCompanyType(row.type))
    .map((row) => ({
      account_id: row.account_id,
      company_id: row.company_id ?? null,
      company_name: row.company_name || (row.company_id == null ? 'Platform' : `Company ${row.company_id}`),
      company_status: row.company_status || null,
      type: row.type,
      is_active: Boolean(row.is_active),
      current: Number(row.account_id) === Number(user.id),
    }));
};

/**
 * Re-issues the current session's payload-encryption key.
 *
 * The key is deliberately never persisted by the UI — a key sitting in
 * localStorage is a key anything with DOM access can read — so a page reload
 * loses it while the access token survives. This hands it back rather than
 * forcing a re-login for a page refresh.
 *
 * It gives away nothing the caller does not already have: a valid token for
 * this session is required, and the key only encrypts that same session's
 * payloads. The token remains the thing that authorises anything.
 *
 * This route is exempt from payload encryption (see NEVER_ENCRYPT), for the
 * obvious reason that a client asking for its key cannot decrypt the answer.
 */
const sessionKey = asyncHandler(async (req, res) => {
  const sid = req.user?.sid;
  if (!sid) {
    /**
     * A token issued BEFORE this feature existed has no sid.
     *
     * Answered with 200 and a null key, not an error: the correct client
     * behaviour is to carry on unencrypted until its next sign-in, and a 4xx
     * here would look like a broken session to a user whose session is fine.
     */
    return res.json({ data: { payloadKey: null, reason: 'session_predates_payload_encryption' } });
  }
  res.json({ data: { payloadKey: deriveKey(sid).toString('hex') } });
});

const register = asyncHandler(async (req, res) => {
  const { company_code } = req.body;

  if (!company_code) {
    return res.status(400).json({ message: 'A company referral code is required to register' });
  }

  // Look up the company by referral code
  const { sequelize } = require('../config/database');
  const [companies] = await sequelize.query(
    // The name comes back too: it is what the notice to an existing holder of
    // this address has to say, and a second query for it would be a second
    // chance for the two to disagree.
    'SELECT id, name, status FROM companies WHERE referral_code = :code LIMIT 1',
    { replacements: { code: String(company_code).trim().toUpperCase() } }
  );

  if (!companies.length) {
    return res.status(400).json({ message: 'Invalid company code. Please check with your company administrator.' });
  }

  const company = companies[0];
  if (company.status === 'suspended') {
    return res.status(403).json({ message: 'This company account is currently suspended.' });
  }

  const requestedRole = req.body.role || req.body.type || 'client';
  if (!PUBLIC_REGISTRATION_ROLES.includes(requestedRole)) {
    return res.status(403).json({ message: 'Selected role is not available for self-registration' });
  }

  /**
   * Whether this address may open an account with THIS company.
   *
   * "Email already exists" was the right answer while an address meant one
   * account on the platform. It is the wrong one now: a realtor who already
   * sells for one agency signing up with a second is the case this whole change
   * exists to allow. What is still refused is a second account in the SAME
   * company, and any account at all on an address that belongs to staff —
   * see shared/src/emailIdentity.js for why the second of those matters.
   */
  const availability = await emailAvailability(sequelize, {
    email: req.body.email,
    companyId: company.id,
    type: requestedRole,
  });
  if (!availability.ok) {
    return res.status(409).json({ message: availability.message });
  }

  /**
   * The password chosen here belongs to THIS company account, and to no other.
   *
   * Somebody who already has an account elsewhere is not asked to produce that
   * password — they may not remember it, and being unable to recall the
   * password for a company they signed up with two years ago is a poor reason
   * to refuse them a new one. They may reuse it if they like; nothing here
   * knows or cares.
   *
   * What makes that safe is that this account grants nothing beyond itself. A
   * session records which accounts its password actually opened, and moving to
   * one outside that set asks for that company's own password — so registering
   * on an address already in use creates an account at THIS company and reaches
   * no further. See switchCompany.
   *
   * The person it belongs to is told an account was opened, below, because
   * silent is the wrong way for that to happen.
   */
  const password = await bcrypt.hash(req.body.password, BCRYPT_ROUNDS);
  const roleName = requestedRole;
  /**
   * A property link shared by a realtor carries their code — map the new client
   * to that realtor.
   *
   * Resolved through the SHARED module rather than by a query written here.
   * signupAttribution.js exists precisely so that this path and Google sign-up
   * answer the question identically, and until now only Google used it: the
   * lookup inlined here was company-scoped, as it must be, but it never applied
   * the realtor-verification check. So the same link credited an unverified
   * realtor when the buyer typed a password and refused them when the buyer
   * pressed "Continue with Google" — the divergence that module was written to
   * prevent, present since it was written.
   *
   * An unknown or unverified code still does not block registration. The
   * account is valid either way; it is simply not attributed.
   */
  // Normalised by the same function the resolver uses, so the code quoted back
  // in the downline notification is the code it was actually looked up by.
  const realtorCode = normaliseCode(req.body.realtor_code);
  const referringRealtor = await realtorFromCode(sequelize, {
    code: realtorCode,
    companyId: company.id,
  });
  const realtorId = referringRealtor?.id ?? null;

  // A new realtor starts on the entry level rather than on no level at all.
  const startingLevelId = roleName === 'realtor'
    ? await defaultRealtorLevelId(sequelize, company.id)
    : null;

  /**
   * The index is the last word on "already in this company".
   *
   * emailAvailability asked the same question a moment ago and got a good
   * answer, but two registrations can pass that check at the same instant and
   * only one can pass the unique index. Caught and turned into the same
   * sentence the check would have produced, because a race should not be the
   * difference between a clear refusal and a 500.
   */
  let user;
  try {
    user = await User.create({
      ...req.body,
      password,
      type: roleName,
      company_id: company.id,
      // Clients AND realtors can be referred by a realtor.
      realtor_id: ['client', 'realtor'].includes(roleName) ? realtorId : null,
      realtor_level_id: startingLevelId,
    });
  } catch (error) {
    if (isDuplicateError(error)) {
      return res.status(409).json({ message: 'An account with this email already exists in this company.' });
    }
    throw error;
  }
  await syncUserRoles(user.id, [roleName]);

  /*
   * The introduction, as a record rather than only as a foreign key.
   *
   * users.realtor_id above is still the answer everything reads to decide who
   * earns. This is the journey beside it, so a realtor can later be told what
   * became of the people they introduced. Awaited but never fatal — the module
   * swallows its own failures.
   */
  if (realtorId) {
    await recordReferral(sequelize, {
      referrerId: realtorId,
      referredUserId: user.id,
      companyId: company.id,
      linkCode: realtorCode || null,
      source: 'code',
      status: REFERRAL_STATUS.REGISTERED,
    });
  }

  // Send welcome email (fire-and-forget — don't block registration on email failure)
  getBranding(company.id).then((brand) => {
    const { subject, text, html } = templates.welcomeEmail(brand, {
      name: user.name,
      email: user.email,
      loginUrl: process.env.FRONTEND_URL || null,
    });
    return sendEmail({ to: user.email, subject, text, html });
  }).catch((err) => console.error('[auth] Welcome email failed:', err.message));

  // Tell the referring realtor they gained a downline. Fire-and-forget for the
  // same reason as the welcome email: a notification must never fail a signup.
  if (realtorId && referringRealtor) {
    const { notifyUser } = createNotifier(sequelize);
    const joinedAs = roleName === 'realtor' ? 'a realtor' : 'a client';
    notify.dispatch({
      eventKey: 'realtor_downline_joined',
      subjectUserId: realtorId,
      companyId: company.id,
      context: { downline: user, referringRealtor },
      title: () => 'You have a new downline',
      body: (role) => (role === 'subject'
        ? `Hi ${referringRealtor.name},\n\n${user.name} just signed up as ${joinedAs} using your referral `
          + `code (${realtorCode}). They now appear in your referral network.`
        : `${user.name} signed up as ${joinedAs} through ${referringRealtor.name}'s referral code.`),
      data: { downline_id: user.id, downline_name: user.name, downline_type: roleName },
      actionLabel: 'View my referrals',
      actionUrl: appUrl('realtor/referrals', req),
    }).catch((err) => console.error('[auth] Downline notification failed:', err.message));
  }

  /*
   * Whoever already uses this address is told, because the password challenge
   * that used to stand here is gone. Fire-and-forget: the account is made.
   */
  if (availability.joins) {
    announceNewAccount({
      email: user.email,
      companyName: company.name || 'another company',
      excludeUserId: user.id,
      req,
    });
  }

  const session = await issueSession(user, null, { req });
  res.status(201).json(session);
});

// ── 2FA policy helpers ───────────────────────────────────────────────────────
const get2FAPolicy = async (companyId) => {
  try {
    const { sequelize } = require('../config/database');
    const rows = await sequelize.query(
      `SELECT ${q(sequelize, 'key')}, ${q(sequelize, 'value')}, company_id FROM settings
         WHERE ${q(sequelize, 'key')} = '2fa_required'
           AND (company_id IS NULL OR company_id = :companyId)`,
      { replacements: { companyId: companyId ?? 0 }, type: require('sequelize').QueryTypes.SELECT }
    );
    const global = rows.find((r) => r.company_id === null || r.company_id === undefined);
    const company = companyId ? rows.find((r) => r.company_id === companyId) : null;
    // Company 'off' overrides platform 'on'
    if (company?.value === 'off') return false;
    return company?.value === 'on' || global?.value === 'on';
  } catch {
    return false;
  }
};

/**
 * Finds the user behind a login identifier — an email or a phone number.
 *
 * Phone matching compares SIGNIFICANT DIGITS, not text. The column holds
 * numbers entered inconsistently over time ("0814 543 9255 " with spaces and a
 * trailing space is really in there), and the old `phone = :identifier` could
 * only ever match a row typed exactly as stored. So nobody with a stray space
 * in their number could sign in with it, and nobody could use the +234 form of
 * a number saved in the 0-prefixed form.
 *
 * An AMBIGUOUS phone resolves to nobody. Matching on a digit tail means two
 * rows could in principle share one, and signing somebody in as the wrong
 * person is far worse than asking them to use their email.
 */
/**
 * Every account an identifier could mean.
 *
 * ── Why this returns a list ─────────────────────────────────────────────────
 *
 * It used to return one account, because an email address meant one account.
 * It now means one PERSON, who may hold an account at each company they deal
 * with — so the identifier narrows the field and the password decides which of
 * those are actually theirs. See shared/src/emailIdentity.js.
 *
 * ── The phone number is still allowed to be ambiguous, and still refused ────
 *
 * Two accounts on one number are the same person when the address matches,
 * and two different people otherwise. The first is now ordinary and is
 * returned as a list; the second is the case the original refusal existed for
 * and is still refused, because there is no credential that could tell them
 * apart — whoever owns either password would be signed in as whichever row
 * happened to come first.
 */
const candidateAccounts = async (identifier) => {
  const value = String(identifier).trim();

  // Email first and exactly: an address that happens to contain digits must
  // never be treated as a phone number.
  const byEmail = await accountsForEmail(sequelize, value);
  if (byEmail.length) {
    return { accounts: await User.findAll({ where: { id: byEmail.map((row) => row.id) }, order: [['id', 'ASC']] }) };
  }

  if (!isPlausiblePhone(value)) return { accounts: [] };

  const rows = await sequelize.query(
    `SELECT id, ${q(sequelize, 'email')} FROM users
      WHERE deleted_at IS NULL
        AND ${phoneMatchSql('phone', ':phoneDigits')}
      ORDER BY id ASC`,
    {
      replacements: { phoneDigits: significantDigits(value) },
      type: QueryTypes.SELECT,
    },
  );
  if (!rows.length) return { accounts: [] };

  const addresses = new Set(rows.map((row) => normaliseEmail(row.email)));
  if (addresses.size > 1) {
    console.warn(`[auth] phone ${significantDigits(value)} matches ${addresses.size} different people — refusing`);
    return { accounts: [], ambiguous: true };
  }

  return { accounts: await User.findAll({ where: { id: rows.map((row) => row.id) }, order: [['id', 'ASC']] }) };
};

/**
 * Narrow a set of candidate accounts to the ones this password actually opens.
 *
 * Every account a person holds carries the same hash — setIdentityPassword
 * keeps them in step — so in practice this is all of them or none. It is
 * written as a filter rather than a single comparison because a database can
 * always be older than the rule that governs it: rows restored from a backup
 * taken before the identity model, or written directly, may still disagree,
 * and the right answer for those is "the companies this password opens", not
 * "refused" and not "all of them".
 */
const accountsOpenedBy = async (accounts, password) => {
  const opened = [];
  for (const account of accounts) {
    // eslint-disable-next-line no-await-in-loop
    if (account.password && await bcrypt.compare(password, account.password)) opened.push(account);
  }
  return opened;
};

/**
 * The companies behind a set of accounts, in the shape the sign-in screen
 * shows them.
 */
const describeCompanies = async (accounts) => {
  const ids = [...new Set(accounts.map((a) => a.company_id).filter((id) => id != null))];
  const names = new Map();
  if (ids.length) {
    const rows = await sequelize.query(
      'SELECT id, name, status FROM companies WHERE id IN (:ids)',
      { replacements: { ids }, type: QueryTypes.SELECT },
    );
    rows.forEach((row) => names.set(Number(row.id), row));
  }
  return accounts.map((account) => {
    const company = account.company_id == null ? null : names.get(Number(account.company_id));
    return {
      account_id: account.id,
      company_id: account.company_id ?? null,
      company_name: company?.name || (account.company_id == null ? 'Platform' : `Company ${account.company_id}`),
      company_status: company?.status || null,
      type: account.type,
      is_active: Boolean(account.is_active),
    };
  });
};

/**
 * A short-lived token naming the accounts a proven credential opened.
 *
 * The second step of a sign-in must not take a company id on trust — otherwise
 * anyone holding a company token could name any company on the platform and be
 * signed in as whoever happens to have an account there. The ids are IN the
 * token, signed, so the choice can only land on an account the credential
 * already unlocked.
 */
const COMPANY_CHOICE_PURPOSE = 'company_choice';

const createCompanyChoiceToken = async (accounts) => jwt.sign(
  { purpose: COMPANY_CHOICE_PURPOSE, accounts: accounts.map((a) => Number(a.id)) },
  await jwtSecret(),
  { expiresIn: tempTokenExpiry },
);

const readCompanyChoiceToken = async (token) => {
  try {
    const payload = jwt.verify(String(token || ''), await jwtSecret());
    if (payload.purpose !== COMPANY_CHOICE_PURPOSE || !Array.isArray(payload.accounts)) return null;
    return payload.accounts.map(Number);
  } catch {
    return null;
  }
};

/**
 * A company's name and status, for the sentences that have to name it.
 *
 * Refusals that say "that company is suspended" or "enter your password for
 * that company" are useless to somebody choosing between three of them, so
 * every such message needs the name and they all read it from here.
 */
const companyOf = async (companyId) => {
  if (companyId == null) return null;
  const [row] = await sequelize.query(
    'SELECT id, name, status FROM companies WHERE id = :id LIMIT 1',
    { replacements: { id: companyId }, type: QueryTypes.SELECT },
  ).catch(() => []);
  return row || null;
};

/** The company's name when it is suspended, and null when it is not. */
const companySuspended = async (companyId) => {
  const row = await companyOf(companyId);
  return row && row.status === 'suspended' ? (row.name || 'That company') : null;
};

/** What a caller gets back when there is more than one company to sign in to. */
const companyChoice = async (accounts) => ({
  requires_company: true,
  company_token: await createCompanyChoiceToken(accounts),
  companies: await describeCompanies(accounts),
});

/**
 * Refuses a sign-in while another session of this user's is still alive.
 *
 * Returns true when it has already answered the request, so callers read as
 * `if (await refuseIfSignedInElsewhere(...)) return;`.
 *
 * The message says WHEN the other session was last active and how long is
 * left, because "you are already signed in elsewhere" with no way to act on it
 * is the kind of refusal that generates a support call. The way out is to sign
 * out there, or to wait for the inactivity window.
 */
const refuseIfSignedInElsewhere = async (user, res) => {
  const { allowed, existing } = await sessionRegistry.canSignIn(user.id);
  if (allowed) return false;

  const lastSeen = Date.parse(existing.lastSeenAt || existing.startedAt || 0);
  const idleMs = Number.isFinite(lastSeen) ? Date.now() - lastSeen : 0;
  const freeInMinutes = Math.max(
    1, Math.ceil((sessionRegistry.inactivitySeconds() * 1000 - idleMs) / 60000),
  );

  res.status(409).json({
    message: 'This account is already signed in on another device or browser. '
      + `Sign out there first, or try again in about ${freeInMinutes} minute`
      + `${freeInMinutes === 1 ? '' : 's'} once that session goes idle.`,
    reason: 'session_already_active',
    session: {
      last_active_at: existing.lastSeenAt || existing.startedAt || null,
      retry_after_minutes: freeInMinutes,
    },
  });
  return true;
};

/**
 * Everything a sign-in does once it knows WHICH account.
 *
 * Split out because there are now two ways to arrive here — straight from the
 * password when a person has one company, and from the company choice when
 * they have several — and the two-factor rules must not differ between them.
 * The policy is the CHOSEN company's, which is only knowable after the choice:
 * a realtor whose agency enforces two-factor has to satisfy it when signing in
 * there, and should not be asked for it when signing in to a company that does
 * not.
 */
const completeSignIn = async (user, req, res, opened = null) => {
  if (!user.is_active) {
    return res.status(403).json({ message: 'Account is inactive' });
  }

  /**
   * A suspended company is not enterable, by any of its accounts.
   *
   * Registration has always refused to CREATE an account against one; this is
   * the same rule applied to the accounts that already exist, and it has to
   * live here rather than in `login` because a person with several companies
   * reaches this from the choice screen instead.
   */
  const suspended = await companySuspended(user.company_id);
  if (suspended) {
    return res.status(403).json({
      message: `${suspended} is currently suspended. Please contact their administrator.`,
      reason: 'company_suspended',
    });
  }

  const roles = await getUserRolesData(user.id);
  const permissions = await getUserPermissions(user.id);
  const tempToken = await createTempToken(user, opened);

  // User has already set up 2FA — always require it regardless of admin policy
  if (user.two_factor_enabled) {
    return res.json({
      requires_2fa: true,
      temp_token: tempToken,
      user: sanitizeUser(user, permissions),
      roles,
    });
  }

  // Check if 2FA is admin-required for this user's company
  const required = await get2FAPolicy(user.company_id ?? null);
  if (required) {
    return res.json({
      requires_2fa_setup: true,
      temp_token: tempToken,
      user: sanitizeUser(user, permissions),
      roles,
    });
  }

  if (await refuseIfSignedInElsewhere(user, res)) return;
  const session = await issueSession(user, null, { req, opened });
  return res.json(session);
};

/**
 * Tell the person an address already belongs to that a new account has opened
 * on it.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Registering with an address that already has accounts used to require that
 * address's password. It no longer does — somebody joining their second company
 * two years on may not remember the first one's password, and refusing them
 * over it was the wrong trade.
 *
 * What that removes is a challenge, so this puts back the part that mattered:
 * visibility. The new account reaches nothing but itself — a session may only
 * enter a company whose password it has been shown — so the risk is not
 * access, it is that somebody could quietly open an account in another
 * person's name and they would never know. Now they are told, by name, at
 * every address they already hold.
 *
 * Best effort and never awaited by the caller: a notification must not fail a
 * registration.
 */
const announceNewAccount = async ({ email, companyName, excludeUserId, req }) => {
  try {
    const existing = (await accountsForEmail(sequelize, email))
      .filter((row) => Number(row.id) !== Number(excludeUserId));
    if (!existing.length) return;

    await Promise.all(existing.map((account) => notify.dispatch({
      eventKey: 'account_opened_elsewhere',
      subjectUserId: account.id,
      companyId: account.company_id ?? null,
      type: 'account_opened',
      title: () => 'A new account was opened with your email',
      body: () => `An account with ${companyName} was just created using ${email}.\n\n`
        + 'If that was you, nothing further is needed — it is a separate account '
        + 'with its own password, and it does not change the companies you already '
        + 'use.\n\nIf it was not you, change your password and tell us.',
      data: { company_name: companyName },
      actionLabel: 'Review your account',
      actionUrl: appUrl('profile', req),
    }).catch(() => {})));
  } catch (error) {
    console.error('[auth] could not announce a new account:', error.message);
  }
};

const login = asyncHandler(async (req, res) => {
  const identifier = req.body.identifier || req.body.email || req.body.phone || '';
  const { password } = req.body;

  if (!identifier) {
    return res.status(400).json({ message: 'Email or phone number is required' });
  }

  const { accounts, ambiguous } = await candidateAccounts(identifier);

  if (ambiguous) {
    return res.status(409).json({
      message: 'That phone number is registered to more than one person. Please sign in with your email address.',
    });
  }

  const opened = await accountsOpenedBy(accounts, password);
  if (!opened.length) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  /**
   * Disabled accounts are removed from the choice, not from the answer.
   *
   * Somebody whose realtor account at one agency was switched off still signs
   * in to their other companies; offering the dead one would be an entry that
   * refuses them after they pick it. When it is the ONLY one, the refusal is
   * the answer — and it is the same refusal as before, so nothing about a
   * single-company sign-in changed.
   */
  const active = opened.filter((account) => account.is_active);
  if (!active.length) {
    return res.status(403).json({ message: 'Account is inactive' });
  }

  /*
   * One company is the overwhelmingly common case and must stay a single
   * round trip — nobody is asked to choose between one thing.
   */
  const proven = opened.map((account) => Number(account.id));
  if (active.length === 1) return completeSignIn(active[0], req, res, proven);

  return res.json(await companyChoice(active));
});

/**
 * The second step, for a person who belongs to more than one company.
 *
 * The password was already proved in the first step; this does not ask for it
 * again. What it checks is that the company named is one the token says that
 * password opened — see createCompanyChoiceToken for why the list is signed
 * into the token rather than looked up again from the company id.
 */
const loginToCompany = asyncHandler(async (req, res) => {
  const token = req.body.company_token || req.body.companyToken;
  const requested = req.body.company_id ?? req.body.companyId;

  const allowed = await readCompanyChoiceToken(token);
  if (!allowed) {
    return res.status(401).json({
      message: 'That sign-in has expired. Please enter your password again.',
      reason: 'company_choice_expired',
    });
  }

  const accounts = await User.findAll({ where: { id: allowed, deleted_at: null } });
  const wanted = requested == null || requested === '' ? null : Number(requested);
  const user = accounts.find((account) => (
    wanted === null ? account.company_id == null : Number(account.company_id) === wanted
  ));

  if (!user) {
    return res.status(403).json({ message: 'You do not have an account with that company.' });
  }

  /*
   * Every account in the token was opened by the password given at the first
   * step — that is what the token records — so all of them are proved, not
   * just the one being entered.
   */
  return completeSignIn(user, req, res, allowed);
});

const verify2FA = asyncHandler(async (req, res) => {
  const tempToken = req.body.temp_token || req.body.tempToken;
  const totpToken = req.body.totp_token || req.body.token;

  if (!tempToken || !totpToken) {
    return res.status(400).json({ message: 'Temporary token and TOTP token are required' });
  }

  let payload;
  try {
    const secret = await jwtSecret();
    payload = jwt.verify(tempToken, secret);
  } catch {
    return res.status(401).json({ message: 'Invalid or expired temporary token' });
  }

  if (payload.purpose !== '2fa' || !payload.id) {
    return res.status(401).json({ message: 'Invalid temporary token' });
  }

  const user = await User.findByPk(payload.id);
  if (!user || !user.two_factor_enabled || !user.two_factor_secret) {
    return res.status(400).json({ message: 'Two-factor authentication is not enabled for this user' });
  }

  const secret = await decryptSecret(user.two_factor_secret);
  if (!verifyTotpToken(secret, totpToken)) {
    return res.status(401).json({ message: 'Invalid verification code' });
  }

  if (await refuseIfSignedInElsewhere(user, res)) return;
  const session = await issueSession(user, null, { req, opened: payload.opened || null });
  res.json(session);
});

const setup2FA = asyncHandler(async (req, res) => {
  const user = await User.findByPk(req.user.id);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  const secret = speakeasy.generateSecret({
    name: `Realto (${user.email})`,
    issuer: 'Realto',
  });

  user.two_factor_secret = await encryptSecret(secret.base32);
  user.two_factor_enabled = false;
  await user.save();

  const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);
  res.json({ qrCodeUrl, secret: secret.base32 });
});

const verify2FASetup = asyncHandler(async (req, res) => {
  const user = await User.findByPk(req.user.id);
  if (!user || !user.two_factor_secret) {
    return res.status(404).json({ message: 'Two-factor setup not found' });
  }

  const token = req.body.token || req.body.totp_token;
  const secret = await decryptSecret(user.two_factor_secret);
  if (!token || !verifyTotpToken(secret, token)) {
    return res.status(401).json({ message: 'Invalid verification code' });
  }

  user.two_factor_enabled = true;
  await user.save();
  const permissions = await getUserPermissions(user.id);

  // Notify user that 2FA has been enabled
  getBranding(user.company_id ?? null).then((brand) => {
    const { subject, text, html } = templates.twoFactorEnabled(brand, { name: user.name });
    return sendEmail({ to: user.email, subject, text, html });
  }).catch((err) => console.error('[auth] 2FA enabled email failed:', err.message));

  res.json({ message: 'Two-factor authentication enabled', user: sanitizeUser(user, permissions) });
});

const disable2FA = asyncHandler(async (req, res) => {
  const user = await User.findByPk(req.user.id);
  if (!user || !user.two_factor_enabled || !user.two_factor_secret) {
    return res.status(400).json({ message: 'Two-factor authentication is not enabled' });
  }

  const token = req.body.token || req.body.totp_token;
  const secret = await decryptSecret(user.two_factor_secret);
  if (!token || !verifyTotpToken(secret, token)) {
    return res.status(401).json({ message: 'Invalid verification code' });
  }

  user.two_factor_enabled = false;
  user.two_factor_secret = null;
  await user.save();
  const permissions = await getUserPermissions(user.id);

  // Notify user that 2FA has been disabled
  getBranding(user.company_id ?? null).then((brand) => {
    const { subject, text, html } = templates.twoFactorDisabled(brand, { name: user.name });
    return sendEmail({ to: user.email, subject, text, html });
  }).catch((err) => console.error('[auth] 2FA disabled email failed:', err.message));

  res.json({ message: 'Two-factor authentication disabled', user: sanitizeUser(user, permissions) });
});

const refresh = asyncHandler(async (req, res) => {
  const storedToken = await RefreshToken.findOne({ where: { token: req.body.refreshToken }, include: ['user'] });
  if (!storedToken || storedToken.expires_at < new Date()) {
    return res.status(401).json({ message: 'Refresh token is invalid or expired' });
  }

  // Preserve the active role from previous session if provided, otherwise keep last used
  const roleId = req.body.roleId ? Number(req.body.roleId) : null;
  /**
   * A refresh continues the session the token was issued for.
   *
   * It reuses that id rather than minting one, because treating a refresh as a
   * new sign-in would have every user refused an hour after logging in, by
   * their own still-live session.
   *
   * And it must be the token's OWN session, not simply whichever session is
   * currently live. Reading the live one instead would let a client that had
   * been signed out by a newer login refresh straight back into that newer
   * session — silently undoing the rule it had just been pushed out by.
   */
  if (storedToken.sid && !(await sessionRegistry.isCurrentSession(storedToken.user_id, storedToken.sid))) {
    await RefreshToken.destroy({ where: { token: req.body.refreshToken } });
    return res.status(401).json({
      message: 'You have been signed out because this account was signed in elsewhere.',
      reason: 'session_superseded',
    });
  }

  const session = await issueSession(storedToken.user, roleId, {
    sid: storedToken.sid || null,
    req,
    // What that password proved, remembered on the token. Null for one issued
    // before the column existed, which reads as "only its own account".
    opened: openedFrom(storedToken),
  });
  res.json({
    accessToken: session.accessToken,
    user: session.user,
    roles: session.roles,
    activeRoleId: session.activeRoleId,
    activeRole: session.activeRole,
  });
});


/**
 * Self-enable the counterpart profile in the realtor/client pair, so a user can
 * operate as both without an admin round-trip (Airbnb-style dual profile).
 *
 * Deliberately limited to that pair: this grants a role to yourself, so it must
 * never become a path to admin-level profiles.
 */
const enableProfile = asyncHandler(async (req, res) => {
  const profile = String(req.body.profile || '').toLowerCase();
  if (!SWITCHABLE_PROFILES.includes(profile)) {
    return res.status(400).json({ message: `Profile must be one of: ${SWITCHABLE_PROFILES.join(', ')}` });
  }

  const user = await User.findByPk(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found' });

  const { sequelize } = require('../config/database');
  const existing = await getUserRolesData(user.id);
  const heldNames = existing.map((role) => role.name);

  // Only someone already operating within the pair may add the other half.
  const withinPair = SWITCHABLE_PROFILES.includes(user.type) || heldNames.some((n) => SWITCHABLE_PROFILES.includes(n));
  if (!withinPair) {
    return res.status(403).json({ message: 'Only realtor or client accounts can add a second profile.' });
  }

  if (heldNames.includes(profile)) {
    return res.status(409).json({ message: `You already have the ${profile} profile.` });
  }

  const [role] = await sequelize.query(
    'SELECT id FROM roles WHERE name = :profile ORDER BY (company_id IS NULL) DESC LIMIT 1',
    { replacements: { profile }, type: QueryTypes.SELECT },
  );
  if (!role) return res.status(404).json({ message: `The ${profile} role is not configured.` });

  await insertIgnoring(
    sequelize,
    'user_roles (user_id, role_id) VALUES (:userId, :roleId)',
    { replacements: { userId: user.id, roleId: role.id }, type: QueryTypes.INSERT },
  );

  // Someone adding a realtor profile is a new realtor: start them on the entry
  // level too. Never overwrite a level they were already placed on.
  if (profile === 'realtor' && !user.realtor_level_id) {
    const startingLevelId = await defaultRealtorLevelId(sequelize, user.company_id ?? null);
    if (startingLevelId) await user.update({ realtor_level_id: startingLevelId });
  }

  // Reissue against the newly added profile so the caller is switched into it.
  // A profile is not a company: the session continues, and so does what it proved.
  const session = await issueSession(user, role.id, {
    sid: req.user?.sid || null, req, opened: req.user?.openedAccounts || null,
  });
  res.status(201).json(session);
});

/** The companies the signed-in person holds an account with. */
const myCompanies = asyncHandler(async (req, res) => {
  const user = await User.findByPk(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found' });
  res.json({
    data: {
      current_company_id: user.company_id ?? null,
      companies: await switchableCompanies(user),
      multi_company_signups: multiCompanySignupsEnabled(),
    },
  });
});

/**
 * Move to the account this person holds at another company, without signing
 * out and back in.
 *
 * ── Why no password is asked for ────────────────────────────────────────────
 *
 * There is nothing further to prove. The accounts share one credential, and
 * the live session is proof that credential was presented — asking for it
 * again would be asking the same question twice and would make the switcher
 * slower than signing out, which is the thing it replaces.
 *
 * The authorisation is therefore about IDENTITY, and it is checked here rather
 * than inferred from the request: the target must be an account on the same
 * address, held by somebody entitled to more than one, and still switched on.
 * A company id from the client names a candidate; it never selects one.
 *
 * ── Why the old session ends ────────────────────────────────────────────────
 *
 * One person, one live session, is a rule this platform already enforces, and
 * a switch that left the previous one running would break it quietly — the
 * abandoned session keeps a valid refresh token for the company just left, and
 * the single-sign-in hold would then refuse that account a fresh sign-in
 * elsewhere until it timed out on its own.
 */
const switchCompany = asyncHandler(async (req, res) => {
  const current = await User.findByPk(req.user.id);
  if (!current) return res.status(404).json({ message: 'User not found' });

  if (!isMultiCompanyType(current.type)) {
    return res.status(403).json({
      message: 'Staff accounts belong to a single company.',
    });
  }

  const requested = req.body.company_id ?? req.body.companyId;
  if (requested === undefined || requested === null || requested === '') {
    return res.status(400).json({ message: 'Choose the company to switch to.' });
  }
  const wanted = Number(requested);

  const siblings = await accountsForEmail(sequelize, current.email);
  const match = siblings.find((row) => Number(row.company_id) === wanted);

  if (!match || !isMultiCompanyType(match.type)) {
    return res.status(403).json({ message: 'You do not have an account with that company.' });
  }
  if (Number(match.id) === Number(current.id)) {
    return res.status(409).json({ message: 'You are already signed in to that company.' });
  }
  if (!match.is_active) {
    return res.status(403).json({
      message: 'Your account with that company is not active. Ask their administrator to enable it.',
    });
  }

  const company = await companyOf(match.company_id);
  if (company?.status === 'suspended') {
    return res.status(403).json({
      message: `${company.name || 'That company'} is currently suspended.`,
      reason: 'company_suspended',
    });
  }

  const target = await User.findByPk(match.id);
  if (!target) return res.status(404).json({ message: 'That account no longer exists.' });

  /**
   * Two-factor is a SIGN-IN gate, and a switch is not a sign-in.
   *
   * Which is the problem: a company that requires two-factor authentication
   * requires it of everybody reaching its data, and somebody who satisfied
   * another company's policy — or no policy at all — has not satisfied this
   * one. Switching would walk straight past it.
   *
   * Refused rather than answered here, because answering it properly means
   * ending this session before the new one exists: a code prompt in the middle
   * of a switch leaves somebody signed out of the company they were in if they
   * cannot produce the code. Signing in to that company directly does the whole
   * thing in the right order, and the message says so.
   */
  if (target.two_factor_enabled || await get2FAPolicy(target.company_id ?? null)) {
    return res.status(409).json({
      message: 'That company requires two-factor authentication, so it cannot be '
        + 'switched into from here. Sign out and sign in to it directly.',
      reason: 'two_factor_required',
    });
  }

  /*
   * A live session on the target account means the same person is signed in to
   * that company somewhere else. Refused with the same explanation a sign-in
   * would give, rather than silently taking it over.
   */
  /**
   * A password, but only where one is actually needed.
   *
   * Every company account has its own password now, and they may differ. So
   * "the same person owns both rows" stopped being a reason to let a session
   * move between them: whoever knew only the weaker password would reach the
   * stronger company through a switch, and per-company passwords would be
   * decoration.
   *
   * What the session carries instead is the set of accounts the credential
   * behind it was actually shown to open. Inside that set nothing is asked,
   * which is the ordinary case — somebody using one password everywhere had
   * every account proved at sign-in and notices no difference at all. Outside
   * it, the target's OWN password is required, and it is checked against the
   * target rather than against anything the caller already holds.
   *
   * Asked for here rather than by sending them back to the sign-in screen,
   * because that is the thing the switcher exists to avoid.
   */
  const proved = (req.user?.openedAccounts || []).map(Number);
  let opened = proved;

  if (!proved.includes(Number(target.id))) {
    const offered = String(req.body.password ?? '');
    /*
     * 403 and not 401, deliberately.
     *
     * The caller's own session is perfectly valid — it simply does not extend
     * to this company. 401 would say "your token is stale", and the web
     * client believes it: its interceptor spends a refresh and retries, which
     * costs a round trip, earns the same refusal, and eats into the refresh
     * budget that exists to stop a loop signing somebody out.
     */
    if (!offered) {
      return res.status(403).json({
        message: `Enter your password for ${company?.name || 'that company'}.`,
        reason: 'password_required',
      });
    }
    if (!target.password || !(await bcrypt.compare(offered, target.password))) {
      return res.status(403).json({
        message: 'That password does not open your account with that company.',
        reason: 'password_incorrect',
      });
    }
    // Proved now, and for the rest of this session — switching back and forth
    // should not ask twice.
    opened = [...proved, Number(target.id)];
  }

  if (await refuseIfSignedInElsewhere(target, res)) return;

  /*
   * The session being left is ended BEFORE the new one starts, and its refresh
   * tokens with it — a token that outlived the switch would let the company
   * just left be resumed without signing in.
   *
   * EVERY token for that account, not only the one bearing this session's id.
   * Narrowing it to `sid` looked tidier and was worse in the one case that
   * matters: a caller whose token predates the sid claim, or a row written
   * without one, leaves a working refresh token behind and the switch quietly
   * fails to end anything. One live session per account is the rule anyway, so
   * there is nothing here worth preserving.
   */
  await RefreshToken.destroy({ where: { user_id: current.id } });
  await sessionRegistry.endSession(current.id).catch(() => {});

  const session = await issueSession(target, null, { req, opened });
  res.json(session);
});

/**
 * Open an account with another company, without leaving the one you are in.
 *
 * ── Why this exists next to registration ────────────────────────────────────
 *
 * Registration can already do it: sign out, sign up with the same address and
 * the same password, and the company is added to the identity. That is a
 * ridiculous thing to ask of somebody who is already signed in and holding the
 * code — they have to leave, prove who they are again, and type a password
 * the application is already holding a valid session for.
 *
 * So this is the same operation with the credential step removed, because the
 * session IS the credential step. Everything else is identical, deliberately:
 * the same code resolution, the same attribution, the same availability rules.
 *
 * ── It does not switch you in ───────────────────────────────────────────────
 *
 * Adding a company and moving to one are different things, and the second has
 * guards the first does not need — an inactive account, a suspended company, a
 * two-factor policy, a live session elsewhere. Rather than repeat those here
 * where they would eventually disagree, this returns the new company and
 * leaves the move to switchCompany, which already enforces every one of them.
 */
const joinCompany = asyncHandler(async (req, res) => {
  const current = await User.findByPk(req.user.id);
  if (!current) return res.status(404).json({ message: 'User not found' });

  if (!isMultiCompanyType(current.type)) {
    return res.status(403).json({
      message: 'Staff accounts belong to a single company.',
    });
  }

  /*
   * The role at the NEW company, which need not be the role held at this one:
   * somebody who sells for one agency may simply be buying from another.
   * Defaults to what they already are, because that is the common case.
   */
  const requestedRole = String(req.body.role || '').trim().toLowerCase() || current.type;
  if (!PUBLIC_REGISTRATION_ROLES.includes(requestedRole)) {
    return res.status(400).json({
      message: `You can join another company as: ${PUBLIC_REGISTRATION_ROLES.join(' or ')}.`,
    });
  }

  const code = String(req.body.company_code || req.body.code || '').trim();
  if (!code) return res.status(400).json({ message: 'Enter the company code.' });

  // Resolves the company, refuses a suspended one, and credits the referring
  // realtor where a code names one — the same module registration uses, so a
  // link works identically whether it is followed before or after signing in.
  const attribution = await resolveSignup(sequelize, {
    companyCode: code,
    realtorCode: req.body.realtor_code,
  });
  if (!attribution.ok) {
    return res.status(400).json({ message: attribution.message, reason: attribution.reason });
  }

  const availability = await emailAvailability(sequelize, {
    email: current.email,
    companyId: attribution.company.id,
    type: requestedRole,
  });
  if (!availability.ok) {
    return res.status(409).json({
      /*
       * "This email is already registered" is true and useless here — it is
       * their own address, and of course it is registered. The soak switch
       * gets a sentence about the thing they were actually trying to do.
       */
      message: availability.disabled
        ? 'Opening an account with a second company is not switched on here yet.'
        : availability.message,
      ...(availability.disabled ? { reason: 'multi_company_disabled' } : {}),
    });
  }

  const offered = String(req.body.password ?? '');
  if (offered && offered.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    });
  }
  const chosenPassword = offered ? await bcrypt.hash(offered, BCRYPT_ROUNDS) : null;

  const startingLevelId = requestedRole === 'realtor'
    ? await defaultRealtorLevelId(sequelize, attribution.company.id)
    : null;

  // Same backstop as registration: the index decides, and a race must still
  // read as a refusal rather than a crash.
  let account;
  try {
    account = await User.create({
      name: current.name,
      email: current.email,
      /*
       * A password of their own if they gave one, otherwise the one they are
       * signed in with.
       *
       * Optional on purpose. Somebody adding a company from inside the app is
       * usually not trying to acquire a second password to remember, so the
       * default is the one already in their hands — and because this session
       * proved that password, the new company joins the set they can switch into
       * freely. Supplying a different one is allowed and simply means the switch
       * will ask for it.
       */
      password: chosenPassword || current.password,
      phone: current.phone,
      avatar: current.avatar,
      lang: current.lang,
      type: requestedRole,
      company_id: attribution.company.id,
      realtor_id: attribution.realtor?.id ?? null,
      realtor_level_id: startingLevelId,
      is_active: true,
    });
  } catch (error) {
    if (isDuplicateError(error)) {
      return res.status(409).json({ message: 'You already have an account with that company.' });
    }
    throw error;
  }
  await syncUserRoles(account.id, [requestedRole]);

  if (account.realtor_id) {
    await recordReferral(sequelize, {
      referrerId: account.realtor_id,
      referredUserId: account.id,
      companyId: account.company_id ?? null,
      linkCode: normaliseCode(req.body.realtor_code) || null,
      source: 'code',
      status: REFERRAL_STATUS.REGISTERED,
    });
  }

  /* Same visibility as registration, for the same reason. */
  announceNewAccount({
    email: account.email,
    companyName: attribution.company.name || 'another company',
    excludeUserId: account.id,
    req,
  });

  res.status(201).json({
    data: {
      company: { id: attribution.company.id, name: attribution.company.name },
      account_id: account.id,
      type: requestedRole,
      /*
       * Whether switching there will ask for anything. False when they chose a
       * separate password, because this session has not been shown that one —
       * and the screen should say so rather than letting the next click
       * surprise them.
       */
      switch_needs_password: Boolean(chosenPassword),
      // The switcher's list, already including the company just added, so the
      // caller has nothing to re-fetch before offering to move there.
      companies: await switchableCompanies(current),
    },
  });
});

const switchRole = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const roleId = req.body.roleId ? Number(req.body.roleId) : null;

  if (!roleId) {
    return res.status(400).json({ message: 'roleId is required' });
  }

  // Verify this role belongs to the user
  const { sequelize } = require('../config/database');
  const [assignment] = await sequelize.query(
    'SELECT 1 FROM user_roles WHERE user_id = :userId AND role_id = :roleId LIMIT 1',
    { replacements: { userId, roleId }, type: QueryTypes.SELECT }
  );

  if (!assignment) {
    return res.status(403).json({ message: 'You do not have this profile' });
  }

  const user = await User.findByPk(userId);
  if (!user) return res.status(404).json({ message: 'User not found' });

  const session = await issueSession(user, roleId, {
    sid: req.user?.sid || null, req, opened: req.user?.openedAccounts || null,
  });
  res.json(session);
});

const logout = asyncHandler(async (req, res) => {
  /**
   * The user is resolved from the REFRESH TOKEN, not from req.user.
   *
   * This route is not behind verifyToken — a client whose access token has
   * already expired must still be able to sign out — so req.user is undefined
   * here. Reading it would have released nobody's session, and the single
   * sign-in hold would then only ever lapse by inactivity, which is exactly
   * the wait signing out is supposed to avoid.
   */
  const stored = await RefreshToken.findOne({ where: { token: req.body.refreshToken } });
  const userId = stored?.user_id ?? req.user?.id ?? null;

  await RefreshToken.destroy({ where: { token: req.body.refreshToken } });
  await sessionRegistry.endSession(userId);

  /**
   * Same reason as the sign-in above: this route is not behind verifyToken, so
   * the actor has to be named from the refresh token that was presented. An
   * unknown token releases no session and names nobody, and the middleware
   * writes no row — which is correct, because nothing happened.
   */
  if (userId) {
    const account = await User.findByPk(userId);
    req.audit?.({
      actor_id: userId,
      actor_name: account?.name || null,
      actor_email: account?.email || null,
      actor_type: account?.type || null,
      company_id: account?.company_id ?? null,
    });
  }

  res.json({ message: 'Logged out successfully' });
});

// ── Email helper (nodemailer with console fallback) ──────────────────────────
/**
 * Hard ceiling on an email attempt, kept below the gateway's 30s proxy timeout.
 *
 * Sized for the worst case that still succeeds: a first send that has to try
 * every candidate port before finding one that works. A tighter cap would
 * abort exactly the case the fallback exists to rescue.
 */
const SEND_TIMEOUT_MS = 25000;

const sendEmail = async ({ to, subject, text, html }) => {
  const host     = await getCfg('mail_host',         process.env.SMTP_HOST);
  const port     = Number(await getCfg('mail_port',  process.env.SMTP_PORT  || 587));
  const user     = await getCfg('mail_username',     process.env.SMTP_USER);
  const pass     = await getCfg('mail_password',     process.env.SMTP_PASS);
  const fromAddr = await getCfg('mail_from_address', process.env.SMTP_FROM || user);
  const fromName = await getCfg('mail_from_name',    'Realto');
  const from     = fromName ? `"${fromName}" <${fromAddr}>` : fromAddr;

  if (host && user && pass) {
    try {
      /**
       * The shared transport picks a port that actually works and remembers
       * it — see shared/src/mailTransport.js. The timeouts that used to be set
       * here moved there so all four senders in this codebase share them.
       */
      const result = await Promise.race([
        sendMail({ host, port, user, pass, label: 'auth', message: { from, to, subject, text, html } }),
        /**
         * Still capped, and the cap now allows for DISCOVERY.
         *
         * The first send in a new environment may walk the candidate ports
         * before finding one, which takes longer than a single attempt — 12s
         * measured against a host whose first two ports were blocked. The old
         * 15s ceiling would have aborted that just before it succeeded, and
         * the environment would have looked permanently broken rather than
         * slow once. It still finishes inside the gateway's 30s limit, and
         * every later send uses the remembered port in milliseconds.
         */
        new Promise((_, reject) => setTimeout(() => reject(new Error('SMTP timed out')), SEND_TIMEOUT_MS)),
      ]);
      if (!result.sent) {
        console.error(`[auth] email to ${to} not sent (${result.reason})`);
        return false;
      }
      return true;
    } catch (err) {
      console.error('[auth] Failed to send email via SMTP:', err.message);
      return false;
    }
  }

  // Fallback: log to console when SMTP not configured
  console.log('\n══════════════ EMAIL (SMTP not configured) ══════════════');
  console.log(`To: ${to}`);
  console.log(`Subject: ${subject}`);
  console.log(text);
  console.log('══════════════════════════════════════════════════════════\n');
  return false;
};

const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email is required' });

  const user = await User.findOne({ where: { email } });
  if (!user) {
    // Return generic success to prevent user enumeration
    return res.json({ message: 'If an account exists, a 6-digit OTP has been sent to that email.' });
  }

  /**
   * crypto.randomInt, not Math.random.
   *
   * Math.random is xorshift128+: fast, uniform, and completely predictable
   * once you have seen enough of its output — and this endpoint hands out
   * output to anyone who asks, six digits at a time. A code that can be
   * computed instead of guessed makes the length and the expiry irrelevant.
   */
  const otp = String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await PasswordReset.destroy({ where: { email } });
  await PasswordReset.create({ email, token: otp, expires_at: expiresAt, attempts: 0, nonce: null });

  const brand = await getBranding(user.company_id ?? null);
  const { subject, text, html } = templates.passwordResetOtp(brand, { otp, expiryMinutes: 10 });
  const sent = await sendEmail({ to: email, subject, text, html });
  if (!sent) console.error(`[auth] Password reset OTP for ${email} was not delivered.`);

  // Same wording as the unknown-email branch: a different message here would
  // let anyone probe which addresses have accounts.
  res.json({ message: 'If an account exists, a 6-digit OTP has been sent to that email.' });
});

/**
 * How many wrong codes one reset may absorb before it is torn up.
 *
 * Five is generous for somebody reading a code out of their inbox, and it
 * bounds a guess at 5 in 900,000 — where the per-IP limiter alone bounds only
 * what ONE source can try, and a distributed guess is the case that matters.
 */
const MAX_OTP_ATTEMPTS = 5;

const verifyResetOtp = asyncHandler(async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ message: 'Email and OTP are required' });

  /*
   * Found by EMAIL, not by email-and-token. Matching on the token meant a wrong
   * guess simply found no row, so there was nothing to count the guess against
   * — the attempt limit below only exists because the lookup changed shape.
   */
  const record = await PasswordReset.findOne({ where: { email } });
  const invalid = { message: 'Invalid or expired OTP. Please request a new code.' };
  if (!record || record.expires_at < new Date()) return res.status(400).json(invalid);

  if (record.attempts >= MAX_OTP_ATTEMPTS) {
    await record.destroy();
    return res.status(400).json({
      message: 'Too many incorrect codes. Request a new one.',
    });
  }

  /*
   * Compared in constant time. The window on a string comparison of a six-digit
   * code over a network is not practically exploitable, and writing it the
   * other way invites the question every time somebody reads it.
   */
  const supplied = Buffer.from(String(otp));
  const expected = Buffer.from(String(record.token));
  const correct = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);

  if (!correct) {
    await record.increment('attempts');
    return res.status(400).json(invalid);
  }

  /**
   * The token is bound to this row and the row is consumed by resetPassword.
   *
   * It used to be a bare { purpose, email } JWT checked by signature alone, so
   * for its five minutes it reset the password as many times as it was
   * replayed. The nonce is what makes "single use" true rather than intended.
   */
  const nonce = crypto.randomBytes(24).toString('hex');
  await record.update({ nonce, attempts: 0 });

  const secret = await jwtSecret();
  const resetToken = jwt.sign({ purpose: 'password_reset', email, nonce }, secret, { expiresIn: '5m' });

  /**
   * The companies this address holds accounts with, so the next step can ask
   * which one the new password is for.
   *
   * Safe to disclose HERE and nowhere earlier: the code has just been proved,
   * which means control of the mailbox. Returning it from the request step
   * would tell anybody who typed an address where its owner does business.
   *
   * Only ever more than one entry for somebody who deals with several
   * companies; the screen shows no choice at all for everyone else.
   */
  const companies = (await companiesForEmail(sequelize, email))
    .filter((row) => row.company_id != null)
    .map((row) => ({
      company_id: row.company_id,
      company_name: row.company_name || `Company ${row.company_id}`,
      type: row.type,
    }));

  res.json({ reset_token: resetToken, companies });
});

const resetPassword = asyncHandler(async (req, res) => {
  const { reset_token, password } = req.body;
  if (!reset_token || !password) {
    return res.status(400).json({ message: 'Reset token and new password are required' });
  }

  let payload;
  try {
    const secret = await jwtSecret();
    payload = jwt.verify(reset_token, secret);
  } catch {
    return res.status(400).json({ message: 'Reset link has expired. Please request a new OTP.' });
  }

  if (payload.purpose !== 'password_reset' || !payload.email || !payload.nonce) {
    return res.status(400).json({ message: 'Invalid reset token' });
  }

  /**
   * The row the token was minted from, or nothing.
   *
   * A signature says the token was issued by us; it does not say it has not
   * already been spent. Matching the nonce against the surviving row — and
   * deleting that row below — is what makes the second use of a token fail.
   */
  const reset = await PasswordReset.findOne({ where: { email: payload.email, nonce: payload.nonce } });
  if (!reset) {
    return res.status(400).json({ message: 'This reset link has already been used. Request a new code.' });
  }

  const identity = await accountsForEmail(sequelize, payload.email);
  const user = identity.length
    ? await User.findByPk(identity[0].id)
    : await User.findOne({ where: { email: payload.email } });
  if (!user) return res.status(404).json({ message: 'User not found' });

  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }

  /**
   * WHICH accounts this reset applies to.
   *
   * It used to be all of them, unconditionally, which was right while they
   * shared one password and is wrong now that they do not: somebody resetting
   * a forgotten password for one company would silently have the password for
   * their other companies changed too, without being asked and without being
   * told.
   *
   * So the caller names a company, and all of them remains available as an
   * explicit choice — somebody who has lost track of the lot should be able to
   * say so in one step rather than repeating the whole flow per company.
   *
   * A company that is not theirs is not an error worth a message: it simply
   * matches nothing, and naming one would tell a stranger holding a reset code
   * which companies the address belongs to.
   */
  const wanted = req.body.company_id ?? req.body.companyId ?? null;
  const targets = wanted === null || wanted === '' || String(wanted).toLowerCase() === 'all'
    ? identity
    : identity.filter((row) => Number(row.company_id) === Number(wanted));

  if (!targets.length) {
    return res.status(400).json({ message: 'Choose which company this password is for.' });
  }

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await setAccountPassword(sequelize, targets.map((row) => row.id), hash);
  await user.reload();
  await PasswordReset.destroy({ where: { email: payload.email } });

  /**
   * Every other session ends here.
   *
   * A password reset is what somebody does when they believe an account is in
   * the wrong hands. Leaving the existing refresh tokens valid means the reset
   * changes nothing for the intruder — they hold a token good for seven days
   * and the victim has just been told they are safe. The one thing a recovery
   * flow must do is end the sessions it is recovering from.
   */
  /*
   * The accounts whose password just changed, and only those. A session for a
   * company this reset did not touch is still holding a password that is still
   * correct, and ending it would sign somebody out of a company they never
   * asked about.
   */
  const accountIds = targets.map((row) => row.id);
  const revoked = await RefreshToken.destroy({ where: { user_id: accountIds } });
  await Promise.all(accountIds.map((id) => sessionRegistry.endSession(id).catch(() => {})));
  if (revoked) {
    console.log(`[auth] password reset for ${user.email}: revoked ${revoked} session(s) `
      + `across ${accountIds.length} account(s)`);
  }

  // A password changing is a security event worth keeping, and the person it
  // happened to is the only actor there is — they hold a reset token, not a
  // session, so again the middleware has nobody to attribute it to.
  req.audit?.({
    actor_id: user.id,
    actor_name: user.name || null,
    actor_email: user.email || null,
    actor_type: user.type || null,
    company_id: user.company_id ?? null,
    entity_type: 'user',
    entity_id: String(user.id),
  });

  res.json({ message: 'Password reset successful. You can now sign in.' });
});

const me = asyncHandler(async (req, res) => {
  const user = await User.findByPk(req.user.id);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }
  res.json({ user: await presentUser(user) });
});

const googleCallback = asyncHandler(async (req, res) => {
  let user = req.user;
  if (!user) {
    return res.redirect(`${frontendGoogleCallback}?error=google_auth_failed`);
  }

  /**
   * The strategy found several accounts on this address and had nothing to
   * choose between them — so the choice comes here, where there is a browser to
   * put it to.
   *
   * The company list travels in the URL for the same reason the user object
   * already does: this is a redirect, and there is no response body to put it
   * in. The token beside it is what actually authorises the second step; the
   * list is only what the page draws.
   */
  if (user.multi) {
    const accounts = (await User.findAll({ where: { id: user.accounts, deleted_at: null } }))
      .filter((account) => account.is_active);

    if (!accounts.length) {
      return res.redirect(`${frontendGoogleCallback}?error=account_inactive`);
    }
    if (accounts.length > 1) {
      const choice = await companyChoice(accounts);
      const params = new URLSearchParams({
        company_token: choice.company_token,
        companies: JSON.stringify(choice.companies),
      });
      return res.redirect(`${frontendGoogleCallback}?${params.toString()}`);
    }
    [user] = accounts;
  }

  if (!user.is_active) {
    return res.redirect(`${frontendGoogleCallback}?error=account_inactive`);
  }

  if (await refuseIfSignedInElsewhere(user, res)) return;
  /*
   * Google proved control of the ADDRESS, not one password — which is the
   * stronger claim, and it covers every account on that address. So all of
   * them are proved, and switching between them asks for nothing.
   */
  const proved = (await accountsForEmail(sequelize, user.email)).map((row) => Number(row.id));
  const session = await issueSession(user, null, { req, opened: proved });
  const params = new URLSearchParams({
    token: session.accessToken,
    refreshToken: session.refreshToken,
    user: JSON.stringify(session.user),
  });

  res.redirect(`${frontendGoogleCallback}?${params.toString()}`);
});

// ── Forced 2FA setup during login (for admin-required 2FA) ──────────────────
// Accepts a temp_token (issued at login) so user doesn't need a full session yet.
const forcedSetup2FA = asyncHandler(async (req, res) => {
  const tempToken = req.body.temp_token || req.body.tempToken;
  if (!tempToken) return res.status(400).json({ message: 'Temporary token is required' });

  let payload;
  try {
    const secret = await jwtSecret();
    payload = jwt.verify(tempToken, secret);
  } catch {
    return res.status(401).json({ message: 'Invalid or expired temporary token' });
  }
  if (payload.purpose !== '2fa' || !payload.id) {
    return res.status(401).json({ message: 'Invalid temporary token' });
  }

  const user = await User.findByPk(payload.id);
  if (!user) return res.status(404).json({ message: 'User not found' });

  const secret = speakeasy.generateSecret({
    name: `Realto (${user.email})`,
    issuer: 'Realto',
  });
  user.two_factor_secret = await encryptSecret(secret.base32);
  user.two_factor_enabled = false;
  await user.save();

  const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);
  res.json({ qrCodeUrl, secret: secret.base32 });
});

const forcedVerify2FA = asyncHandler(async (req, res) => {
  const tempToken = req.body.temp_token || req.body.tempToken;
  const totpToken = req.body.totp_token || req.body.token;

  if (!tempToken || !totpToken) {
    return res.status(400).json({ message: 'Temporary token and TOTP token are required' });
  }

  let payload;
  try {
    const secret = await jwtSecret();
    payload = jwt.verify(tempToken, secret);
  } catch {
    return res.status(401).json({ message: 'Invalid or expired temporary token' });
  }
  if (payload.purpose !== '2fa' || !payload.id) {
    return res.status(401).json({ message: 'Invalid temporary token' });
  }

  const user = await User.findByPk(payload.id);
  if (!user || !user.two_factor_secret) {
    return res.status(400).json({ message: 'Two-factor setup not found. Please restart setup.' });
  }

  const totpSecret = await decryptSecret(user.two_factor_secret);
  if (!verifyTotpToken(totpSecret, totpToken)) {
    return res.status(401).json({ message: 'Invalid verification code' });
  }

  user.two_factor_enabled = true;
  await user.save();

  if (await refuseIfSignedInElsewhere(user, res)) return;
  const session = await issueSession(user, null, { req, opened: payload.opened || null });
  res.json(session);
});

// ── Admin 2FA policy ─────────────────────────────────────────────────────────
const set2FAPolicy = asyncHandler(async (req, res) => {
  const { required, company_id } = req.body;

  /**
   * WHO may do this is the route's job now — settings.security.manage.
   *
   * The role check that used to be here is gone, but the company decision
   * below is not the same question and stays. It is the difference between
   * "may you change a 2FA policy" and "WHOSE 2FA policy".
   *
   * ── The branch had to be rewritten to loosen the gate safely ─────────────
   *
   * It used to read "if you are a super_admin, your own company; otherwise
   * global or whichever company you name" — safe only while `otherwise` could
   * mean nothing but a platform admin. With a permission, any role a company
   * grants it to lands in that branch and could set the GLOBAL policy or
   * another tenant's. So it keys on isSuperiorAdmin, which is what the
   * else-branch always meant.
   */
  let targetCompanyId = null;
  if (req.user?.isSuperiorAdmin) {
    // Platform admin: global (null) or a named company.
    targetCompanyId = company_id !== undefined ? (company_id === null ? null : Number(company_id)) : null;
  } else {
    targetCompanyId = req.user?.company_id ?? null;
    if (!targetCompanyId) return res.status(400).json({ message: 'Company not found for admin' });
  }

  const value = required ? 'on' : 'off';
  const { sequelize } = require('../config/database');

  const existing = await sequelize.query(
    targetCompanyId !== null
      ? `SELECT id FROM settings WHERE ${q(sequelize, 'key')} = '2fa_required' AND company_id = :cid LIMIT 1`
      : `SELECT id FROM settings WHERE ${q(sequelize, 'key')} = '2fa_required' AND company_id IS NULL LIMIT 1`,
    { replacements: { cid: targetCompanyId }, type: require('sequelize').QueryTypes.SELECT }
  );

  if (existing.length > 0) {
    await sequelize.query(
      targetCompanyId !== null
        ? `UPDATE settings SET ${q(sequelize, 'value')} = :val WHERE ${q(sequelize, 'key')} = '2fa_required' AND company_id = :cid`
        : `UPDATE settings SET ${q(sequelize, 'value')} = :val WHERE ${q(sequelize, 'key')} = '2fa_required' AND company_id IS NULL`,
      { replacements: { val: value, cid: targetCompanyId }, type: require('sequelize').QueryTypes.UPDATE }
    );
  } else {
    await sequelize.query(
      `INSERT INTO settings (${q(sequelize, 'key')}, ${q(sequelize, 'value')}, ${q(sequelize, 'group')}, company_id)
       VALUES ('2fa_required', :val, 'security', :cid)`,
      { replacements: { val: value, cid: targetCompanyId }, type: require('sequelize').QueryTypes.INSERT }
    );
  }

  res.json({ message: `2FA requirement ${value === 'on' ? 'enabled' : 'disabled'}`, required: value === 'on', company_id: targetCompanyId });
});

// ── Get 2FA policy (for UI display) ─────────────────────────────────────────
const get2FAPolicyEndpoint = asyncHandler(async (req, res) => {
  // Permission checked on the route. What remains here is scope.
  const { sequelize } = require('../config/database');

  /**
   * A company administrator sees the global policy and their OWN override.
   *
   * It used to return every row in the table, so one company's administrator
   * could read whether every other tenant had enforced two-factor — a map of
   * which competitors were least protected, from a screen about their own
   * settings. Only a platform administrator has business with the whole list.
   */
  const superior = Boolean(req.user?.isSuperiorAdmin);
  const companyId = req.user?.company_id ?? null;
  const rows = await sequelize.query(
    `SELECT ${q(sequelize, 'key')}, ${q(sequelize, 'value')}, company_id FROM settings
       WHERE ${q(sequelize, 'key')} = '2fa_required'
       ${superior ? '' : 'AND (company_id IS NULL OR company_id = :companyId)'}`,
    { replacements: { companyId }, type: require('sequelize').QueryTypes.SELECT }
  );
  const global = rows.find((r) => r.company_id === null || r.company_id === undefined);
  const companyRows = rows.filter((r) => r.company_id !== null && r.company_id !== undefined);

  res.json({
    global_required: global?.value === 'on',
    company_overrides: companyRows.map((r) => ({ company_id: r.company_id, required: r.value === 'on' })),
  });
});

module.exports = {
  register,
  login,
  // Shared with the passcode flow, so a passcode sign-in produces exactly the
  // same session shape — roles, permissions, tokens — as a password one.
  sessionKey,
  issueSession,
  refuseIfSignedInElsewhere,
  presentUser,
  verify2FA,
  setup2FA,
  verify2FASetup,
  disable2FA,
  forcedSetup2FA,
  forcedVerify2FA,
  set2FAPolicy,
  get2FAPolicyEndpoint,
  refresh,
  logout,
  forgotPassword,
  verifyResetOtp,
  resetPassword,
  me,
  googleCallback,
  syncUserRoles,
  reloadConfig,
  switchRole,
  enableProfile,
  loginToCompany,
  myCompanies,
  switchCompany,
  joinCompany,
};

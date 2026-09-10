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
const { appUrl } = require('../../../../shared/src/appOrigin');
const { defaultRealtorLevelId } = require('../../../../shared/src/realtorLevel');
const { createDispatcher } = require('../../../../shared/src/notificationDispatcher');
// Recipients come from configuration, not from this call site.
const notify = createDispatcher(require('../config/database').sequelize);
const { sequelize } = require('../config/database');
const { significantDigits, isPlausiblePhone, phoneMatchSql } = require('../../../../shared/src/phone');
const { cache, KEYS, TTL } = require('../../../../shared/src/cache');
const { newSessionId, deriveKey } = require('../../../../shared/src/payloadCrypto');
const sessionRegistry = require('../../../../shared/src/sessionRegistry');
const { evictUserAuthorisation } = require('../../../../shared/src/cacheEvict');

// ── DB-backed config cache (hot-reloads from settings table) ─────────────────
const CONFIG_TTL_MS = 5 * 60 * 1000; // re-read DB every 5 minutes
let _configCache = null;
let _configLoadedAt = 0;

const loadConfigFromDB = async () => {
  try {
    const { sequelize } = require('../config/database');
    const rows = await sequelize.query(
      "SELECT `key`, `value` FROM `settings` WHERE `group` IN ('system', 'email') AND (company_id IS NULL)",
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
      await sequelize.query(
        `INSERT IGNORE INTO user_roles (user_id, role_id)
         SELECT :userId, r.id FROM roles r WHERE r.name = :type`,
        { replacements: { userId, type: user.type }, type: QueryTypes.INSERT }
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
const createAccessToken = async (user, permissions = [], activeRoleId = null, activeRoleName = null, reuseSid = null) => {
  const secret = await getCfg('jwt_secret', process.env.JWT_SECRET || 'super-secret-key');
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
    },
    secret,
    { expiresIn: expiry }
  );
  return { token, sid, payloadKey: deriveKey(sid).toString('hex') };
};

const createTempToken = async (user) => {
  const secret = await getCfg('jwt_secret', process.env.JWT_SECRET || 'super-secret-key');
  return jwt.sign(
    { id: user.id, purpose: '2fa' },
    secret,
    { expiresIn: tempTokenExpiry }
  );
};

const getEncryptionKey = async () => {
  const secret = await getCfg('jwt_secret', process.env.JWT_SECRET || 'super-secret-key');
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

const createRefreshToken = async (user, sid = null) => {
  const token = crypto.randomBytes(48).toString('hex');
  const days = Number(await getCfg('jwt_refresh_days', process.env.JWT_REFRESH_DAYS || 7));
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  await RefreshToken.create({ user_id: user.id, token, expires_at: expiresAt, sid });
  return token;
};

const issueSession = async (user, activeRoleId = null, { sid: reuseSid = null, req = null } = {}) => {
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
    user, permissions, targetRoleId, activeRole?.name || null, reuseSid,
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
    refreshToken: await createRefreshToken(user, access.sid),
    user: {
      ...sanitizeUser(user, permissions),
      // Lets the UI gate on the active profile without decoding the token.
      effectiveType: effectiveTypeFor(user, activeRole?.name || null),
    },
    roles,
    activeRoleId: targetRoleId,
    activeRole,
  };
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
    'SELECT id, status FROM `companies` WHERE referral_code = :code LIMIT 1',
    { replacements: { code: String(company_code).trim().toUpperCase() } }
  );

  if (!companies.length) {
    return res.status(400).json({ message: 'Invalid company code. Please check with your company administrator.' });
  }

  const company = companies[0];
  if (company.status === 'suspended') {
    return res.status(403).json({ message: 'This company account is currently suspended.' });
  }

  const exists = await User.findOne({ where: { email: req.body.email } });
  if (exists) {
    return res.status(409).json({ message: 'Email already exists' });
  }

  const requestedRole = req.body.role || req.body.type || 'client';
  if (!PUBLIC_REGISTRATION_ROLES.includes(requestedRole)) {
    return res.status(403).json({ message: 'Selected role is not available for self-registration' });
  }

  const password = await bcrypt.hash(req.body.password, 10);
  const roleName = requestedRole;
  // A property link shared by a realtor carries their code — map the new client
  // to that realtor. Scoped to the resolved company so a code from another
  // company (or a tampered URL) cannot attach the account elsewhere.
  let realtorId = null;
  let referringRealtor = null;
  const realtorCode = String(req.body.realtor_code || '').trim().toUpperCase();
  if (realtorCode) {
    const [realtor] = await sequelize.query(
      `SELECT id, name FROM users
        WHERE UPPER(realtor_code) = :code AND type = 'realtor'
          AND company_id = :companyId AND deleted_at IS NULL
        LIMIT 1`,
      { replacements: { code: realtorCode, companyId: company.id }, type: QueryTypes.SELECT },
    );
    // An unknown code must not block registration — the account is still valid,
    // it simply is not attributed to a realtor.
    realtorId = realtor?.id ?? null;
    referringRealtor = realtor ?? null;
  }

  // A new realtor starts on the entry level rather than on no level at all.
  const startingLevelId = roleName === 'realtor'
    ? await defaultRealtorLevelId(sequelize, company.id)
    : null;

  const user = await User.create({
    ...req.body,
    password,
    type: roleName,
    company_id: company.id,
    // Clients AND realtors can be referred by a realtor.
    realtor_id: ['client', 'realtor'].includes(roleName) ? realtorId : null,
    realtor_level_id: startingLevelId,
  });
  await syncUserRoles(user.id, [roleName]);

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

  const session = await issueSession(user, null, { req });
  res.status(201).json(session);
});

// ── 2FA policy helpers ───────────────────────────────────────────────────────
const get2FAPolicy = async (companyId) => {
  try {
    const { sequelize } = require('../config/database');
    const rows = await sequelize.query(
      "SELECT `key`, `value`, `company_id` FROM `settings` WHERE `key` = '2fa_required' AND (`company_id` IS NULL OR `company_id` = :companyId)",
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
const findUserByIdentifier = async (identifier) => {
  const value = String(identifier).trim();

  // Email first and exactly: it is unique and indexed, and an address that
  // happens to contain digits must never be treated as a phone number.
  const byEmail = await User.findOne({ where: { email: value } });
  if (byEmail) return { user: byEmail };

  if (!isPlausiblePhone(value)) return { user: null };

  const rows = await sequelize.query(
    `SELECT id FROM users
      WHERE deleted_at IS NULL
        AND ${phoneMatchSql('phone', ':phoneDigits')}
      LIMIT 2`,
    {
      replacements: { phoneDigits: significantDigits(value) },
      type: QueryTypes.SELECT,
    },
  );
  if (rows.length !== 1) {
    if (rows.length > 1) {
      console.warn(`[auth] phone ${significantDigits(value)} matches ${rows.length} accounts — refusing`);
    }
    return { user: null, ambiguous: rows.length > 1 };
  }
  return { user: await User.findByPk(rows[0].id) };
};

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

const login = asyncHandler(async (req, res) => {
  const identifier = req.body.identifier || req.body.email || req.body.phone || '';
  const { password } = req.body;

  if (!identifier) {
    return res.status(400).json({ message: 'Email or phone number is required' });
  }

  const { user, ambiguous } = await findUserByIdentifier(identifier);

  if (ambiguous) {
    return res.status(409).json({
      message: 'That phone number is registered to more than one account. Please sign in with your email address.',
    });
  }
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }
  if (!user.is_active) {
    return res.status(403).json({ message: 'Account is inactive' });
  }

  const roles = await getUserRolesData(user.id);
  const permissions = await getUserPermissions(user.id);
  const tempToken = await createTempToken(user);

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
  const session = await issueSession(user, null, { req });
  res.json(session);
});

const verify2FA = asyncHandler(async (req, res) => {
  const tempToken = req.body.temp_token || req.body.tempToken;
  const totpToken = req.body.totp_token || req.body.token;

  if (!tempToken || !totpToken) {
    return res.status(400).json({ message: 'Temporary token and TOTP token are required' });
  }

  let payload;
  try {
    const secret = await getCfg('jwt_secret', process.env.JWT_SECRET || 'super-secret-key');
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
  const session = await issueSession(user, null, { req });
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

  const session = await issueSession(storedToken.user, roleId, { sid: storedToken.sid || null, req });
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

  await sequelize.query(
    'INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (:userId, :roleId)',
    { replacements: { userId: user.id, roleId: role.id }, type: QueryTypes.INSERT },
  );

  // Someone adding a realtor profile is a new realtor: start them on the entry
  // level too. Never overwrite a level they were already placed on.
  if (profile === 'realtor' && !user.realtor_level_id) {
    const startingLevelId = await defaultRealtorLevelId(sequelize, user.company_id ?? null);
    if (startingLevelId) await user.update({ realtor_level_id: startingLevelId });
  }

  // Reissue against the newly added profile so the caller is switched into it.
  const session = await issueSession(user, role.id, { sid: req.user?.sid || null, req });
  res.status(201).json(session);
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

  const session = await issueSession(user, roleId, { sid: req.user?.sid || null, req });
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
  res.json({ message: 'Logged out successfully' });
});

// ── Email helper (nodemailer with console fallback) ──────────────────────────
/** Hard ceiling on an email attempt, kept below the gateway's 30s proxy timeout. */
const SEND_TIMEOUT_MS = 15000;

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
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
        // nodemailer defaults are 2min connect / 30s greeting / 10min socket —
        // any of which outlives the API gateway's 30s proxy timeout and turns a
        // slow mail server into a 504 for the user.
        connectionTimeout: 8000,
        greetingTimeout: 8000,
        socketTimeout: 12000,
      });

      // Belt and braces: even with the above, a wedged TLS handshake can stall,
      // so cap the whole attempt well inside the gateway's limit.
      await Promise.race([
        transporter.sendMail({ from, to, subject, text, html }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SMTP timed out')), SEND_TIMEOUT_MS)),
      ]);
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

  // Generate a 6-digit numeric OTP
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await PasswordReset.destroy({ where: { email } });
  await PasswordReset.create({ email, token: otp, expires_at: expiresAt });

  const brand = await getBranding(user.company_id ?? null);
  const { subject, text, html } = templates.passwordResetOtp(brand, { otp, expiryMinutes: 10 });
  const sent = await sendEmail({ to: email, subject, text, html });
  if (!sent) console.error(`[auth] Password reset OTP for ${email} was not delivered.`);

  // Same wording as the unknown-email branch: a different message here would
  // let anyone probe which addresses have accounts.
  res.json({ message: 'If an account exists, a 6-digit OTP has been sent to that email.' });
});

const verifyResetOtp = asyncHandler(async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ message: 'Email and OTP are required' });

  const record = await PasswordReset.findOne({ where: { email, token: String(otp) } });
  if (!record || record.expires_at < new Date()) {
    return res.status(400).json({ message: 'Invalid or expired OTP. Please request a new code.' });
  }

  // Issue a short-lived signed reset token (5 minutes)
  const jwtSecret = await getCfg('jwt_secret', process.env.JWT_SECRET || 'super-secret-key');
  const resetToken = jwt.sign({ purpose: 'password_reset', email }, jwtSecret, { expiresIn: '5m' });

  // Keep the PasswordReset record; it gets deleted on successful password reset
  res.json({ reset_token: resetToken });
});

const resetPassword = asyncHandler(async (req, res) => {
  const { reset_token, password } = req.body;
  if (!reset_token || !password) {
    return res.status(400).json({ message: 'Reset token and new password are required' });
  }

  let payload;
  try {
    const jwtSecret = await getCfg('jwt_secret', process.env.JWT_SECRET || 'super-secret-key');
    payload = jwt.verify(reset_token, jwtSecret);
  } catch {
    return res.status(400).json({ message: 'Reset link has expired. Please request a new OTP.' });
  }

  if (payload.purpose !== 'password_reset' || !payload.email) {
    return res.status(400).json({ message: 'Invalid reset token' });
  }

  const user = await User.findOne({ where: { email: payload.email } });
  if (!user) return res.status(404).json({ message: 'User not found' });

  if (password.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters' });
  }

  user.password = await bcrypt.hash(password, 10);
  await user.save();
  await PasswordReset.destroy({ where: { email: payload.email } });

  res.json({ message: 'Password reset successful. You can now sign in.' });
});

const me = asyncHandler(async (req, res) => {
  const user = await User.findByPk(req.user.id);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }
  const permissions = await getUserPermissions(user.id);
  res.json({ user: sanitizeUser(user, permissions) });
});

const googleCallback = asyncHandler(async (req, res) => {
  const user = req.user;
  if (!user) {
    return res.redirect(`${frontendGoogleCallback}?error=google_auth_failed`);
  }
  if (!user.is_active) {
    return res.redirect(`${frontendGoogleCallback}?error=account_inactive`);
  }

  if (await refuseIfSignedInElsewhere(user, res)) return;
  const session = await issueSession(user, null, { req });
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
    const jwtSecret = await getCfg('jwt_secret', process.env.JWT_SECRET || 'super-secret-key');
    payload = jwt.verify(tempToken, jwtSecret);
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
    const jwtSecret = await getCfg('jwt_secret', process.env.JWT_SECRET || 'super-secret-key');
    payload = jwt.verify(tempToken, jwtSecret);
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
  const session = await issueSession(user, null, { req });
  res.json(session);
});

// ── Admin 2FA policy ─────────────────────────────────────────────────────────
const set2FAPolicy = asyncHandler(async (req, res) => {
  const { required, company_id } = req.body;
  const actorType = req.user?.type;

  if (!['super_admin', 'superior_admin'].includes(actorType)) {
    return res.status(403).json({ message: 'Insufficient permissions' });
  }

  // company admins can only set their own company; superior admins can set any or global
  let targetCompanyId = null;
  if (actorType === 'super_admin') {
    targetCompanyId = req.user.company_id ?? null;
    if (!targetCompanyId) return res.status(400).json({ message: 'Company not found for admin' });
  } else {
    // superior_admin: can set global (null) or a specific company
    targetCompanyId = company_id !== undefined ? (company_id === null ? null : Number(company_id)) : null;
  }

  const value = required ? 'on' : 'off';
  const { sequelize } = require('../config/database');

  const existing = await sequelize.query(
    targetCompanyId !== null
      ? "SELECT id FROM settings WHERE `key` = '2fa_required' AND company_id = :cid LIMIT 1"
      : "SELECT id FROM settings WHERE `key` = '2fa_required' AND company_id IS NULL LIMIT 1",
    { replacements: { cid: targetCompanyId }, type: require('sequelize').QueryTypes.SELECT }
  );

  if (existing.length > 0) {
    await sequelize.query(
      targetCompanyId !== null
        ? "UPDATE settings SET `value` = :val WHERE `key` = '2fa_required' AND company_id = :cid"
        : "UPDATE settings SET `value` = :val WHERE `key` = '2fa_required' AND company_id IS NULL",
      { replacements: { val: value, cid: targetCompanyId }, type: require('sequelize').QueryTypes.UPDATE }
    );
  } else {
    await sequelize.query(
      "INSERT INTO settings (`key`, `value`, `group`, company_id) VALUES ('2fa_required', :val, 'security', :cid)",
      { replacements: { val: value, cid: targetCompanyId }, type: require('sequelize').QueryTypes.INSERT }
    );
  }

  res.json({ message: `2FA requirement ${value === 'on' ? 'enabled' : 'disabled'}`, required: value === 'on', company_id: targetCompanyId });
});

// ── Get 2FA policy (for UI display) ─────────────────────────────────────────
const get2FAPolicyEndpoint = asyncHandler(async (req, res) => {
  const actorType = req.user?.type;
  if (!['super_admin', 'superior_admin'].includes(actorType)) {
    return res.status(403).json({ message: 'Insufficient permissions' });
  }

  const { sequelize } = require('../config/database');
  const rows = await sequelize.query(
    "SELECT `key`, `value`, company_id FROM settings WHERE `key` = '2fa_required'",
    { type: require('sequelize').QueryTypes.SELECT }
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
};

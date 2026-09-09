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

const getUserPermissions = async (userId) => {
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
const getUserRolesData = async (userId) => {
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

const createAccessToken = async (user, permissions = [], activeRoleId = null, activeRoleName = null) => {
  const secret = await getCfg('jwt_secret', process.env.JWT_SECRET || 'super-secret-key');
  const expiry = await getCfg('jwt_access_expires', process.env.JWT_ACCESS_EXPIRES || '1h');
  const isSuperiorAdmin = user.type === 'superior_admin';
  return jwt.sign(
    {
      id: user.id,
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

const createRefreshToken = async (user) => {
  const token = crypto.randomBytes(48).toString('hex');
  const days = Number(await getCfg('jwt_refresh_days', process.env.JWT_REFRESH_DAYS || 7));
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  await RefreshToken.create({ user_id: user.id, token, expires_at: expiresAt });
  return token;
};

const issueSession = async (user, activeRoleId = null) => {
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

  // Update last_active_at on every login (fire-and-forget)
  User.update({ last_active_at: new Date() }, { where: { id: user.id } }).catch(() => {});

  return {
    accessToken: await createAccessToken(user, permissions, targetRoleId, activeRole?.name || null),
    refreshToken: await createRefreshToken(user),
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
    notifyUser({
      userId: realtorId,
      title: 'You have a new downline',
      body: `Hi ${referringRealtor.name},\n\n${user.name} just signed up as ${joinedAs} using your referral code (${realtorCode}). They now appear in your referral network.`,
      type: 'realtor_downline_joined',
      data: { downline_id: user.id, downline_name: user.name, downline_type: roleName },
      companyId: company.id,
      actionLabel: 'View my referrals',
      actionUrl: appUrl('realtor/referrals', req),
    }).catch((err) => console.error('[auth] Downline notification failed:', err.message));
  }

  const session = await issueSession(user);
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

const login = asyncHandler(async (req, res) => {
  const { Op } = require('sequelize');
  const identifier = req.body.identifier || req.body.email || req.body.phone || '';
  const { password } = req.body;

  if (!identifier) {
    return res.status(400).json({ message: 'Email or phone number is required' });
  }

  const user = await User.findOne({
    where: { [Op.or]: [{ email: identifier }, { phone: identifier }] },
  });

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

  const session = await issueSession(user);
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

  const session = await issueSession(user);
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
  const session = await issueSession(storedToken.user, roleId);
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
  const session = await issueSession(user, role.id);
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

  const session = await issueSession(user, roleId);
  res.json(session);
});

const logout = asyncHandler(async (req, res) => {
  await RefreshToken.destroy({ where: { token: req.body.refreshToken } });
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

  const session = await issueSession(user);
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

  const session = await issueSession(user);
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

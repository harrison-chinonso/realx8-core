const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { buildCrudController } = require('../utils/crudFactory');
const { User, UserProfile, Role, Permission, Setting, Company, sequelize, RealtorLevel, RealtorKyc } = require('../models');
const { REASONS } = require('../../../../shared/src/realtorStatus');
const {
  evictUserAuthorisation, evictRole, evictAllAuthorisation,
  evictUserMembership, evictSettings,
} = require('../../../../shared/src/cacheEvict');
const { cache, KEYS, TTL } = require('../../../../shared/src/cache');
const { defaultRealtorLevelId } = require('../../../../shared/src/realtorLevel');
const { uploadToCloudinary, invalidateCredsCache } = require('../utils/cloudinaryService');

const REALTOR_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REALTOR_CODE_LENGTH = 5;   // matches the company referral code convention
const generateRealtorCode = async () => {
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < REALTOR_CODE_LENGTH; i++) code += REALTOR_CODE_CHARSET[Math.floor(Math.random() * REALTOR_CODE_CHARSET.length)];
    const exists = await User.findOne({ where: { realtor_code: code } });
    if (!exists) return code;
  }
  throw new Error('Could not generate unique realtor code');
};

const rolePermissionInclude = {
  model: Permission,
  as: 'permissions',
  through: { attributes: [] },
};

const userRoleInclude = {
  model: Role,
  as: 'roles',
  through: { attributes: [] },
  include: [rolePermissionInclude],
};

const userInclude = [{ model: UserProfile, as: 'profile' }, userRoleInclude, { model: Company, as: 'company', attributes: ['id', 'name'] }];

const isSuperiorAdmin = (req) => req.user?.isSuperiorAdmin === true || req.user?.type === 'superior_admin';

const buildCompanyScope = (req) => (
  isSuperiorAdmin(req) ? {} : { company_id: req.user?.company_id ?? null }
);

const getSettingTargetCompanyId = (req, explicitCompanyId) => {
  if (!req.user) return explicitCompanyId ?? null;
  if (isSuperiorAdmin(req)) {
    return explicitCompanyId === undefined ? null : explicitCompanyId;
  }
  return req.user.company_id ?? null;
};

const findScopedUserById = async (req, include) => User.findOne({
  where: {
    id: req.params.id,
    deleted_at: null,
    ...buildCompanyScope(req),
  },
  include,
});

// Safely upsert a setting row, working around MySQL's quirk where composite
// UNIQUE KEY (key, company_id) does NOT prevent duplicate rows when company_id IS NULL
// (MySQL treats NULL != NULL for unique constraint purposes, so upsert always INSERTs
// a new row for globals).  We use findOne + update/create instead.
const writeSetting = async (key, value, group, companyId) => {
  const cid = (companyId !== null && companyId !== undefined) ? Number(companyId) : null;
  const where = cid !== null ? { key, company_id: cid } : { key, company_id: null };

  const existing = await Setting.findOne({ where, order: [['id', 'DESC']] });
  if (existing) {
    await existing.update({ value, group });
    return existing;
  }

  try {
    return await Setting.create({ key, value, group, company_id: cid });
  } catch (err) {
    // On any duplicate-key error: the single-column `key_2` index may still exist in the DB
    // (MySQL renames the `key` index because KEY is a reserved word) causing inserts to fail
    // even when company_id differs.  Try to update the existing row; migration will drop that
    // index on next restart, after which new company rows can coexist with global ones.
    const isDup = err.name === 'SequelizeUniqueConstraintError'
      || err.original?.code === 'ER_DUP_ENTRY'
      || err.parent?.code === 'ER_DUP_ENTRY';

    if (isDup) {
      // Try exact match first (company-specific row)
      let row = await Setting.findOne({ where, order: [['id', 'DESC']] });
      // Fall back to any row with this key (catches the single-column key_2 conflict)
      if (!row) row = await Setting.findOne({ where: { key }, order: [['id', 'DESC']] });
      if (row) {
        await row.update({ value, group, company_id: cid });
        return row;
      }
    }
    throw err;
  }
};

/**
 * Writes a setting and drops the cached copy of its group.
 *
 * A wrapper rather than an eviction at each of writeSetting's four return
 * points: the interesting paths there are the duplicate-key recoveries, and an
 * eviction added to three of the four would be a bug nobody notices until a
 * saved setting appears not to have saved.
 *
 * The eviction runs only on SUCCESS — a write that throws changed nothing, and
 * dropping the key would just cost a re-read.
 */
const safeUpsertSetting = async (key, value, group, companyId) => {
  const row = await writeSetting(key, value, group, companyId);
  await evictSettings(group, companyId ?? null);
  return row;
};

/**
 * A company's effective settings for one group: platform defaults with the
 * company's own values layered on top.
 *
 * Cached, because this is read constantly and written rarely — and because the
 * "effective" view calls it once PER GROUP, so a single settings page load ran
 * five of these queries.
 *
 * It returns only the merged map now. It used to also hand back the raw rows,
 * which no caller ever used; keeping them would have meant either caching
 * Sequelize instances (they do not survive serialisation) or returning them on
 * a miss and not on a hit, which is the kind of shape-varies-by-cache-state
 * bug worth designing out rather than documenting.
 */
const loadSettingsForCompany = async (group, companyId) => {
  const rows = await Setting.findAll({
    where: {
      group,
      [Op.or]: [
        { company_id: null },
        ...(companyId !== null ? [{ company_id: Number(companyId) }] : []),
      ],
    },
    order: [['id', 'ASC']],
  });

  // Deduplicate: last row per key wins within each tier
  const globalMap = {};
  const companyMap = {};

  rows.forEach((row) => {
    const cid = row.company_id;
    if (cid === null || cid === undefined) {
      globalMap[row.key] = row.value;          // later rows overwrite earlier ones (latest wins)
    } else if (companyId !== null && Number(cid) === Number(companyId)) {
      companyMap[row.key] = row.value;
    }
  });

  // Merge: globals first, company-specific overrides on top
  return { ...globalMap, ...companyMap };
};

const getSettingsForCompany = async (group, companyId) => ({
  data: await cache.wrap(
    KEYS.settings(group, companyId),
    TTL.settings,
    () => loadSettingsForCompany(group, companyId),
  ),
});

const base = buildCrudController(User, {
  include: userInclude,
  searchFields: ['name', 'email', 'phone', 'type'],
  defaultWhere: () => ({ deleted_at: null }),
  whereBuilder: (req) => ({
    ...(req.query.type ? { type: req.query.type } : {}),
    ...buildCompanyScope(req),
    // Superior admin may filter by a specific company via ?company_id=
    ...(isSuperiorAdmin(req) && req.query.company_id
      ? { company_id: Number(req.query.company_id) }
      : {}),
  }),
});

const normalizeNames = (value) => {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
};

const resolveRolesByName = async (roleNames, transaction) => {
  if (!roleNames.length) return { rows: [], missing: [] };
  const rows = await Role.findAll({ where: { name: roleNames }, transaction });
  const found = new Set(rows.map((row) => row.name));
  return { rows, missing: roleNames.filter((name) => !found.has(name)) };
};

const resolvePermissionsByName = async (permissionNames, transaction) => {
  if (!permissionNames.length) return { rows: [], missing: [] };
  const rows = await Permission.findAll({ where: { name: permissionNames }, transaction });
  const found = new Set(rows.map((row) => row.name));
  return { rows, missing: permissionNames.filter((name) => !found.has(name)) };
};

const listByType = (type) => asyncHandler(async (req, res) => {
  const users = await User.findAll({
    where: { type, deleted_at: null, ...buildCompanyScope(req) },
    // Level and verification status travel with every user record so realtor
    // lists can show them. Only the KYC *status* is included — the document
    // URLs stay on the verification screen rather than in a broad listing.
    include: [
      ...userInclude,
      { model: RealtorLevel, as: 'realtorLevel', attributes: ['id', 'name', 'position', 'commission_percentage'], required: false },
      { model: RealtorKyc, as: 'kyc', attributes: ['status', 'reviewed_at'], required: false },
    ],
    order: [['id', 'DESC']],
  });
  res.json({ data: users });
});

const getUser = asyncHandler(async (req, res) => {
  const user = await findScopedUserById(req, userInclude);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }
  res.json({ data: user });
});

const createUser = asyncHandler(async (req, res) => {
  const transaction = await sequelize.transaction();

  try {
    const { password, role, roles, ...userData } = req.body;
    const requestedCompanyId = isSuperiorAdmin(req) ? (userData.company_id ?? null) : (req.user.company_id ?? null);

    if (userData.type === 'superior_admin' && !isSuperiorAdmin(req)) {
      await transaction.rollback();
      return res.status(403).json({ message: 'Only platform admins can create superior admins' });
    }

    if (userData.type !== 'superior_admin' && requestedCompanyId == null) {
      await transaction.rollback();
      return res.status(400).json({ message: 'company_id is required for non-superior-admin users' });
    }

    if (userData.type === 'superior_admin') {
      userData.company_id = null;
    } else {
      userData.company_id = requestedCompanyId;
    }

    const hashed = password ? await bcrypt.hash(password, 10) : undefined;
    // Auto-generate realtor_code for realtors
    const realtorCode = userData.type === 'realtor' ? await generateRealtorCode() : undefined;
    // New realtors start on the entry level unless the admin picked one.
    const startingLevelId = userData.type === 'realtor' && !userData.realtor_level_id
      ? await defaultRealtorLevelId(sequelize, userData.company_id ?? null)
      : null;
    const user = await User.create({
      ...userData,
      ...(hashed ? { password: hashed } : {}),
      ...(realtorCode ? { realtor_code: realtorCode } : {}),
      ...(startingLevelId ? { realtor_level_id: startingLevelId } : {}),
    }, { transaction });

    const requestedRoles = normalizeNames(roles || role || userData.type);
    const { rows: resolvedRoles, missing } = await resolveRolesByName(requestedRoles, transaction);

    if (missing.length) {
      await transaction.rollback();
      return res.status(400).json({ message: `Unknown roles: ${missing.join(', ')}` });
    }

    await user.setRoles(resolvedRoles, { transaction });
    await transaction.commit();

    /**
     * A NEW user with a role changes who holds a permission, so the cached
     * recipient lists are now missing them.
     *
     * Without this, a newly created accountant would not be notified of
     * anything for up to the cache TTL — quietly, and only for their first few
     * minutes, which is exactly the kind of bug that gets written off as "it
     * must have been a glitch". Evicted after the commit, for the same reason
     * as updateUser.
     */
    await evictUserMembership(user.id);

    const created = await User.findByPk(user.id, { include: userInclude });
    res.status(201).json({ data: created });
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
});

const updateUser = asyncHandler(async (req, res) => {
  const user = await findScopedUserById(req, [{ model: UserProfile, as: 'profile' }]);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  const { profile = {}, password, role, roles, ...userData } = req.body;
  if (password) {
    userData.password = await bcrypt.hash(password, 10);
  }

  if (!isSuperiorAdmin(req)) {
    delete userData.company_id;
  } else if (userData.type === 'superior_admin') {
    userData.company_id = null;
  } else if (Object.prototype.hasOwnProperty.call(userData, 'company_id') && userData.company_id == null) {
    return res.status(400).json({ message: 'company_id is required for non-superior-admin users' });
  }

  // realtor_id must point at a real realtor in the same company — it drives
  // notifications and inspection scoping, so a bad value misroutes both.
  if (Object.prototype.hasOwnProperty.call(userData, 'realtor_id')) {
    if (userData.realtor_id == null || userData.realtor_id === '') {
      userData.realtor_id = null;
    } else {
      const realtor = await User.findOne({
        where: { id: Number(userData.realtor_id), type: 'realtor' },
      });
      if (!realtor) {
        return res.status(400).json({ message: 'That realtor does not exist.' });
      }
      if (realtor.company_id !== user.company_id) {
        return res.status(400).json({ message: 'The referring realtor must belong to the same company.' });
      }
      // A realtor cannot refer themselves.
      if (realtor.id === user.id) {
        return res.status(400).json({ message: 'A realtor cannot be their own referrer.' });
      }
      userData.realtor_id = realtor.id;
    }
  }

  const transaction = await sequelize.transaction();

  try {
    await user.update(userData, { transaction });
    if (user.profile) {
      await user.profile.update(profile, { transaction });
    } else if (Object.keys(profile).length) {
      await UserProfile.create({ user_id: user.id, ...profile }, { transaction });
    }

    if (role || roles) {
      const roleNames = normalizeNames(roles || role);
      const { rows: resolvedRoles, missing } = await resolveRolesByName(roleNames, transaction);
      if (missing.length) {
        await transaction.rollback();
        return res.status(400).json({ message: `Unknown roles: ${missing.join(', ')}` });
      }
      await user.setRoles(resolvedRoles, { transaction });
    }

    await transaction.commit();

    /**
     * Evicted after the COMMIT, never inside the transaction.
     *
     * Evicting first would let a concurrent request re-populate the cache from
     * the pre-commit state and leave that stale value behind once the commit
     * landed — the write would look applied everywhere except the cache.
     */
    await evictUserMembership(user.id);

    const updated = await User.findByPk(user.id, { include: userInclude });
    res.json({ data: updated });
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
});

const removeUser = asyncHandler(async (req, res) => {
  const user = await findScopedUserById(req);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }
  /**
   * The reason rides along with the save.
   *
   * The model hook appends the transition; only this endpoint knows an
   * administrator removed the account deliberately, rather than the flags
   * merely having moved. FR-ELG-008 lets the forfeiture disposition vary by
   * reason, so the difference has to survive to whoever disputes a forfeiture
   * months later — and passing it here puts it on the row the hook is already
   * writing, rather than in a second one that would be discarded as a no-op.
   */
  await user.update({ deleted_at: new Date(), is_active: false }, {
    statusReason: REASONS.includes(req.body?.reason) ? req.body.reason : 'termination_for_cause',
    statusNote: req.body?.note || null,
    statusActorId: req.user?.id ?? null,
  });

  // Drops them from cached notification recipient lists too.
  await evictUserMembership(user.id);
  res.json({ message: 'User deleted successfully' });
});

const assignRole = asyncHandler(async (req, res) => {
  const user = await findScopedUserById(req);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  const requestedRoles = normalizeNames(req.body.roles || req.body.name);
  if (!requestedRoles.length && !req.body.role_id) {
    return res.status(400).json({ message: 'Role is required' });
  }

  let roles = [];
  if (req.body.role_id) {
    const role = await Role.findByPk(req.body.role_id);
    if (!role) {
      return res.status(404).json({ message: 'Role not found' });
    }
    roles = [role];
  } else {
    const resolved = await resolveRolesByName(requestedRoles);
    if (resolved.missing.length) {
      return res.status(400).json({ message: `Unknown roles: ${resolved.missing.join(', ')}` });
    }
    roles = resolved.rows;
  }

  await user.addRoles(roles);
  await evictUserAuthorisation(user.id);
  const updated = await User.findByPk(user.id, { include: userInclude });
  res.json({ message: 'Role assigned successfully', data: updated.roles });
});

const removeRole = asyncHandler(async (req, res) => {
  const user = await findScopedUserById(req);
  if (!user) return res.status(404).json({ message: 'User not found' });
  const role = await Role.findByPk(req.params.roleId);
  if (!role) return res.status(404).json({ message: 'Role not found' });
  await user.removeRole(role);
  await evictUserAuthorisation(user.id);
  res.json({ message: 'Role removed successfully' });
});

const listRoles = asyncHandler(async (_req, res) => {
  const roles = await Role.findAll({
    include: [
      rolePermissionInclude,
      { model: User, as: 'users', attributes: ['id'], where: { deleted_at: null }, required: false, through: { attributes: [] } },
    ],
    order: [['id', 'ASC']],
  });
  res.json({ data: roles });
});

const getRole = asyncHandler(async (req, res) => {
  const role = await Role.findByPk(req.params.id, {
    include: [
      rolePermissionInclude,
      { model: User, as: 'users', attributes: ['id', 'name', 'email', 'type'], where: { deleted_at: null }, required: false, through: { attributes: [] } },
    ],
  });
  if (!role) {
    return res.status(404).json({ message: 'Role not found' });
  }
  res.json({ data: role });
});

const createRole = asyncHandler(async (req, res) => {
  const [role, created] = await Role.findOrCreate({
    where: { name: req.body.name },
    defaults: {
      name: req.body.name,
      display_name: req.body.display_name,
      description: req.body.description,
      guard_name: req.body.guard_name || 'api',
      company_id: getSettingTargetCompanyId(req, req.body.company_id),
    },
  });

  if (!created) {
    await role.update({
      display_name: req.body.display_name ?? role.display_name,
      description: req.body.description ?? role.description,
      guard_name: req.body.guard_name ?? role.guard_name,
      company_id: isSuperiorAdmin(req) ? (req.body.company_id ?? role.company_id) : role.company_id,
    });
  }

  const fresh = await Role.findByPk(role.id, { include: [rolePermissionInclude] });
  res.status(created ? 201 : 200).json({ data: fresh });
});

const updateRole = asyncHandler(async (req, res) => {
  const role = await Role.findByPk(req.params.id);
  if (!role) {
    return res.status(404).json({ message: 'Role not found' });
  }

  await role.update({
    name: req.body.name ?? role.name,
    display_name: req.body.display_name ?? role.display_name,
    description: req.body.description ?? role.description,
    guard_name: req.body.guard_name ?? role.guard_name,
    company_id: isSuperiorAdmin(req) ? (req.body.company_id ?? role.company_id) : role.company_id,
  });

  const updated = await Role.findByPk(role.id, { include: [rolePermissionInclude] });
  res.json({ data: updated });
});

const deleteRole = asyncHandler(async (req, res) => {
  const role = await Role.findByPk(req.params.id);
  if (!role) {
    return res.status(404).json({ message: 'Role not found' });
  }

  const userCount = await role.countUsers();
  if (userCount > 0) {
    return res.status(400).json({ message: 'Cannot delete a role that is assigned to users' });
  }

  await role.setPermissions([]);
  await role.destroy();
  await evictRole();
  res.json({ message: 'Role deleted successfully' });
});

const syncRolePermissions = asyncHandler(async (req, res) => {
  const role = await Role.findByPk(req.params.id);
  if (!role) {
    return res.status(404).json({ message: 'Role not found' });
  }

  const permissionNames = normalizeNames(req.body.permissions);
  const { rows: permissions, missing } = await resolvePermissionsByName(permissionNames);
  if (missing.length) {
    return res.status(400).json({ message: `Unknown permissions: ${missing.join(', ')}` });
  }

  await role.setPermissions(permissions);
  // The grants behind every holder of this role just changed.
  await evictRole();
  const updated = await Role.findByPk(role.id, { include: [rolePermissionInclude] });
  res.json({ message: 'Role permissions updated successfully', data: updated });
});

const listPermissions = asyncHandler(async (req, res) => {
  const where = req.query.module ? { module: req.query.module } : {};
  const permissions = await Permission.findAll({
    where,
    include: [{ model: Role, as: 'roles', attributes: ['id', 'name', 'display_name'], through: { attributes: [] } }],
    order: [['module', 'ASC'], ['name', 'ASC']],
  });
  res.json({ data: permissions });
});

const createPermission = asyncHandler(async (req, res) => {
  const [permission, created] = await Permission.findOrCreate({
    where: { name: req.body.name },
    defaults: {
      name: req.body.name,
      display_name: req.body.display_name,
      module: req.body.module,
      description: req.body.description,
      guard_name: req.body.guard_name || 'api',
    },
  });

  if (!created) {
    await permission.update({
      display_name: req.body.display_name ?? permission.display_name,
      module: req.body.module ?? permission.module,
      description: req.body.description ?? permission.description,
      guard_name: req.body.guard_name ?? permission.guard_name,
    });
  }

  const fresh = await Permission.findByPk(permission.id, { include: [{ model: Role, as: 'roles', through: { attributes: [] } }] });
  res.status(created ? 201 : 200).json({ data: fresh });
});

const updatePermission = asyncHandler(async (req, res) => {
  const permission = await Permission.findByPk(req.params.id);
  if (!permission) {
    return res.status(404).json({ message: 'Permission not found' });
  }

  await permission.update({
    name: req.body.name ?? permission.name,
    display_name: req.body.display_name ?? permission.display_name,
    module: req.body.module ?? permission.module,
    description: req.body.description ?? permission.description,
    guard_name: req.body.guard_name ?? permission.guard_name,
  });

  const updated = await Permission.findByPk(permission.id, { include: [{ model: Role, as: 'roles', through: { attributes: [] } }] });
  res.json({ data: updated });
});

const deletePermission = asyncHandler(async (req, res) => {
  const permission = await Permission.findByPk(req.params.id);
  if (!permission) {
    return res.status(404).json({ message: 'Permission not found' });
  }

  await permission.setRoles([]);
  await permission.destroy();
  // A permission leaving the catalogue changes role grants and recipient lists.
  await evictAllAuthorisation();
  res.json({ message: 'Permission deleted successfully' });
});

const getUserRoles = asyncHandler(async (req, res) => {
  const user = await findScopedUserById(req, [userRoleInclude]);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  res.json({ data: user.roles });
});

const syncUserRoles = asyncHandler(async (req, res) => {
  const user = await findScopedUserById(req);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  const roleNames = normalizeNames(req.body.roles);
  const { rows: roles, missing } = await resolveRolesByName(roleNames);
  if (missing.length) {
    return res.status(400).json({ message: `Unknown roles: ${missing.join(', ')}` });
  }

  await user.setRoles(roles);
  await evictUserAuthorisation(user.id);
  const updated = await User.findByPk(user.id, { include: [userRoleInclude] });
  res.json({ message: 'User roles updated successfully', data: updated.roles });
});

// Groups that contain secrets — non-superior-admin users must NEVER see global (company_id=null) values
// Groups a company admin may only ever write against their OWN company.
// 'invoicing' is here because payment terms are money: without it an admin with
// no company_id would write a global row and change due dates for every tenant.
const SENSITIVE_GROUPS = ['email', 'payment', 'system', 'invoicing', 'assistant'];

const getSettings = asyncHandler(async (req, res) => {
  const group = req.query.group || null;

  // ── Server-side guard: company admin requesting a sensitive group ──────────
  // Always return company-specific rows only — ignore effective=true entirely.
  // This prevents global SMTP/payment credentials leaking to company users even
  // if the frontend accidentally passes effective=true.
  if (!isSuperiorAdmin(req) && group && SENSITIVE_GROUPS.includes(group)) {
    const userCompanyId = req.user?.company_id ?? null;
    if (!userCompanyId) return res.json({ data: {} }); // no company → no secrets
    const rows = await Setting.findAll({ where: { group, company_id: userCompanyId } });
    const settings = rows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {});
    return res.json({ data: settings, rows });
  }

  const companyId = getSettingTargetCompanyId(req, req.query.company_id);

  // ?effective=true → return global defaults merged with company overrides (company wins)
  if (req.query.effective === 'true' && companyId !== null) {
    const { data } = await getSettingsForCompany(group || 'general', companyId);
    // For effective view, fetch all groups if no group filter
    if (!group) {
      // Non-superior-admin bulk-effective: exclude sensitive groups from the merge
      const safeGroups = isSuperiorAdmin(req)
        ? ['general', 'email', 'payment', 'appearance', 'social']
        : ['general', 'appearance', 'social'];
      const merged = {};
      for (const g of safeGroups) {
        const { data: gData } = await getSettingsForCompany(g, companyId);
        Object.assign(merged, gData);
      }
      return res.json({ data: merged });
    }
    return res.json({ data });
  }

  const where = {
    ...(group ? { group } : {}),
    company_id: companyId,
  };
  const rows = await Setting.findAll({ where });
  const settings = rows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {});
  res.json({ data: settings, rows });
});

const upsertSetting = asyncHandler(async (req, res) => {
  const { key, value, group = 'general' } = req.body;
  const companyId = getSettingTargetCompanyId(req, req.body.company_id);
  const setting = await safeUpsertSetting(key, value, group, companyId);
  res.json({ data: setting });
});

const SYSTEM_CONFIG_KEYS = ['google_client_id', 'google_client_secret', 'google_callback_url', 'jwt_secret', 'jwt_access_expires', 'jwt_refresh_days', 'cloudinary_cloud_name', 'cloudinary_api_key', 'cloudinary_api_secret'];

const getSystemConfig = asyncHandler(async (req, res) => {
  const companyId = isSuperiorAdmin(req) ? null : (req.user?.company_id ?? null);

  if (!isSuperiorAdmin(req) && companyId !== null) {
    // Company admins: only their OWN rows — never expose global secrets
    const rows = await Setting.findAll({ where: { group: 'system', company_id: companyId } });
    const ownData = {};
    rows.forEach((r) => { ownData[r.key] = r.value; });
    const response = {};
    SYSTEM_CONFIG_KEYS.forEach((k) => { response[k] = ownData[k] || ''; });
    return res.json({ data: response });
  }

  // Superior admin: return merged config, mask sensitive fields in the UI
  const { data } = await getSettingsForCompany('system', companyId);
  const response = {};
  Object.entries(data).forEach(([key, value]) => {
    response[key] = ['google_client_secret', 'jwt_secret'].includes(key)
      ? (value ? '••••••••' : '')
      : (value || '');
  });
  res.json({ data: response });
});

const saveSystemConfig = asyncHandler(async (req, res) => {
  const companyId = isSuperiorAdmin(req) ? null : (req.user?.company_id ?? null);
  const updates = req.body;
  await Promise.all(
    Object.entries(updates)
      .filter(([key]) => SYSTEM_CONFIG_KEYS.includes(key))
      .map(([key, value]) => {
        if (!value || value === '••••••••') return Promise.resolve();
        return safeUpsertSetting(key, value, 'system', companyId);
      })
  );
  res.json({ message: 'System config saved' });
  invalidateCredsCache();
});

const bulkUpdateSettings = asyncHandler(async (req, res) => {
  const { settings, group = 'general' } = req.body;
  if (!Array.isArray(settings)) {
    return res.status(400).json({ message: 'settings must be an array of { key, value } objects' });
  }

  // Company admins cannot write to sensitive groups at global scope (company_id=null)
  if (!isSuperiorAdmin(req) && SENSITIVE_GROUPS.includes(group)) {
    const userCompanyId = req.user?.company_id ?? null;
    if (!userCompanyId) return res.status(403).json({ message: 'Forbidden: no company associated with this account.' });
    const upserted = await Promise.all(
      settings.map(({ key, value }) => safeUpsertSetting(key, value, group, userCompanyId))
    );
    return res.json({ data: upserted });
  }

  const upserted = await Promise.all(
    settings.map(({ key, value, company_id: rawCompanyId }) => {
      const companyId = getSettingTargetCompanyId(req, rawCompanyId);
      return safeUpsertSetting(key, value, group, companyId);
    })
  );
  res.json({ data: upserted });
});

const getAppearance = asyncHandler(async (req, res) => {
  const requestedCompanyId = req.user?.company_id ?? req.query.company_id ?? req.query.companyId ?? null;
  const { data } = await getSettingsForCompany('appearance', requestedCompanyId ? Number(requestedCompanyId) : null);
  res.json({ data });
});

// Public endpoint — no auth required — returns only the platform-level name and logo
const getPlatformName = asyncHandler(async (req, res) => {
  const { data } = await getSettingsForCompany('appearance', null);
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    name: data.app_name || null,
    logo: data.app_logo || null,
    primary_color: data.primary_color || null,
  });
});

const uploadLogo = asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

  let logoUrl;
  try {
    const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const result = await uploadToCloudinary(dataUri, {
      folder: 'realto/logos',
      transformation: [{ width: 400, height: 400, crop: 'limit' }],
    }, sequelize, req.user?.company_id ?? null);
    logoUrl = result.url;
  } catch (err) {
    if (!req.file.path) {
      return res.status(500).json({ message: `Cloudinary not configured: ${err.message}` });
    }
    logoUrl = `/uploads/logos/${req.file.filename}`;
  }

  const companyId = getSettingTargetCompanyId(req, req.body.company_id ?? req.query.company_id ?? null);
  const row = await safeUpsertSetting('app_logo', logoUrl, 'appearance', companyId);
  res.json({ data: { url: logoUrl } });
});

module.exports = {
  // Exported so shareLinkController resolves branding through the same
  // global-then-company override rules the authenticated screens use.
  getSettingsForCompany,
  ...base,
  getOne: getUser,
  create: createUser,
  update: updateUser,
  remove: removeUser,
  listEmployees: listByType('employee'),
  listClients: listByType('client'),
  listRealtors: listByType('realtor'),
  assignRole,
  removeRole,
  listRoles,
  getRole,
  createRole,
  updateRole,
  deleteRole,
  syncRolePermissions,
  listPermissions,
  createPermission,
  updatePermission,
  deletePermission,
  getUserRoles,
  syncUserRoles,
  getAppearance,
  getPlatformName,
  uploadLogo,
  getSettings,
  upsertSetting,
  bulkUpdateSettings,
  getSystemConfig,
  saveSystemConfig,
};

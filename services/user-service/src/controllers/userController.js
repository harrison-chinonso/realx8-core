const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { buildCrudController } = require('../utils/crudFactory');
const { User, UserProfile, Role, Permission, Setting, Company, sequelize, RealtorLevel, RealtorKyc } = require('../models');
const { PLATFORM_ONLY_PERMISSIONS, isPlatformOnlyPermission } = require('../migrations/permissionCatalog');
const { REASONS } = require('../../../../shared/src/realtorStatus');
const {
  evictUserAuthorisation, evictRole, evictAllAuthorisation,
  evictUserMembership, evictSettings,
} = require('../../../../shared/src/cacheEvict');
const { cache, KEYS, TTL } = require('../../../../shared/src/cache');
const { defaultRealtorLevelId } = require('../../../../shared/src/realtorLevel');
const { uploadToCloudinary, invalidateCredsCache } = require('../utils/cloudinaryService');
const { BCRYPT_ROUNDS } = require('../../../../shared/src/passwordPolicy');
const { isDuplicateError } = require('../../../../shared/src/dialect');
const {
  emailAvailability, setAccountPassword, normaliseEmail,
} = require('../../../../shared/src/emailIdentity');
const { recordReferral, STATUS: REFERRAL_STATUS } = require('../../../../shared/src/referralRecord');

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

/**
 * The realtor a new or edited account is attributed to.
 *
 * ── Why it is checked rather than trusted ───────────────────────────────────
 *
 * `users.realtor_id` is the answer the whole platform reads to decide who earns
 * on a sale and who is told about an inspection. A value that points at a
 * client, at a deleted row, or at a realtor in another tenant does not fail —
 * it quietly misroutes both, and the first person to notice is a realtor asking
 * where their commission went.
 *
 * ── Only clients and realtors carry one ─────────────────────────────────────
 *
 * The same rule registration applies: an accountant was not introduced by
 * anybody, so an id sent alongside a staff account is dropped rather than
 * stored. See auth-service's register, which this deliberately mirrors.
 *
 * @returns {{ ok: true, id: number|null } | { ok: false, message: string }}
 */
const ATTRIBUTABLE_TYPES = ['client', 'realtor'];

const resolveReferringRealtor = async (value, { companyId, type, selfId = null }) => {
  if (value == null || value === '') return { ok: true, id: null };
  if (type && !ATTRIBUTABLE_TYPES.includes(type)) return { ok: true, id: null };

  const realtor = await User.findOne({
    where: { id: Number(value), type: 'realtor', deleted_at: null },
  });
  if (!realtor) return { ok: false, message: 'That realtor does not exist.' };
  if (realtor.company_id !== companyId) {
    return { ok: false, message: 'The referring realtor must belong to the same company.' };
  }
  // A realtor cannot refer themselves.
  if (selfId != null && realtor.id === selfId) {
    return { ok: false, message: 'A realtor cannot be their own referrer.' };
  }
  return { ok: true, id: realtor.id };
};

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
      return res.status(400).json({ message: 'Choose the company this account belongs to.' });
    }

    if (userData.type === 'superior_admin') {
      userData.company_id = null;
    } else {
      userData.company_id = requestedCompanyId;
    }

    /*
     * Who introduced them, checked before anything is written.
     *
     * The create path used to spread `realtor_id` straight into User.create
     * while update, a few dozen lines down, checked the same field three ways.
     * So the form that SET the attribution was the one that never validated it.
     */
    const referrer = await resolveReferringRealtor(userData.realtor_id, {
      companyId: userData.company_id,
      type: userData.type,
    });
    if (!referrer.ok) {
      await transaction.rollback();
      return res.status(400).json({ message: referrer.message });
    }
    userData.realtor_id = referrer.id;

    /**
     * Whether this address may open an account here at all.
     *
     * An email identifies a PERSON now, not an account — the same realtor sells
     * for two agencies and the same buyer buys from two developers, and each
     * relationship is its own row. So the question is no longer "is this email
     * taken" but "is it taken HERE", plus the rule that only realtors and
     * clients may spread across companies at all. Both live in one place; see
     * shared/src/emailIdentity.js.
     */
    const availability = await emailAvailability(sequelize, {
      email: userData.email,
      companyId: userData.company_id ?? null,
      type: userData.type,
      transaction,
    });
    if (!availability.ok) {
      await transaction.rollback();
      return res.status(409).json({ message: availability.message });
    }

    /*
     * The password set here belongs to THIS account and reaches no further.
     *
     * A second account on an address that already exists elsewhere used to
     * inherit that person's password, because the accounts shared one. They no
     * longer do — each carries its own, and a session may only move to a
     * company whose password it has been shown. So an administrator setting one
     * here is setting the password for their own company's account and nothing
     * else.
     */
    const hashed = password ? await bcrypt.hash(password, BCRYPT_ROUNDS) : undefined;
    // Auto-generate realtor_code for realtors
    const realtorCode = userData.type === 'realtor' ? await generateRealtorCode() : undefined;
    // New realtors start on the entry level unless the admin picked one.
    const startingLevelId = userData.type === 'realtor' && !userData.realtor_level_id
      ? await defaultRealtorLevelId(sequelize, userData.company_id ?? null)
      : null;
    /*
     * The unique index is the last word on "already in this company". The check
     * above asked the same question, but two creates can pass it at the same
     * instant and only one can pass the index — and a race should not be the
     * difference between a clear refusal and a 500.
     */
    let user;
    try {
      user = await User.create({
        ...userData,
        ...(hashed ? { password: hashed } : {}),
        ...(realtorCode ? { realtor_code: realtorCode } : {}),
        ...(startingLevelId ? { realtor_level_id: startingLevelId } : {}),
      }, { transaction });
    } catch (error) {
      if (isDuplicateError(error)) {
        await transaction.rollback();
        return res.status(409).json({
          message: 'An account with this email already exists in this company.',
        });
      }
      throw error;
    }

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

    /*
     * The introduction as a record, not only as a foreign key.
     *
     * An account an administrator keys in on somebody's behalf is the same
     * introduction as one that arrives through a shared link, and a realtor
     * asking what became of the people they brought in should see both. Source
     * 'manual' is what distinguishes it from the 'code' rows registration
     * writes. Never fatal — the module swallows its own failures, and a funnel
     * row is not worth losing a created account over.
     */
    if (referrer.id) {
      await recordReferral(sequelize, {
        referrerId: referrer.id,
        referredUserId: user.id,
        companyId: user.company_id,
        source: 'manual',
        status: REFERRAL_STATUS.REGISTERED,
      });
    }

    const created = await User.findByPk(user.id, { include: userInclude });
    res.status(201).json({
      data: created,
      /*
       * Said out loud, because otherwise an administrator types a password,
       * sees the account appear, and tells the person to sign in with it.
       */
      ...(availability.joins ? {
        notice: 'This person already has an account with another company on the platform. '
          + 'This is a separate account with its own password — the one entered here '
          + 'works for your company only.',
      } : {}),
    });
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

  /**
   * Only the account's owner may change its password.
   *
   * An administrator used to be able to set one for anybody in their company,
   * which was unremarkable while an email address meant one account. It is not
   * unremarkable now: the accounts a person holds across companies share a
   * credential, so setting a password here would set the password that opens
   * their account at a DIFFERENT company. That is a cross-tenant account
   * takeover performed with an ordinary admin feature, and no amount of
   * scoping elsewhere would catch it, because nothing about the request leaves
   * this company.
   *
   * What an administrator does instead is what they could always do for
   * somebody who had forgotten theirs: have them use Forgot Password. This
   * refuses rather than ignoring, because a password field that silently does
   * nothing is worse than one that is not there — it tells the administrator
   * the password is now something it is not.
   */
  if (password) {
    if (Number(req.user?.id) !== Number(user.id)) {
      return res.status(403).json({
        message: 'A password can only be changed by the person it belongs to. '
          + 'Ask them to use "Forgot password" on the sign-in screen.',
      });
    }
  }

  /**
   * A change of address is a change of IDENTITY, so it is checked the same way
   * a new account is.
   *
   * Moving onto an address somebody else already uses would silently merge two
   * people — and, because the accounts on an address share a password, hand
   * this one a credential that was not theirs.
   */
  if (userData.email && normaliseEmail(userData.email) !== normaliseEmail(user.email)) {
    const availability = await emailAvailability(sequelize, {
      email: userData.email,
      companyId: user.company_id ?? null,
      type: userData.type || user.type,
      excludeUserId: user.id,
    });
    if (!availability.ok) return res.status(409).json({ message: availability.message });
    if (availability.joins) {
      return res.status(409).json({
        message: 'That email already belongs to somebody on the platform. An existing '
          + 'account cannot be moved onto it.',
      });
    }
  }

  if (!isSuperiorAdmin(req)) {
    delete userData.company_id;
    /**
     * And `type` is not theirs to set either.
     *
     * This is the field every guard in the platform actually reads.
     * createAccessToken derives isSuperiorAdmin from it at sign-in, and
     * requirePermission, requireRoles and buildCompanyScope all short-circuit
     * on that — so a company administrator writing it onto their own row is a
     * platform takeover one sign-out away, and it reaches every other tenant's
     * data. It also walks straight past the role-level refusals in assignRole
     * and syncUserRoles, which guard the superior_admin ROLE while this guards
     * the thing the code checks.
     *
     * createUser has refused exactly this since it was written, a few dozen
     * lines up. Only update was missing it.
     */
    if (userData.type === 'superior_admin') {
      return res.status(403).json({ message: 'Only platform admins can create superior admins' });
    }
  } else if (userData.type === 'superior_admin') {
    userData.company_id = null;
  } else if (Object.prototype.hasOwnProperty.call(userData, 'company_id') && userData.company_id == null) {
    return res.status(400).json({ message: 'Choose the company this account belongs to.' });
  }

  // realtor_id must point at a real realtor in the same company — it drives
  // notifications and inspection scoping, so a bad value misroutes both.
  if (Object.prototype.hasOwnProperty.call(userData, 'realtor_id')) {
    const referrer = await resolveReferringRealtor(userData.realtor_id, {
      companyId: user.company_id,
      selfId: user.id,
      // Deliberately unfiltered by type: this is the "Assign Realtor" action on
      // an existing account, and clearing the field on a row whose type the
      // caller is not changing would be a silent edit nobody asked for.
    });
    if (!referrer.ok) {
      return res.status(400).json({ message: referrer.message });
    }
    userData.realtor_id = referrer.id;
  }

  const transaction = await sequelize.transaction();

  try {
    await user.update(userData, { transaction });

    /**
     * The password, applied to THIS account alone.
     *
     * It used to be written across every account on the address, because they
     * shared one credential. They no longer do: changing it here changes the
     * password for this company, and the person's accounts elsewhere keep
     * whatever they had. That is the whole of what per-company passwords means,
     * and doing it any other way would silently collapse them back into one.
     *
     * Inside the transaction, so a failure further down does not leave a
     * password changed on an update that did not happen.
     */
    if (password) {
      await setAccountPassword(
        sequelize,
        user.id,
        await bcrypt.hash(password, BCRYPT_ROUNDS),
        { transaction },
      );
    }

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

/**
 * Roles a company administrator may hand out.
 *
 * ── The hole this closes ───────────────────────────────────────────────────
 *
 * assignRole and syncUserRoles looked a role up by id or name with no scope at
 * all, so a company administrator could assign `superior_admin` — to one of
 * their own users, or to themselves — and that role holds '*'. Every
 * companies permission, every other company's data, the lot. Refusing to
 * grant companies.* onto a custom role while leaving this open would have been
 * pointless: the shorter route was to take the role that already had them.
 *
 * A role is refused if it is the platform role itself, or if it holds any
 * permission only the platform may hold. Derived from the permissions rather
 * than from a hardcoded name, so a platform admin who invents a second
 * platform-level role is covered without anybody remembering to add it here.
 */
const platformRoleNames = async () => {
  const rows = await Role.findAll({
    include: [{
      model: Permission,
      as: 'permissions',
      attributes: ['name'],
      where: { name: PLATFORM_ONLY_PERMISSIONS },
      through: { attributes: [] },
    }],
    attributes: ['name'],
  }).catch(() => []);
  return new Set([...rows.map((row) => row.name), 'superior_admin']);
};

/** Refuses and replies, or returns false when there is nothing to refuse. */
const refusePlatformRoles = async (req, res, roles) => {
  if (isSuperiorAdmin(req)) return false;
  const platform = await platformRoleNames();
  const blocked = roles.filter((role) => platform.has(role.name));
  if (!blocked.length) return false;
  res.status(403).json({
    message: `${blocked.map((r) => r.display_name || r.name).join(', ')} `
      + `${blocked.length === 1 ? 'is a platform role' : 'are platform roles'} and cannot be assigned by a company.`,
  });
  return true;
};

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

  if (await refusePlatformRoles(req, res, roles)) return undefined;

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

const listRoles = asyncHandler(async (req, res) => {
  /*
   * A company never sees the platform's roles.
   *
   * This is the list both the Roles screen and the user forms draw from, so
   * leaving superior_admin in it offered a company administrator a role they
   * cannot assign — and, before the guard above, one they could. Also served
   * unauthenticated for the sign-up form, where a caller has no business
   * knowing the platform's role structure at all.
   */
  const hidden = req.user && isSuperiorAdmin(req) ? new Set() : await platformRoleNames();

  const roles = await Role.findAll({
    include: [
      rolePermissionInclude,
      { model: User, as: 'users', attributes: ['id'], where: { deleted_at: null }, required: false, through: { attributes: [] } },
    ],
    order: [['id', 'ASC']],
  });
  res.json({ data: roles.filter((role) => !hidden.has(role.name)) });
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

  /**
   * The platform's own permissions cannot be granted by anybody else.
   *
   * Hiding them from listPermissions stops the SCREEN offering them; this
   * stops the API being asked directly, which is the only one of the two that
   * is a boundary. Refused by name so the message says which, rather than
   * silently dropping them and reporting a save that did not save what was
   * sent.
   */
  if (!isSuperiorAdmin(req)) {
    const refused = permissionNames.filter(isPlatformOnlyPermission);
    if (refused.length) {
      return res.status(403).json({
        message: `${refused.join(', ')} ${refused.length === 1 ? 'is' : 'are'} managed by the platform `
          + 'and cannot be granted to a company role.',
      });
    }
  }

  const { rows: permissions, missing } = await resolvePermissionsByName(permissionNames);
  if (missing.length) {
    return res.status(400).json({ message: `Unknown permissions: ${missing.join(', ')}` });
  }

  /*
   * A role that ALREADY holds one keeps it through an edit by a company
   * admin. Only the platform granted it, and a company administrator saving an
   * unrelated checkbox should not silently strip a grant they could not see in
   * the list they were shown.
   */
  const preserved = isSuperiorAdmin(req)
    ? []
    : (await role.getPermissions()).filter((p) => isPlatformOnlyPermission(p.name));

  await role.setPermissions([...permissions, ...preserved]);
  // The grants behind every holder of this role just changed.
  await evictRole();
  const updated = await Role.findByPk(role.id, { include: [rolePermissionInclude] });
  res.json({ message: 'Role permissions updated successfully', data: updated });
});

const listPermissions = asyncHandler(async (req, res) => {
  const where = req.query.module ? { module: req.query.module } : {};

  /**
   * A company never sees the platform's own permissions.
   *
   * This is what the Roles screen draws its checkboxes from, so returning
   * companies.* put "Manage Companies" in front of every company
   * administrator — a box they could tick, save, and hand to somebody, for an
   * endpoint that would refuse them anyway. The permission was never usable;
   * it was only ever offerable, which is worse, because a capability that
   * appears to exist and then fails reads as a broken platform rather than a
   * boundary.
   *
   * Hiding is not the enforcement — syncRolePermissions below refuses them
   * outright. This is so the screen cannot offer what the API will not grant.
   */
  if (!isSuperiorAdmin(req)) {
    where.name = { [Op.notIn]: PLATFORM_ONLY_PERMISSIONS };
  }

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

  if (await refusePlatformRoles(req, res, roles)) return undefined;

  /*
   * setRoles REPLACES, so a platform role the user already holds would be
   * stripped by a company admin saving an unrelated change. Only the platform
   * granted it; only the platform takes it away.
   */
  const existing = await user.getRoles();
  const platform = isSuperiorAdmin(req) ? new Set() : await platformRoleNames();
  const keep = existing.filter((role) => platform.has(role.name));

  await user.setRoles([...roles, ...keep]);
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
  /*
   * A platform admin can read a named company's credentials, not only the
   * platform's own. This was hardwired to null for them, which made System
   * Configuration the one settings group they could not administer on a
   * tenant's behalf — every other group already honours ?company_id through
   * getSettingTargetCompanyId, and a company admin is still pinned to their own
   * company by that same helper.
   */
  const companyId = getSettingTargetCompanyId(req, req.query.company_id);

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
  // Same target as the read above, so what was shown is what gets written.
  const companyId = getSettingTargetCompanyId(req, req.body.company_id);
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

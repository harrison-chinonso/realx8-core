const asyncHandler = require('../utils/asyncHandler');
const { buildCompanyScope } = require('../utils/crudFactory');
const { RealtorLevel, RealtorLevelRequest, User, sequelize } = require('../models');
const { appUrl } = require('../../../../shared/src/appOrigin');

const { createDispatcher } = require('../../../../shared/src/notificationDispatcher');
const notify = createDispatcher(sequelize);

/**
 * Levels are a GLOBAL ladder (company_id IS NULL) shared by every company, plus
 * company-specific levels that only that company can see or use.
 *
 * Visibility:
 *   superior admin  → global levels (company levels belong to their company)
 *   company user    → global + their own company's levels
 *   no company      → global only
 */
const { Op } = require('sequelize');
const { raiseRealtorCharge, levelUpFeeMinor } = require('../utils/realtorChargeGateway');

const visibleLevelsWhere = (req) => {
  if (req.user?.isSuperiorAdmin) {
    // A superior admin may inspect one company's ladder with ?company_id=
    const requested = req.query?.company_id ? Number(req.query.company_id) : null;
    return requested
      ? { [Op.or]: [{ company_id: null }, { company_id: requested }] }
      : { company_id: null };
  }
  const companyId = req.user?.company_id ?? null;
  return companyId
    ? { [Op.or]: [{ company_id: null }, { company_id: companyId }] }
    : { company_id: null };
};

/**
 * The company a caller's NEW levels belong to, and the only levels they may
 * edit, delete or reorder. Superior admins own the global ladder (null);
 * company admins own their company's levels.
 */
const ownedCompanyId = (req) => (req.user?.isSuperiorAdmin ? null : (req.user?.company_id ?? undefined));

/** WHERE clause matching only levels the caller may modify. */
const ownedLevelsWhere = (req) => {
  const owned = ownedCompanyId(req);
  if (owned === undefined) return null;   // no company and not superior — owns nothing
  return { company_id: owned };
};

/** Commission rate is a percentage: 0–100, two decimals. */
const clampPercent = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(Math.min(n, 100) * 100) / 100;
};

const NOT_YOURS = {
  message: 'That level belongs to another owner. Company admins manage their own levels; the global ladder is managed by a platform administrator.',
};

const NO_COMPANY = {
  message: 'Your account is not linked to a company, so you cannot manage company levels.',
};

const companyScope = (req) => buildCompanyScope(req);
const effectiveType = (req) => req.user?.effectiveType || req.user?.type;
const isRealtor = (req) => effectiveType(req) === 'realtor';

/** Level administration is staff-only. */
const canManage = (req) => req.user?.isSuperiorAdmin === true
  || ['admin', 'super_admin'].includes(effectiveType(req));

const requireManage = (req, res) => {
  if (canManage(req)) return true;
  res.status(403).json({ message: 'Only an administrator can manage realtor levels.' });
  return false;
};

/**
 * Upgrade requests and realtor placement belong to the company the realtor is
 * in — a platform administrator has no company and no business acting on
 * another tenant's realtors. Superior admins manage the global ladder only.
 */
const isCompanyAdmin = (req) => !req.user?.isSuperiorAdmin
  && !!req.user?.company_id
  && ['admin', 'super_admin'].includes(effectiveType(req));

const requireCompanyAdmin = (req, res) => {
  if (isCompanyAdmin(req)) return true;
  res.status(403).json({
    message: req.user?.isSuperiorAdmin
      ? 'Upgrade requests and realtor placement are handled by the company administrator.'
      : 'Only a company administrator can do this.',
  });
  return false;
};

// ── Levels ────────────────────────────────────────────────────────────────────

const listLevels = asyncHandler(async (req, res) => {
  const levels = await RealtorLevel.findAll({
    where: visibleLevelsWhere(req),
    order: [['position', 'ASC'], ['id', 'ASC']],
  });
  res.json({ data: levels });
});

/**
 * A fee as whole kobo, never negative and never NaN.
 *
 * A blank field arrives as '' and must mean free rather than NaN, which would
 * reach the column and be rejected by the database with an error naming a
 * column the admin has never heard of.
 */
const feeMinorFrom = (value) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const createLevel = asyncHandler(async (req, res) => {
  if (!requireManage(req, res)) return;

  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ message: 'A level name is required.' });

  const owner = ownedCompanyId(req);
  if (owner === undefined) return res.status(400).json(NO_COMPANY);

  // Names must be unique across what this caller can see, so a company cannot
  // shadow a global level with one of the same name.
  const duplicate = await RealtorLevel.findOne({ where: { ...visibleLevelsWhere(req), name } });
  if (duplicate) return res.status(409).json({ message: `A "${name}" level already exists.` });

  // New levels land at the top of the visible ladder unless a position is given.
  const last = await RealtorLevel.findOne({ where: visibleLevelsWhere(req), order: [['position', 'DESC']] });
  const level = await RealtorLevel.create({
    name,
    description: req.body.description || null,
    commission_percentage: clampPercent(req.body.commission_percentage),
    levelup_fee_minor: feeMinorFrom(req.body.levelup_fee_minor),
    position: Number(req.body.position) || (Number(last?.position) || 0) + 10,
    created_by: req.user?.id ?? null,
    company_id: owner,
  });
  res.status(201).json({ data: level });
});

const updateLevel = asyncHandler(async (req, res) => {
  if (!requireManage(req, res)) return;
  const owned = ownedLevelsWhere(req);
  if (!owned) return res.status(400).json(NO_COMPANY);
  // Must be visible AND owned — otherwise a company admin could edit a global level.
  const level = await RealtorLevel.findOne({ where: { id: req.params.id, ...visibleLevelsWhere(req) } });
  if (!level) return res.status(404).json({ message: 'Level not found' });
  if ((level.company_id ?? null) !== (owned.company_id ?? null)) return res.status(403).json(NOT_YOURS);

  const patch = {};
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ message: 'A level name is required.' });
    patch.name = name;
  }
  if (req.body.description !== undefined) patch.description = req.body.description || null;
  if (req.body.is_active !== undefined) patch.is_active = !!req.body.is_active;
  if (req.body.commission_percentage !== undefined) {
    patch.commission_percentage = clampPercent(req.body.commission_percentage);
  }
  if (req.body.levelup_fee_minor !== undefined) {
    patch.levelup_fee_minor = feeMinorFrom(req.body.levelup_fee_minor);
  }

  await level.update(patch);
  res.json({ data: level });
});

const deleteLevel = asyncHandler(async (req, res) => {
  if (!requireManage(req, res)) return;
  const owned = ownedLevelsWhere(req);
  if (!owned) return res.status(400).json(NO_COMPANY);
  // Must be visible AND owned — otherwise a company admin could edit a global level.
  const level = await RealtorLevel.findOne({ where: { id: req.params.id, ...visibleLevelsWhere(req) } });
  if (!level) return res.status(404).json({ message: 'Level not found' });
  if ((level.company_id ?? null) !== (owned.company_id ?? null)) return res.status(403).json(NOT_YOURS);

  // Refuse rather than silently orphaning realtors sitting on this level.
  const inUse = await User.count({ where: { realtor_level_id: level.id } });
  if (inUse > 0) {
    return res.status(409).json({
      message: `${inUse} realtor${inUse === 1 ? ' is' : 's are'} on this level. Move them first, or deactivate the level instead.`,
    });
  }

  await level.destroy();
  res.json({ message: 'Level deleted' });
});

/** Reorders the ladder. Body: { ids: [...] } — lowest rank first. */
const reorderLevels = asyncHandler(async (req, res) => {
  if (!requireManage(req, res)) return;

  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ message: 'Provide the level ids in their new order.' });

  const ownedWhere = ownedLevelsWhere(req);
  if (!ownedWhere) return res.status(400).json(NO_COMPANY);
  const levels = await RealtorLevel.findAll({ where: ownedWhere });
  const ownedIds = new Set(levels.map((l) => l.id));
  // Only the caller's own levels may be reordered, and the list must be
  // complete — a partial one would leave the rest with stale positions.
  if (ids.length !== levels.length || ids.some((id) => !ownedIds.has(id))) {
    return res.status(400).json({
      message: 'The order must list every level you manage, exactly once.',
    });
  }

  const transaction = await sequelize.transaction();
  try {
    // Company levels are numbered ABOVE the global ladder. Renumbering them
    // from 1 would collide with the global positions and interleave the two
    // ladders unpredictably. Spaced by 10 so a level can be slotted between.
    let base = 0;
    if (ownedWhere.company_id) {
      const [top] = await sequelize.query(
        'SELECT COALESCE(MAX(position), 0) AS top FROM realtor_levels WHERE company_id IS NULL',
        { type: sequelize.constructor.QueryTypes.SELECT, transaction },
      );
      base = Number(top?.top) || 0;
    }
    for (let i = 0; i < ids.length; i += 1) {
      await RealtorLevel.update({ position: base + (i + 1) * 10 }, { where: { id: ids[i] }, transaction });
    }
    await transaction.commit();
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }

  const ordered = await RealtorLevel.findAll({ where: visibleLevelsWhere(req), order: [['position', 'ASC'], ['id', 'ASC']] });
  res.json({ data: ordered });
});

/** Admin assigns a realtor to a level directly. */
const assignLevel = asyncHandler(async (req, res) => {
  if (!requireCompanyAdmin(req, res)) return;

  const realtor = await User.findOne({ where: { id: req.params.userId, type: 'realtor', ...companyScope(req) } });
  if (!realtor) return res.status(404).json({ message: 'Realtor not found' });

  let level = null;
  if (req.body.level_id) {
    // A realtor may be placed on a global level or one of their own company's.
    level = await RealtorLevel.findOne({
      where: { id: req.body.level_id, [Op.or]: [{ company_id: null }, { company_id: realtor.company_id ?? null }] },
    });
    if (!level) return res.status(400).json({ message: 'That level does not exist.' });
  }

  await realtor.update({ realtor_level_id: level?.id ?? null });

  if (level) {
    notify.dispatch({
      eventKey: 'realtor_level_changed',
      subjectUserId: realtor.id,
      companyId: realtor.company_id ?? null,
      context: { level },
      title: () => `Realtor level changed — ${level.name}`,
      body: (role, ctx) => (role === 'subject'
        ? `An administrator placed you on the ${level.name} realtor level.`
        : `${ctx.subject?.name || 'A realtor'} was placed on the ${level.name} level.`),
      data: { level_id: level.id, level_name: level.name },
      actionLabel: 'Go to your dashboard',
      actionUrl: appUrl('dashboard', req),
    }).catch(() => {});
  }

  res.json({ data: { user_id: realtor.id, realtor_level_id: realtor.realtor_level_id, level } });
});

// ── Upgrade requests ──────────────────────────────────────────────────────────

const listRequests = asyncHandler(async (req, res) => {
  // Requests are company data. companyScope returns {} for anyone without a
  // company_id — superior admin or otherwise — which as a WHERE clause means
  // EVERY tenant's requests. Fail closed unless the caller is scoped.
  const companyId = req.user?.company_id ?? null;
  if (!companyId) return res.json({ data: [] });

  const where = { company_id: companyId };
  // A realtor only ever sees their own requests.
  if (isRealtor(req)) where.user_id = req.user.id;
  if (req.query.status) where.status = String(req.query.status);

  const requests = await RealtorLevelRequest.findAll({
    where,
    include: [{ model: User, as: 'realtor', attributes: ['id', 'name', 'email', 'realtor_code'] }],
    order: [['id', 'DESC']],
  });
  res.json({ data: requests });
});

const createRequest = asyncHandler(async (req, res) => {
  if (!isRealtor(req)) {
    return res.status(403).json({ message: 'Only realtors can request a level upgrade.' });
  }

  const realtor = await User.findByPk(req.user.id);
  if (!realtor) return res.status(404).json({ message: 'Realtor not found' });

  const pending = await RealtorLevelRequest.findOne({ where: { user_id: realtor.id, status: 'pending' } });
  if (pending) {
    return res.status(409).json({ message: 'You already have an upgrade request awaiting review.' });
  }

  // Global levels plus any their own company defined.
  const target = await RealtorLevel.findOne({
    where: {
      id: req.body.level_id,
      is_active: true,
      [Op.or]: [{ company_id: null }, { company_id: realtor.company_id ?? null }],
    },
  });
  if (!target) return res.status(400).json({ message: 'That level is not available.' });

  const current = realtor.realtor_level_id
    ? await RealtorLevel.findOne({ where: { id: realtor.realtor_level_id } })
    : null;

  if (current && target.id === current.id) {
    return res.status(400).json({ message: `You are already on the ${current.name} level.` });
  }
  // Position is the rank, so a lower target is a downgrade.
  if (current && target.position < current.position) {
    return res.status(400).json({ message: `${target.name} is below your current ${current.name} level.` });
  }

  const request = await RealtorLevelRequest.create({
    user_id: realtor.id,
    current_level_id: current?.id ?? null,
    current_level_name: current?.name ?? null,
    requested_level_id: target.id,
    requested_level_name: target.name,
    reason: req.body.reason || null,
    status: 'pending',
    company_id: realtor.company_id ?? null,
  });

  /*
   * The fee for THIS level, if it carries one.
   *
   * Priced on the level rather than company-wide, so the amount comes from the
   * target rather than a setting. Best-effort for the same reason the
   * verification fee is: this request is not written in a transaction, and a
   * request with no bill is a lesser failure than a 500 after the request was
   * saved.
   */
  let charge = null;
  try {
    charge = await raiseRealtorCharge({
      realtorId: realtor.id,
      companyId: realtor.company_id ?? null,
      amountMinor: await levelUpFeeMinor(target.id),
      sourceType: 'realtor_levelup',
      sourceId: request.id,
      reason: `Level-up fee — ${target.name}`,
    });
  } catch (chargeError) {
    console.error(`[realtor-levels] could not raise the level-up fee: ${chargeError.message}`);
  }

  /**
   * Was silent — a realtor could ask to move up and the request sat in the
   * queue with nobody told, so it was found only by an admin who happened to
   * look. Reaches whoever holds users.manage by default.
   */
  notify.dispatch({
    eventKey: 'realtor_level_request_submitted',
    subjectUserId: request.user_id,
    companyId: request.company_id ?? null,
    context: { request },
    title: () => `Level upgrade requested — ${request.requested_level_name}`,
    body: (role, ctx) => (role === 'subject'
      ? `Your request to move to the ${request.requested_level_name} level has been submitted `
        + 'and is awaiting review.'
      : `${ctx.subject?.name || 'A realtor'} has requested a move to the `
        + `${request.requested_level_name} level.`
        + `${request.reason ? ` Reason given: ${request.reason}` : ''}`),
    data: { request_id: request.id, level_id: request.requested_level_id },
    actionLabel: 'Review requests',
    actionUrl: appUrl('realtor-levels/requests', req),
  }).catch(() => {});

  // The note rides back so the realtor is told what they owe on the screen
  // that just took the request.
  res.status(201).json({ data: request, charge });
});

const reviewRequest = (status) => asyncHandler(async (req, res) => {
  if (!requireCompanyAdmin(req, res)) return;

  const request = await RealtorLevelRequest.findOne({
    where: { id: req.params.id, company_id: req.user?.company_id ?? null },
  });
  if (!request) return res.status(404).json({ message: 'Request not found' });
  if (request.status !== 'pending') {
    return res.status(409).json({ message: `This request has already been ${request.status}.` });
  }

  const notes = String(req.body.notes ?? '').trim();
  if (status === 'rejected' && !notes) {
    return res.status(400).json({ message: 'A reason is required when declining an upgrade request.' });
  }

  const transaction = await sequelize.transaction();
  try {
    await request.update({
      status,
      review_notes: notes || null,
      reviewed_by: req.user?.id ?? null,
      reviewed_at: new Date(),
    }, { transaction });

    if (status === 'approved') {
      await User.update(
        { realtor_level_id: request.requested_level_id },
        { where: { id: request.user_id }, transaction },
      );
    }
    await transaction.commit();
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }

  // Was a direct message to the requesting realtor and nobody else, with the
  // recipient fixed in code. Now configured, so a company can also copy whoever
  // tracks realtor progression.
  notify.dispatch({
    eventKey: status === 'approved' ? 'realtor_level_request_approved' : 'realtor_level_request_rejected',
    subjectUserId: request.user_id,
    companyId: request.company_id ?? null,
    context: { request },
    title: () => (status === 'approved'
      ? `Upgrade approved — ${request.requested_level_name}`
      : 'Upgrade request declined'),
    body: (role, ctx) => {
      const who = ctx.subject?.name || 'A realtor';
      if (role !== 'subject') {
        return `${who}'s request to move to the ${request.requested_level_name} level was `
          + `${status === 'approved' ? 'approved' : 'declined'}.${notes ? ` Note: ${notes}` : ''}`;
      }
      return status === 'approved'
        ? `Your request to move to the ${request.requested_level_name} level was approved.`
          + `${notes ? ` Note: ${notes}` : ''}`
        : `Your request to move to the ${request.requested_level_name} level was declined. Reason: ${notes}`;
    },
    data: { request_id: request.id, level_id: request.requested_level_id },
    actionLabel: 'Go to your dashboard',
    actionUrl: appUrl('dashboard', req),
  }).catch(() => {});

  res.json({ data: request });
});

module.exports = {
  listLevels,
  createLevel,
  updateLevel,
  deleteLevel,
  reorderLevels,
  assignLevel,
  listRequests,
  createRequest,
  approveRequest: reviewRequest('approved'),
  rejectRequest: reviewRequest('rejected'),
};

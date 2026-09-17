const asyncHandler = require('../utils/asyncHandler');
const { buildCompanyScope } = require('../utils/crudFactory');
const { RealtorLevel, RealtorLevelRequest, User, sequelize } = require('../models');
const { appUrl } = require('../../../../shared/src/appOrigin');

const { createDispatcher } = require('../../../../shared/src/notificationDispatcher');
const notify = createDispatcher(sequelize);

/**
 * ONE ladder at a time — the platform's, or the company's own.
 *
 * The platform ships Basic, Professional, Premium and Ambassador, owned by
 * nobody and free to climb. A company climbs those until it changes something;
 * the first save gives it a copy of its own and it stops sharing.
 *
 * This used to return the UNION of the two, which is why a company admin could
 * see the four shipped rungs and edit none of them: they belonged to the
 * platform, so every control was disabled and the page read as though the
 * levels had been taken away. They had not — there was simply no way to make
 * them yours.
 *
 *   superior admin  → the platform ladder (and one company's, on request)
 *   company user    → their own if they have one, the platform's otherwise
 *   no company      → the platform's
 *
 * The rule itself lives in shared/src/realtorLevel.js, because signup and the
 * commission engine have to agree with this page about which rungs are real.
 */
const { raiseRealtorCharge, levelUpFeeMinor } = require('../utils/realtorChargeGateway');
const { ladderOwnerFor } = require('../../../../shared/src/realtorLevel');
const { remapLevelIds } = require('../../../../shared/src/realtorLevelRemap');

const visibleLevelsWhere = async (req) => {
  if (req.user?.isSuperiorAdmin) {
    // A superior admin may inspect one company's ladder with ?company_id=.
    // Shown as that company sees it: their own rungs if they have made any,
    // otherwise the platform's — the same answer the company's admin gets.
    const requested = req.query?.company_id ? Number(req.query.company_id) : null;
    if (!requested) return { company_id: null };
    return { company_id: await ladderOwnerFor(sequelize, requested) };
  }
  return { company_id: await ladderOwnerFor(sequelize, req.user?.company_id ?? null) };
};

/**
 * The company a caller's NEW levels belong to, and the only levels they may
 * edit, delete or reorder. Superior admins own the global ladder (null);
 * company admins own their company's levels.
 */
const ownedCompanyId = (req) => (req.user?.isSuperiorAdmin ? null : (req.user?.company_id ?? undefined));

/** Commission rate is a percentage: 0–100, two decimals. */
const clampPercent = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(Math.min(n, 100) * 100) / 100;
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
  const where = await visibleLevelsWhere(req);
  const levels = await RealtorLevel.findAll({
    where,
    order: [['position', 'ASC'], ['id', 'ASC']],
  });
  /*
   * `editable` answers the only question the page has, and it is not "are
   * these yours".
   *
   * A company admin looking at the platform ladder does not own a single rung
   * on screen and may nonetheless change all of them — that IS how a company
   * comes to have a ladder. Answering with ownership is what produced four
   * rungs with every control switched off, reading as though the levels had
   * been deleted. The one genuinely read-only case is a platform admin
   * inspecting a company's own ladder, which belongs to that company.
   */
  const owner = ownedCompanyId(req);
  const rungOwner = where.company_id ?? null;
  res.json({
    data: levels,
    editable: canManage(req) && owner !== undefined
      && (rungOwner === (owner ?? null) || rungOwner === null),
    source: rungOwner === null ? 'platform' : 'company',
  });
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

/**
 * Save the whole ladder in one go.
 *
 * ── Why the whole thing, and not a row at a time ───────────────────────────
 *
 * A ladder is an ordered list, and every interesting change to one touches
 * more than a single rung: adding a level renumbers the ones above it,
 * removing a level moves the realtors on it, and reordering is by definition
 * about several at once. The old shape — create, update, delete and reorder as
 * four separate calls — made an admin's single intention into four requests,
 * any of which could fail on its own and leave the ladder in a state nobody
 * asked for. Sent whole, it either becomes what is on the screen or stays
 * exactly as it was.
 *
 * It also makes the rung numbering trivial: position is the array index, so
 * "third from the bottom" is third from the bottom and not the result of
 * arithmetic against somebody else's rungs.
 *
 * ── Editing the platform's ladder makes it yours ───────────────────────────
 *
 * A company saving for the first time is saving rungs it does not own. Rather
 * than refusing — which is what happened before, and is why the shipped levels
 * looked like they had been removed — the rungs it kept are COPIED into the
 * company, and everything that named the old ids is repointed at the copies:
 * realtors, pending upgrade requests, commission rules and the per-level rates
 * inside commission plans. See shared/src/realtorLevelRemap.js for why that
 * last one matters more than it looks.
 *
 * From then on that company is on its own ladder and a later change to the
 * platform's does not reach it, which is the point: it is their ladder now.
 *
 * A superior admin saves the platform ladder itself, through this same
 * handler — they own company_id NULL, so nothing is copied.
 *
 * Body: { levels: [ { id?, name, description, commission_percentage,
 *                     levelup_fee_minor, is_active } ] }, lowest rung first.
 */
const saveLadder = asyncHandler(async (req, res) => {
  if (!requireManage(req, res)) return;

  const owner = ownedCompanyId(req);
  if (owner === undefined) return res.status(400).json(NO_COMPANY);

  const submitted = Array.isArray(req.body?.levels) ? req.body.levels : null;
  if (!submitted) {
    return res.status(400).json({ message: 'Send the whole ladder as `levels`, lowest rung first.' });
  }
  if (!submitted.length) {
    return res.status(400).json({ message: 'A ladder needs at least one level.' });
  }

  const cleaned = submitted.map((entry) => ({
    id: Number(entry?.id) || null,
    name: String(entry?.name ?? '').trim(),
    description: entry?.description ? String(entry.description) : null,
    commission_percentage: clampPercent(entry?.commission_percentage),
    levelup_fee_minor: feeMinorFrom(entry?.levelup_fee_minor),
    is_active: entry?.is_active === undefined ? true : !!entry.is_active,
  }));

  const unnamed = cleaned.findIndex((entry) => !entry.name);
  if (unnamed !== -1) {
    return res.status(400).json({ message: `Level ${unnamed + 1} has no name.` });
  }
  // Within one ladder, not across the platform's: two companies are entitled
  // to both have a "Gold", and only a duplicate inside THIS list is ambiguous.
  const seen = new Set();
  const repeated = cleaned.find((entry) => {
    const key = entry.name.toLowerCase();
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });
  if (repeated) {
    return res.status(409).json({ message: `There are two "${repeated.name}" levels. Names must be different.` });
  }

  const own = await RealtorLevel.findAll({ where: { company_id: owner ?? null } });
  const ownById = new Map(own.map((level) => [level.id, level]));
  // Only a company can be adopting; a superior admin's own rungs ARE these.
  const adoptable = owner
    ? new Map((await RealtorLevel.findAll({ where: { company_id: null } })).map((l) => [l.id, l]))
    : new Map();

  const unknown = cleaned.find((entry) => entry.id && !ownById.has(entry.id) && !adoptable.has(entry.id));
  if (unknown) return res.status(404).json({ message: `Level #${unknown.id} is not one you can change.` });

  /*
   * Nothing may be dropped out from under a realtor standing on it.
   *
   * Checked for the whole save before anything is written, so the answer names
   * every rung at fault rather than failing on the first and leaving the admin
   * to discover the next one on the retry.
   */
  const keptIds = new Set(cleaned.map((entry) => entry.id).filter(Boolean));
  const dropped = [
    ...own.filter((level) => !keptIds.has(level.id)),
    ...(owner ? [...adoptable.values()].filter((level) => !keptIds.has(level.id)) : []),
  ];

  const occupied = [];
  for (const level of dropped) {
    const count = await User.count({
      where: { realtor_level_id: level.id, ...(owner ? { company_id: owner } : {}) },
    });
    if (count > 0) occupied.push({ name: level.name, count });
  }
  if (occupied.length) {
    const parts = occupied.map((o) => `${o.count} on ${o.name}`);
    return res.status(409).json({
      message: `You cannot remove a level a realtor is standing on (${parts.join(', ')}). `
        + 'Move them to another level first, or keep the level and deactivate it.',
    });
  }

  const transaction = await sequelize.transaction();
  try {
    const adopted = new Map();   // platform id → the company's copy
    const names = new Map();     // new id → name, for the request rows
    const saved = [];

    for (let index = 0; index < cleaned.length; index += 1) {
      const entry = cleaned[index];
      // Position IS the order sent. Spaced by 10 out of habit rather than
      // need: a ladder is only ever written whole now, so nothing is slotted
      // between two rungs without renumbering both.
      const fields = { ...entry, position: (index + 1) * 10 };
      delete fields.id;

      if (entry.id && ownById.has(entry.id)) {
        const level = ownById.get(entry.id);
        await level.update(fields, { transaction });
        saved.push(level);
        names.set(level.id, level.name);
        continue;
      }

      const copy = await RealtorLevel.create({
        ...fields,
        company_id: owner ?? null,
        created_by: req.user?.id ?? null,
      }, { transaction });
      saved.push(copy);
      names.set(copy.id, copy.name);
      if (entry.id) adopted.set(entry.id, copy.id);
    }

    // Repoint before deleting, so nothing is ever pointing at a row that has
    // gone. Only the company's own rows move; other tenants stay on the
    // platform rungs they are still using.
    const moved = adopted.size
      ? await remapLevelIds(sequelize, { companyId: owner, mapping: adopted, names, transaction })
      : null;

    const removable = own.filter((level) => !keptIds.has(level.id));
    for (const level of removable) {
      await level.destroy({ transaction });
    }

    await transaction.commit();

    res.json({
      data: saved,
      editable: true,
      source: owner ? 'company' : 'platform',
      // Said out loud because it is a one-way door: the company has left the
      // platform ladder and will not see later changes to it.
      adopted: adopted.size,
      moved,
    });
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }
});

/** Admin assigns a realtor to a level directly. */
const assignLevel = asyncHandler(async (req, res) => {
  if (!requireCompanyAdmin(req, res)) return;

  const realtor = await User.findOne({ where: { id: req.params.userId, type: 'realtor', ...companyScope(req) } });
  if (!realtor) return res.status(404).json({ message: 'Realtor not found' });

  let level = null;
  if (req.body.level_id) {
    // A rung of the ladder their company is actually on — not the platform's
    // as well, which after a company customises is a ladder they have left.
    level = await RealtorLevel.findOne({
      where: {
        id: req.body.level_id,
        company_id: await ladderOwnerFor(sequelize, realtor.company_id ?? null),
      },
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

  // A rung of the ladder in force for their company, and only that ladder.
  const target = await RealtorLevel.findOne({
    where: {
      id: req.body.level_id,
      is_active: true,
      company_id: await ladderOwnerFor(sequelize, realtor.company_id ?? null),
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
  saveLadder,
  assignLevel,
  listRequests,
  createRequest,
  approveRequest: reviewRequest('approved'),
  rejectRequest: reviewRequest('rejected'),
};

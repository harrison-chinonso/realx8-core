const { Op, QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize, AuditLog } = require('../models');
const { buildListQuery } = require('../../../../shared/src/listQuery');
const { likeOperator } = require('../../../../shared/src/dialect');

/**
 * Reading the audit trail. There is nothing here that writes one.
 *
 * That absence is the feature. An audit entry is created by the request it
 * describes — see shared/src/audit.js — and there is no endpoint anywhere that
 * amends or removes one, which is what "an audit cannot be edited or deleted,
 * only viewed" means in practice. The database refuses both as well, so the
 * guarantee does not rest on this file staying the way it is.
 *
 * ── Who sees what ───────────────────────────────────────────────────────────
 *
 * A platform administrator sees every entry, across every company, and may
 * narrow to one with ?company_id=.
 *
 * Everyone else sees their OWN company's entries and nothing else — including
 * the entries for work a platform administrator did ON their company, which is
 * the point of recording the affected company rather than the actor's. The
 * scope is applied as a WHERE clause the caller cannot influence; it is not a
 * filter the UI is trusted to send.
 */

const isPlatform = (req) => req.user?.isSuperiorAdmin === true || req.user?.type === 'superior_admin';

/**
 * The company scope, applied to every read.
 *
 * Fails closed for an account with no company, exactly as buildCompanyScope
 * does elsewhere: `company_id IS NULL` returns the platform-level entries and
 * nothing belonging to any tenant. An over-restrictive scope is a support
 * ticket; an over-permissive one hands one company's activity to another.
 */
const auditScope = (req) => {
  if (isPlatform(req)) {
    const requested = req.query.company_id;
    return requested ? { company_id: Number(requested) } : {};
  }
  return { company_id: req.user?.company_id ?? null };
};

/**
 * `from` / `to` as a created_at range.
 *
 * Spelled here rather than left to the generic filter syntax because a date
 * range is the filter this screen exists for, and `?from=2026-01-01` is what a
 * date picker naturally sends. `to` is taken as the END of its day: somebody
 * asking for entries up to the 14th means including the 14th, and a bare date
 * parsed as midnight would silently exclude everything that happened that day.
 */
const dateWindow = (req) => {
  const clause = {};
  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(req.query.to) : null;

  if (from && !Number.isNaN(from.getTime())) clause[Op.gte] = from;
  if (to && !Number.isNaN(to.getTime())) {
    const end = new Date(to);
    if (!/\d{2}:\d{2}/.test(String(req.query.to))) end.setHours(23, 59, 59, 999);
    clause[Op.lte] = end;
  }

  return Object.getOwnPropertySymbols(clause).length ? { created_at: clause } : {};
};

/**
 * The one thing a reader is looking for, and which column holds it.
 *
 * ── Why a field chooser and a box, rather than a control per field ──────────
 *
 * The screen had a dropdown for the area, one for the action and one for the
 * person — three controls, two of which were lists of every value that has ever
 * occurred, and neither of which answers the question somebody actually
 * arrives with. That question is almost always "what did <this person> do", or
 * "what have the admins been doing", and it is asked with a name or a role in
 * mind rather than a position in a list.
 *
 * So: pick which field, then type the value. One control fewer than before, and
 * it can answer a question about somebody whose name is not in a dropdown
 * because they have one entry.
 *
 * ── Whitelisted, and matched differently per field ──────────────────────────
 *
 * The field name arrives from the query string and is used to choose a column,
 * so it is resolved through this map and never interpolated. Anything else is
 * ignored rather than rejected — a stale bookmark should show the trail, not
 * an error.
 *
 * Name and email match on a fragment: people search for "kel", not for the
 * exact spelling of somebody's address. Role matches EXACTLY, because the
 * roles overlap as strings — a fragment match on "admin" would return
 * super_admin and superior_admin too, which is precisely the distinction
 * somebody filtering by role is trying to draw.
 */
const MATCH_FIELDS = {
  role: { column: 'actor_type', exact: true },
  name: { column: 'actor_name', exact: false },
  email: { column: 'actor_email', exact: false },
};

const actorMatch = (req) => {
  const value = String(req.query.match ?? '').trim();
  if (!value) return {};

  // Defaults to role, which is what the screen opens on.
  const field = MATCH_FIELDS[String(req.query.match_field || 'role').toLowerCase()];
  if (!field) return {};

  if (field.exact) return { [field.column]: value.toLowerCase() };

  const like = likeOperator(sequelize);
  // Escaped, so a name containing % or _ is searched for rather than treated
  // as a pattern — the same escaping buildListQuery does for its own search.
  return { [field.column]: { [like]: `%${value.replace(/[%_]/g, '\\$&')}%` } };
};

const LIST_CONFIG = {
  order: [['created_at', 'DESC'], ['id', 'DESC']],
  searchFields: ['actor_name', 'actor_email', 'action', 'action_label', 'entity_label', 'path'],
};

/**
 * The trail, newest first.
 *
 * `metadata` is deliberately absent from the list. It is the largest column by
 * far and it is read for one entry at a time, so sending it for every row on
 * every page would dominate the response for a field nothing on the list
 * renders. Fetch a single entry to see it.
 */
const listAuditLogs = asyncHandler(async (req, res) => {
  const { where, order, page, limit, offset } = buildListQuery(AuditLog, req, {
    ...LIST_CONFIG,
    defaultWhere: auditScope,
    /*
     * Both narrowings in one object. buildListQuery calls this once and drops
     * a clause with no own enumerable keys, so the two are merged here rather
     * than returned as an Op.and — whose symbol key would not survive that
     * check.
     */
    whereBuilder: (request) => ({ ...dateWindow(request), ...actorMatch(request) }),
  });

  const result = await AuditLog.findAndCountAll({
    where,
    attributes: { exclude: ['metadata'] },
    limit,
    offset,
    order,
  });

  res.json({
    data: result.rows,
    pagination: {
      page,
      limit,
      total: result.count,
      totalPages: Math.max(Math.ceil(result.count / limit), 1),
    },
  });
});

/** One entry in full, including what was asked for. */
const getAuditLog = asyncHandler(async (req, res) => {
  const entry = await AuditLog.findOne({
    where: { id: req.params.id, ...auditScope(req) },
  });
  // Same answer for "no such entry" and "not yours", so the endpoint cannot be
  // used to discover that another company did something.
  if (!entry) return res.status(404).json({ message: 'Audit entry not found' });

  const plain = entry.get({ plain: true });
  let metadata = null;
  try {
    metadata = plain.metadata ? JSON.parse(plain.metadata) : null;
  } catch {
    // Stored as text on purpose, so an unparseable value costs the caller the
    // detail rather than the whole entry.
    metadata = { raw: plain.metadata };
  }

  res.json({ data: { ...plain, metadata } });
});

/**
 * The values worth offering in the filter controls, within the caller's scope.
 *
 * Computed rather than hardcoded: the set of actions grows whenever a route is
 * added, and a dropdown listing actions that never occur — or missing ones that
 * do — is how a reader concludes the trail does not contain what it contains.
 */
const getAuditFilters = asyncHandler(async (req, res) => {
  const scope = auditScope(req);
  const scoped = Object.prototype.hasOwnProperty.call(scope, 'company_id');
  const where = scoped
    ? (scope.company_id === null ? 'WHERE company_id IS NULL' : 'WHERE company_id = :companyId')
    : '';
  const replacements = { companyId: scope.company_id };

  const [actions, modules, actors, roles] = await Promise.all([
    sequelize.query(
      `SELECT action, MAX(action_label) AS action_label, COUNT(*) AS total
         FROM audit_logs ${where} GROUP BY action ORDER BY action ASC`,
      { replacements, type: QueryTypes.SELECT },
    ),
    sequelize.query(
      `SELECT module, COUNT(*) AS total FROM audit_logs ${where}
        GROUP BY module ORDER BY module ASC`,
      { replacements, type: QueryTypes.SELECT },
    ),
    /**
     * Actors, named as they were named at the time.
     *
     * Grouped by actor_id but reading the name off the ROW, so somebody who has
     * since been deleted still appears — which is the case this list most needs
     * to cover.
     */
    sequelize.query(
      `SELECT actor_id, MAX(actor_name) AS actor_name, MAX(actor_type) AS actor_type,
              COUNT(*) AS total
         FROM audit_logs ${where}
        GROUP BY actor_id ORDER BY COUNT(*) DESC`,
      { replacements, type: QueryTypes.SELECT },
    ),
    /*
     * The roles that actually appear, for the role filter's suggestions.
     *
     * Offered rather than imposed: the box takes free text, and these are what
     * somebody would otherwise have to know to type. `super_admin` and
     * `superior_admin` are a keystroke apart and mean very different things,
     * which is the case this list exists for.
     */
    sequelize.query(
      `SELECT actor_type, COUNT(*) AS total FROM audit_logs
        ${where ? `${where} AND` : 'WHERE'} actor_type IS NOT NULL
        GROUP BY actor_type ORDER BY COUNT(*) DESC`,
      { replacements, type: QueryTypes.SELECT },
    ),
  ]);

  res.json({ data: { actions, modules, actors, roles } });
});

module.exports = { listAuditLogs, getAuditLog, getAuditFilters };

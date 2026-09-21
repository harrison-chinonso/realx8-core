const asyncHandler = require('./asyncHandler');
/**
 * Search, filtering, sorting and export live in one shared module rather than
 * in eight copies of this file — see shared/src/listQuery.js. Every table in
 * this service gets them by being a table.
 */
const { buildListQuery, sensitiveColumns, EXPORT_LIMIT } = require('../../../../shared/src/listQuery');

// Shared company scope helpers — importable from this file
/**
 * The company a request may see.
 *
 * A platform admin is scoped to nothing — they operate across companies — and
 * narrows with ?company_id=. Everyone else is scoped to their own company.
 *
 * ── The null case fails CLOSED, and that is the point ────────────────────────
 *
 * This used to return {} for a user whose company_id was null, which is not
 * "no company" but "no filter": a company-level admin whose row had a null
 * company_id saw EVERY tenant's rows, indistinguishable from a platform admin.
 * Measured on /invoices, such an account returned invoices from both companies.
 *
 * Scoping to `company_id IS NULL` instead means an account attached to nobody
 * sees only rows attached to nobody, which is nothing of consequence. An
 * over-restrictive scope is a support ticket; an over-permissive one is a data
 * breach across tenants.
 *
 * userController already did this. It is now the rule everywhere rather than in
 * the one file where somebody happened to think of it.
 */
const buildCompanyScope = (req) => {
  if (req.user?.isSuperiorAdmin) {
    const cid = req.query.company_id || req.body?.company_id;
    return cid ? { company_id: Number(cid) } : {};
  }
  return { company_id: req.user?.company_id ?? null };
};

/**
 * The ONE scope a list of SEEDED DEFAULTS belongs to.
 *
 * ── Why buildCompanyScope is the wrong tool for these ───────────────────────
 *
 * It answers `{}` — no filter — for a platform admin who has not chosen a
 * company, which is exactly right for records a platform admin wants to see
 * across every tenant: bills, vendors, invoices. Each of those rows describes
 * something different, so the union is simply "everything".
 *
 * It is wrong for anything seeded PER COMPANY. Every company gets its own
 * "Land acquisition", its own account 1110, its own "Subcontractor works" —
 * so the union shows the same name once per tenant and reads, correctly, as
 * duplication. A picker offering "Land acquisition" three times is a picker
 * where two of the three choices are somebody else's.
 *
 * ── Never `{}` ──────────────────────────────────────────────────────────────
 *
 * A platform admin with no company chosen gets the PLATFORM's own set — one
 * coherent list, which is also the one they can meaningfully edit. Choosing a
 * company narrows to that company's. Either way it is one set, because one set
 * is what the word "defaults" means here.
 */
const buildDefaultsScope = (req) => {
  if (req.user?.isSuperiorAdmin) {
    const chosen = req.query?.company_id ?? req.body?.company_id;
    return { company_id: chosen ? Number(chosen) : null };
  }
  return { company_id: req.user?.company_id ?? null };
};

const withCompanyAudit = (req, payload) => {
  const body = payload || req.body;
  const company_id = req.user?.isSuperiorAdmin
    ? (body.company_id || req.query.company_id || null)
    : (req.user?.company_id || null);
  return {
    ...body,
    ...(company_id != null ? { company_id: Number(company_id) } : {}),
    created_by: req.user?.id || body.created_by || null,
  };
};

const buildCrudController = (Model, config = {}) => ({
  list: asyncHandler(async (req, res) => {
    const {
      where, order, page, limit, offset, exporting,
    } = buildListQuery(Model, req, config);
    const include = config.include || [];
    const result = await Model.findAndCountAll({
      where,
      include,
      /**
       * Password hashes and their kin are never part of a listing. Excluded
       * here rather than on the model, because the model's own queries — the
       * sign-in that has to compare a password — genuinely need them.
       */
      attributes: config.attributes || { exclude: sensitiveColumns(Model) },
      // With a hasMany include, findAndCountAll counts JOINED rows: one invoice
      // with four payments counted as four. That inflated `total`, which in turn
      // produced totalPages the data could never fill, so lists offered pages
      // that came back empty. distinct makes it COUNT(DISTINCT <pk>).
      //
      // Only when something is included — an unjoined count is already correct,
      // and COUNT(DISTINCT id) is needless work on a large plain table.
      ...(include.length ? { distinct: true } : {}),
      limit,
      offset,
      order,
    });
    // afterList lets a caller enrich the page with data from another table —
    // resolving ids to names, say — without turning the query into a join
    // across tables this service does not own.
    const rows = config.afterList ? await config.afterList(result.rows, req) : result.rows;

    res.json({
      data: rows,
      pagination: {
        page,
        limit,
        total: result.count,
        totalPages: Math.ceil(result.count / limit) || 1,
        // An export says so, and says when it hit the cap. A report quietly
        // missing its tail is worse than one that reports being truncated.
        ...(exporting ? { exported: true, truncated: result.count > EXPORT_LIMIT } : {}),
      },
    });
  }),

  getOne: asyncHandler(async (req, res) => {
    const where = { id: req.params.id, ...(config.scopeWhere ? config.scopeWhere(req) : {}) };
    const entity = await Model.findOne({
      where,
      include: config.include || [],
      attributes: config.attributes || { exclude: sensitiveColumns(Model) },
    });
    if (!entity) return res.status(404).json({ message: `${Model.name} not found` });
    // afterGet mirrors afterList for a single record, so a detail view shows
    // the same resolved names the list does.
    res.json({ data: config.afterGet ? await config.afterGet(entity, req) : entity });
  }),

  create: asyncHandler(async (req, res) => {
    const payload = config.beforeCreate ? await config.beforeCreate(req) : req.body;
    /**
     * createWith lets a caller own the insert itself.
     *
     * Needed by anything whose row carries a GENERATED reference: the number
     * has to be chosen and written as one retryable unit, because two requests
     * arriving together can pick the same one and the loser has to try again.
     * A plain Model.create here would surface that collision as a failed save.
     */
    const entity = config.createWith
      ? await config.createWith(payload, req)
      : await Model.create(payload);
    const responseEntity = config.afterCreate ? await config.afterCreate(entity, req) : entity;
    res.status(201).json({ data: responseEntity });
  }),

  update: asyncHandler(async (req, res) => {
    const where = { id: req.params.id, ...(config.scopeWhere ? config.scopeWhere(req) : {}) };
    const entity = await Model.findOne({ where });
    if (!entity) return res.status(404).json({ message: `${Model.name} not found` });
    const payload = config.beforeUpdate ? await config.beforeUpdate(req, entity) : req.body;
    await entity.update(payload);
    const updated = config.afterUpdate ? await config.afterUpdate(entity, req) : entity;
    res.json({ data: updated });
  }),

  remove: asyncHandler(async (req, res) => {
    const where = { id: req.params.id, ...(config.scopeWhere ? config.scopeWhere(req) : {}) };
    const entity = await Model.findOne({ where });
    if (!entity) return res.status(404).json({ message: `${Model.name} not found` });
    if (config.beforeDelete) await config.beforeDelete(entity, req);
    await entity.destroy();
    res.json({ message: `${Model.name} deleted successfully` });
  }),
});

module.exports = {
  buildCrudController, buildCompanyScope, buildDefaultsScope, withCompanyAudit,
};

const asyncHandler = require('./asyncHandler');
/**
 * Search, filtering, sorting and export live in one shared module rather than
 * in eight copies of this file — see shared/src/listQuery.js. Every table in
 * this service gets them by being a table.
 */
const { buildListQuery, sensitiveColumns, EXPORT_LIMIT } = require('../../../../shared/src/listQuery');

// Shared company scope helpers — importable from this file
const buildCompanyScope = (req) => {
  if (req.user?.isSuperiorAdmin) {
    const cid = req.query.company_id || req.body?.company_id;
    return cid ? { company_id: Number(cid) } : {};
  }
  return req.user?.company_id ? { company_id: req.user.company_id } : {};
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
    res.json({
      data: result.rows,
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
    res.json({ data: entity });
  }),

  create: asyncHandler(async (req, res) => {
    const payload = config.beforeCreate ? await config.beforeCreate(req) : req.body;
    const entity = await Model.create(payload);
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

module.exports = { buildCrudController, buildCompanyScope, withCompanyAudit };

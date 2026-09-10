const { Op } = require('sequelize');
const asyncHandler = require('./asyncHandler');

const paginate = (req) => {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 100);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
};

const buildSearchWhere = (search, fields) => {
  if (!search || !fields?.length) return {};
  return { [Op.or]: fields.map((field) => ({ [field]: { [Op.like]: `%${search}%` } })) };
};

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
    const { page, limit, offset } = paginate(req);
    const search = (req.query.search || '').trim();
    const where = {
      ...(config.defaultWhere ? config.defaultWhere(req) : {}),
      ...buildSearchWhere(search, config.searchFields),
      ...(config.whereBuilder ? config.whereBuilder(req) : {}),
    };
    const include = config.include || [];
    const result = await Model.findAndCountAll({
      where,
      include,
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
      order: config.order || [['id', 'DESC']],
    });
    // afterList lets a caller enrich the page with data from another table —
    // resolving ids to names, say — without turning the query into a join
    // across tables this service does not own.
    const rows = config.afterList ? await config.afterList(result.rows, req) : result.rows;

    res.json({
      data: rows,
      pagination: { page, limit, total: result.count, totalPages: Math.ceil(result.count / limit) || 1 },
    });
  }),

  getOne: asyncHandler(async (req, res) => {
    const where = { id: req.params.id, ...(config.scopeWhere ? config.scopeWhere(req) : {}) };
    const entity = await Model.findOne({ where, include: config.include || [] });
    if (!entity) return res.status(404).json({ message: `${Model.name} not found` });
    // afterGet mirrors afterList for a single record, so a detail view shows
    // the same resolved names the list does.
    res.json({ data: config.afterGet ? await config.afterGet(entity, req) : entity });
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

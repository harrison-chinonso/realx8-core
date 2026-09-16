const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize } = require('../models');
const { asMinor, toMajor } = require('../../../../shared/src/money');
const { q, insertReturningId } = require('../../../../shared/src/dialect');
const promotions = require('../../../../shared/src/promotionStore');
const { validatePromotion } = require('../../../../shared/src/promotions/validate');
const { evaluateBasket } = require('../../../../shared/src/promotions/evaluate');
const { STATUS, TRIGGER, RESOLUTION } = require('../../../../shared/src/promotions/types');

/**
 * Configuring campaigns.
 *
 * ── The lifecycle is a set of ACTIONS, not a status field ───────────────────
 *
 * Activating, pausing and archiving are each their own endpoint rather than a
 * PUT that sets `status`. A promotion moving to ACTIVE has to be validated
 * first — an incoherent campaign that goes live quietly discounts nobody and
 * the first anybody hears is a customer asking where their advertised 20% went.
 * A status field on the edit form cannot enforce that, because saving a form is
 * not the moment anybody is thinking about whether the rules hold together.
 *
 * ── Editing never rewrites history ──────────────────────────────────────────
 *
 * Every save writes a new immutable version (see promotionStore.saveVersion).
 * Drafts included — having one code path means a promotion that was activated
 * cannot be edited by a route that forgot the rule.
 */

/** The company a request acts for; null for a platform admin acting globally. */
const companyOf = (req) => {
  if (req.user?.type === 'superior_admin' && !req.user?.company_id) return null;
  return req.user?.company_id ?? null;
};

/** Company scoping as a SQL fragment, so a platform admin sees everything. */
const scopeSql = (companyId, alias = 'p') => (companyId ? `AND ${alias}.company_id = :companyId` : '');

const parseConfig = (raw) => {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
  } catch {
    return {};
  }
};

/** A promotion as a screen wants it: the row, its rules, and how it is doing. */
const present = (row) => ({
  id: Number(row.id),
  name: row.name,
  description: row.description,
  code: row.code,
  trigger: row.trigger_type,
  status: row.status,
  starts_at: row.starts_at,
  ends_at: row.ends_at,
  priority: Number(row.priority),
  stackable: Boolean(row.stackable),
  customer_message: row.customer_message,
  terms: row.terms,
  banner_url: row.banner_url,
  internal_notes: row.internal_notes,
  version: row.version == null ? null : Number(row.version),
  version_id: row.version_id == null ? null : Number(row.version_id),
  config: parseConfig(row.config),
  created_at: row.created_at,
  created_by: row.created_by,
  // Present only on the list, which joins the redemption totals.
  ...(row.redemptions === undefined ? {} : {
    redemptions: Number(row.redemptions) || 0,
    discount_granted: toMajor(asMinor(row.discount_granted)),
    sales_value: toMajor(asMinor(row.sales_value)),
    units_sold: Number(row.units_sold) || 0,
  }),
});

/**
 * Every campaign, with how it is performing.
 *
 * The redemption totals are joined here rather than fetched per row, because a
 * dashboard listing twenty promotions would otherwise make twenty-one queries —
 * and because the numbers have to be consistent with each other, which separate
 * queries at separate moments cannot promise.
 */
const listPromotions = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const status = req.query.status ? String(req.query.status).toUpperCase() : null;

  const rows = await sequelize.query(
    `SELECT p.*, v.id AS version_id, v.version, v.config,
            COALESCE(r.redemptions, 0) AS redemptions,
            COALESCE(r.discount_granted, 0) AS discount_granted,
            COALESCE(r.sales_value, 0) AS sales_value,
            COALESCE(r.units_sold, 0) AS units_sold
       FROM ${q(sequelize, 'promotions')} p
       LEFT JOIN ${q(sequelize, 'promotion_versions')} v ON v.id = p.current_version_id
       LEFT JOIN (
         SELECT promotion_id,
                COUNT(*) AS redemptions,
                SUM(discount_minor) AS discount_granted,
                SUM(payable_minor) AS sales_value,
                SUM(units_count) AS units_sold
           FROM ${q(sequelize, 'promotion_redemptions')}
          WHERE status = 'CONFIRMED'
          GROUP BY promotion_id
       ) r ON r.promotion_id = p.id
      WHERE 1 = 1 ${scopeSql(companyId)}
        ${status ? 'AND p.status = :status' : ''}
      ORDER BY p.priority ASC, p.id DESC`,
    {
      replacements: { ...(companyId ? { companyId } : {}), ...(status ? { status } : {}) },
      type: QueryTypes.SELECT,
    },
  );

  res.json({ success: true, data: rows.map(present) });
});

const getPromotion = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const [row] = await sequelize.query(
    `SELECT p.*, v.id AS version_id, v.version, v.config
       FROM ${q(sequelize, 'promotions')} p
       LEFT JOIN ${q(sequelize, 'promotion_versions')} v ON v.id = p.current_version_id
      WHERE p.id = :id ${scopeSql(companyId)}`,
    { replacements: { id: req.params.id, ...(companyId ? { companyId } : {}) }, type: QueryTypes.SELECT },
  );
  if (!row) return res.status(404).json({ message: 'Promotion not found' });

  const versions = await sequelize.query(
    `SELECT id, version, change_note, created_by, created_at
       FROM ${q(sequelize, 'promotion_versions')}
      WHERE promotion_id = :id ORDER BY version DESC`,
    { replacements: { id: row.id }, type: QueryTypes.SELECT },
  );

  return res.json({
    success: true,
    data: {
      ...present(row),
      // The audit trail FRD 38 asks for: what changed, when, and by whom.
      versions,
      validation: validatePromotion({ ...parseConfig(row.config), name: row.name, status: row.status }),
    },
  });
});

/** The columns an edit may set, as distinct from the rules. */
const rowFieldsFrom = (body) => ({
  name: String(body.name || '').trim(),
  description: body.description ?? null,
  code: body.code ? String(body.code).trim().toUpperCase() : null,
  trigger_type: body.trigger === TRIGGER.CODE ? TRIGGER.CODE : TRIGGER.AUTOMATIC,
  starts_at: body.starts_at || null,
  ends_at: body.ends_at || null,
  priority: Number(body.priority) || 100,
  stackable: body.stackable === true,
  customer_message: body.customer_message ?? null,
  terms: body.terms ?? null,
  banner_url: body.banner_url ?? null,
  internal_notes: body.internal_notes ?? null,
});

/** The rules, which become an immutable version. */
const configFrom = (body) => ({
  name: String(body.name || '').trim(),
  benefit_type: body.benefit_type,
  percentage: body.percentage,
  amount_minor: body.amount_minor,
  max_discount_minor: body.max_discount_minor,
  basis: body.basis,
  scope: body.scope || {},
  combination: body.combination || [],
  tiers: body.tiers || [],
  tier_on: body.tier_on,
  buy_x_get_y: body.buy_x_get_y || null,
  perks: body.perks || [],
  min_quantity: body.min_quantity,
  min_purchase_minor: body.min_purchase_minor,
  eligibility: body.eligibility || {},
  payment_condition: body.payment_condition,
  installment_plan_ids: body.installment_plan_ids || [],
  min_upfront_percentage: body.min_upfront_percentage,
  limits: body.limits || {},
  trigger: body.trigger === TRIGGER.CODE ? TRIGGER.CODE : TRIGGER.AUTOMATIC,
  code: body.code ? String(body.code).trim().toUpperCase() : null,
});

/**
 * A new campaign, always as a DRAFT.
 *
 * Never straight to ACTIVE, however the request asks: activation validates, and
 * a promotion that went live on the same call that created it would skip that.
 * The wizard's last step activates explicitly, which is also the moment a
 * person is actually deciding to publish.
 */
const createPromotion = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const fields = rowFieldsFrom(req.body);
  if (!fields.name) return res.status(400).json({ message: 'Give the promotion a name.' });

  const transaction = await sequelize.transaction();
  try {
    /**
     * insertReturningId, not a destructured INSERT result.
     *
     * `const [id] = await sequelize.query(..., { type: INSERT })` reads the new
     * row's id on MySQL, where the driver returns [insertId, rowCount]. Postgres
     * returns no id at all for an INSERT without RETURNING, so `id` was
     * undefined — and the next statement, saveVersion's
     * `WHERE promotion_id = :promotionId`, had nothing to put after the equals
     * sign. The query reached the server ending in "promotion_id =", and the
     * parser answered "syntax error at end of input", which is what an admin
     * saw when they pressed Publish.
     *
     * The helper runs INSERT ... RETURNING as one statement on Postgres and
     * falls back to LAST_INSERT_ID() on MySQL.
     */
    const id = await insertReturningId(
      sequelize,
      `INSERT INTO ${q(sequelize, 'promotions')}
         (company_id, name, description, code, trigger_type, status, starts_at, ends_at,
          priority, stackable, customer_message, terms, banner_url, internal_notes,
          created_by, created_at, updated_at)
       VALUES (:companyId, :name, :description, :code, :trigger, :status, :startsAt, :endsAt,
          :priority, :stackable, :message, :terms, :banner, :notes, :createdBy, :now, :now)`,
      {
        replacements: {
          companyId,
          name: fields.name,
          description: fields.description,
          code: fields.code,
          trigger: fields.trigger_type,
          status: STATUS.DRAFT,
          startsAt: fields.starts_at,
          endsAt: fields.ends_at,
          priority: fields.priority,
          stackable: fields.stackable,
          message: fields.customer_message,
          terms: fields.terms,
          banner: fields.banner_url,
          notes: fields.internal_notes,
          createdBy: req.user?.id ?? null,
          now: new Date(),
        },
        transaction,
      },
    );

    const saved = await promotions.saveVersion(sequelize, {
      promotionId: id, companyId, config: configFrom(req.body),
      changeNote: 'Created', createdBy: req.user?.id ?? null, transaction,
    });

    await transaction.commit();
    return res.status(201).json({
      success: true,
      data: { id, status: STATUS.DRAFT, ...saved },
    });
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    if (error?.name === 'SequelizeUniqueConstraintError' || error?.parent?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'You already have a promotion using that code.' });
    }
    throw error;
  }
});

/**
 * Edit a campaign. Writes a new version; never alters an old one.
 *
 * Editing a LIVE promotion is allowed and does not need to be forbidden: the
 * new version applies to new purchases and every existing redemption goes on
 * naming the version it was calculated under. That is what versioning bought.
 */
const updatePromotion = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const [existing] = await sequelize.query(
    `SELECT id, status FROM ${q(sequelize, 'promotions')} p WHERE p.id = :id ${scopeSql(companyId)}`,
    { replacements: { id: req.params.id, ...(companyId ? { companyId } : {}) }, type: QueryTypes.SELECT },
  );
  if (!existing) return res.status(404).json({ message: 'Promotion not found' });

  if (existing.status === STATUS.ARCHIVED) {
    return res.status(409).json({
      message: 'This promotion is archived. Copy it into a new one rather than editing it.',
    });
  }

  const fields = rowFieldsFrom(req.body);
  const transaction = await sequelize.transaction();
  try {
    await sequelize.query(
      `UPDATE ${q(sequelize, 'promotions')}
          SET name = :name, description = :description, code = :code, trigger_type = :trigger,
              starts_at = :startsAt, ends_at = :endsAt, priority = :priority, stackable = :stackable,
              customer_message = :message, terms = :terms, banner_url = :banner,
              internal_notes = :notes, updated_at = :now
        WHERE id = :id`,
      {
        replacements: {
          id: existing.id,
          name: fields.name,
          description: fields.description,
          code: fields.code,
          trigger: fields.trigger_type,
          startsAt: fields.starts_at,
          endsAt: fields.ends_at,
          priority: fields.priority,
          stackable: fields.stackable,
          message: fields.customer_message,
          terms: fields.terms,
          banner: fields.banner_url,
          notes: fields.internal_notes,
          now: new Date(),
        },
        type: QueryTypes.UPDATE,
        transaction,
      },
    );

    const saved = await promotions.saveVersion(sequelize, {
      promotionId: existing.id, companyId, config: configFrom(req.body),
      changeNote: req.body.change_note || 'Edited',
      createdBy: req.user?.id ?? null, transaction,
    });

    await transaction.commit();
    return res.json({ success: true, data: { id: existing.id, ...saved } });
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    if (error?.name === 'SequelizeUniqueConstraintError' || error?.parent?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'You already have a promotion using that code.' });
    }
    throw error;
  }
});

/**
 * Which lifecycle moves are allowed from where.
 *
 * Written out rather than left to whatever the request asks, because the
 * invalid transitions are the interesting ones: un-expiring a campaign by
 * setting it back to ACTIVE would silently re-price purchases made in the gap,
 * and reviving an archived one would resurrect rules nobody has looked at for a
 * year.
 */
const TRANSITIONS = {
  [STATUS.DRAFT]: [STATUS.SCHEDULED, STATUS.ACTIVE, STATUS.ARCHIVED],
  [STATUS.SCHEDULED]: [STATUS.ACTIVE, STATUS.PAUSED, STATUS.DEACTIVATED, STATUS.ARCHIVED],
  [STATUS.ACTIVE]: [STATUS.PAUSED, STATUS.DEACTIVATED, STATUS.EXPIRED, STATUS.ARCHIVED],
  [STATUS.PAUSED]: [STATUS.ACTIVE, STATUS.DEACTIVATED, STATUS.ARCHIVED],
  [STATUS.DEACTIVATED]: [STATUS.ARCHIVED],
  [STATUS.EXPIRED]: [STATUS.ARCHIVED],
  [STATUS.ARCHIVED]: [],
};

const setStatus = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const target = String(req.body?.status || '').toUpperCase();

  const [row] = await sequelize.query(
    `SELECT p.id, p.status, p.name, p.starts_at, p.ends_at, v.config
       FROM ${q(sequelize, 'promotions')} p
       LEFT JOIN ${q(sequelize, 'promotion_versions')} v ON v.id = p.current_version_id
      WHERE p.id = :id ${scopeSql(companyId)}`,
    { replacements: { id: req.params.id, ...(companyId ? { companyId } : {}) }, type: QueryTypes.SELECT },
  );
  if (!row) return res.status(404).json({ message: 'Promotion not found' });

  const allowed = TRANSITIONS[row.status] || [];
  if (!allowed.includes(target)) {
    // "A archived promotion" — the article has to follow the word it precedes,
    // and every status here that starts with a vowel is one somebody will read.
    const article = /^[aeiou]/i.test(row.status) ? 'An' : 'A';
    return res.status(409).json({
      message: `${article} ${row.status.toLowerCase()} promotion cannot become ${target.toLowerCase()}.`,
      allowed,
    });
  }

  /**
   * Validation happens on the way to ACTIVE or SCHEDULED, and only there.
   *
   * A draft is allowed to be incoherent — that is what a draft is for. What
   * must not happen is an incoherent campaign going live, because it fails
   * silently: no error, no discount, and a customer asking why.
   */
  if (target === STATUS.ACTIVE || target === STATUS.SCHEDULED) {
    const verdict = validatePromotion({
      ...parseConfig(row.config), name: row.name,
      starts_at: row.starts_at, ends_at: row.ends_at,
    });
    if (!verdict.ok) {
      return res.status(422).json({
        message: 'This promotion cannot go live yet.',
        errors: verdict.errors,
        warnings: verdict.warnings,
      });
    }
  }

  await sequelize.query(
    `UPDATE ${q(sequelize, 'promotions')} SET status = :status, updated_at = :now WHERE id = :id`,
    { replacements: { status: target, id: row.id, now: new Date() }, type: QueryTypes.UPDATE },
  );

  return res.json({ success: true, data: { id: row.id, status: target } });
});

/**
 * What a promotion would do to a basket somebody describes.
 *
 * ── Runs the REAL engine ────────────────────────────────────────────────────
 *
 * The same function a purchase runs, on a configuration that has not been saved
 * yet. That is the whole value: a preview computed by a second implementation
 * agrees with the real thing right up until it does not, and the disagreement
 * shows up as a campaign that behaves differently from what the admin was
 * shown before activating it.
 *
 * Writes nothing, and can be run against a date in the future — so a campaign
 * scheduled for next month can be tested today.
 */
const previewPromotion = asyncHandler(async (req, res) => {
  const config = req.body?.config;
  if (!config) return res.status(400).json({ message: 'Send the promotion configuration to preview.' });

  const lines = (req.body?.lines || []).map((line) => ({
    unit_id: Number(line.unit_id),
    property_id: Number(line.property_id),
    quantity: Number(line.quantity) || 1,
    unit_price_minor: asMinor(line.unit_price_minor ?? Math.round(Number(line.unit_price || 0) * 100)),
  }));
  if (!lines.length) return res.status(400).json({ message: 'Describe at least one unit to price.' });

  const candidate = {
    id: req.body.promotion_id ?? 0,
    name: config.name || 'This promotion',
    /**
     * Previewed AS IF live, whatever it is really. An admin testing a draft
     * wants to know what it will do once published, not to be told it is a
     * draft — which they already know.
     */
    status: STATUS.ACTIVE,
    trigger: config.trigger || TRIGGER.AUTOMATIC,
    code: config.code || null,
    starts_at: req.body.starts_at || null,
    ends_at: req.body.ends_at || null,
    priority: 1,
    stackable: false,
    ...config,
  };

  const result = evaluateBasket([candidate], { lines }, {
    now: req.body.at ? new Date(req.body.at) : new Date(),
    buyer: req.body.buyer || {},
    payment_type: req.body.payment_type || 'outright',
    installment_plan_id: req.body.installment_plan_id ?? null,
    upfront_percentage: req.body.upfront_percentage ?? null,
    // A code promotion previews as though the buyer typed it; testing whether a
    // code gate works is not what the preview is for.
    codes: candidate.code ? [candidate.code] : [],
    usage: {},
    resolution: RESOLUTION.HIGHEST_BENEFIT,
  });

  return res.json({
    success: true,
    data: {
      ...result,
      original: toMajor(result.original_minor),
      discount: toMajor(result.discount_minor),
      payable: toMajor(result.payable_minor),
    },
    validation: validatePromotion(candidate),
  });
});

/** Validate a draft without saving it, for the wizard's live feedback. */
const validateDraft = asyncHandler(async (req, res) => {
  res.json({ success: true, data: validatePromotion(req.body?.config || req.body || {}) });
});

/**
 * What a buyer would pay for a unit right now — the listing price.
 *
 * Not staff-only: this is what the property page shows, and the whole point of
 * a campaign is that customers see it.
 */
const quoteForUnit = asyncHandler(async (req, res) => {
  const [unit] = await sequelize.query(
    `SELECT pu.id, pu.name, pu.price, pu.property_id, p.company_id
       FROM ${q(sequelize, 'property_units')} pu
       JOIN ${q(sequelize, 'properties')} p ON p.id = pu.property_id
      WHERE pu.id = :id`,
    { replacements: { id: req.params.unitId }, type: QueryTypes.SELECT },
  );
  if (!unit) return res.status(404).json({ message: 'Unit not found' });

  const quote = await promotions.quoteUnit(sequelize, {
    companyId: unit.company_id,
    unit: { id: unit.id, property_id: unit.property_id, price: unit.price },
    quantity: Number(req.query.quantity) || 1,
    buyer: { id: req.user?.id ?? null },
    paymentType: req.query.payment_type || 'outright',
    codes: req.query.code ? [req.query.code] : [],
  });

  return res.json({
    success: true,
    data: {
      unit_id: unit.id,
      unit_name: unit.name,
      original: toMajor(quote.original_unit_minor ?? quote.original_minor),
      promotional: toMajor(quote.promotional_unit_minor ?? quote.payable_minor),
      discount: toMajor(quote.discount_minor),
      applied: quote.applied,
      // Only the reasons a CUSTOMER can act on. "You have used this already" is
      // useful; "another offer was worth more" is noise on a listing.
      hints: (quote.considered || []).filter(
        (entry) => ['code_required', 'below_min_quantity', 'reward_unit_not_in_basket'].includes(entry.reason),
      ),
    },
  });
});

/**
 * How a campaign is performing (FRD 35, 36).
 *
 * Original value, discount granted and actual sales value — the three figures
 * the FRD's report table names, from the frozen redemption rows rather than by
 * recomputing, so the report of a finished campaign never changes.
 */
const promotionAnalytics = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const { from, to } = req.query;

  const bounds = [];
  if (from) bounds.push('AND r.redeemed_at >= :from');
  if (to) bounds.push('AND r.redeemed_at <= :to');

  const [totals] = await sequelize.query(
    `SELECT COUNT(*) AS redemptions,
            COUNT(DISTINCT r.customer_id) AS customers,
            COALESCE(SUM(r.units_count), 0) AS units_sold,
            COALESCE(SUM(r.original_minor), 0) AS original_value,
            COALESCE(SUM(r.discount_minor), 0) AS discount_granted,
            COALESCE(SUM(r.payable_minor), 0) AS sales_value
       FROM ${q(sequelize, 'promotion_redemptions')} r
      WHERE r.status = 'CONFIRMED' ${companyId ? 'AND r.company_id = :companyId' : ''}
        ${req.params.id ? 'AND r.promotion_id = :promotionId' : ''}
        ${bounds.join(' ')}`,
    {
      replacements: {
        ...(companyId ? { companyId } : {}),
        ...(req.params.id ? { promotionId: req.params.id } : {}),
        ...(from ? { from } : {}), ...(to ? { to } : {}),
      },
      type: QueryTypes.SELECT,
    },
  );

  const byProperty = await sequelize.query(
    `SELECT r.property_id, pr.name AS property_name,
            COUNT(*) AS redemptions,
            COALESCE(SUM(r.units_count), 0) AS units_sold,
            COALESCE(SUM(r.discount_minor), 0) AS discount_granted,
            COALESCE(SUM(r.payable_minor), 0) AS sales_value
       FROM ${q(sequelize, 'promotion_redemptions')} r
       LEFT JOIN ${q(sequelize, 'properties')} pr ON pr.id = r.property_id
      WHERE r.status = 'CONFIRMED' ${companyId ? 'AND r.company_id = :companyId' : ''}
        ${req.params.id ? 'AND r.promotion_id = :promotionId' : ''}
        ${bounds.join(' ')}
      GROUP BY r.property_id, pr.name
      ORDER BY SUM(r.payable_minor) DESC`,
    {
      replacements: {
        ...(companyId ? { companyId } : {}),
        ...(req.params.id ? { promotionId: req.params.id } : {}),
        ...(from ? { from } : {}), ...(to ? { to } : {}),
      },
      type: QueryTypes.SELECT,
    },
  ).catch(() => []);

  return res.json({
    success: true,
    data: {
      redemptions: Number(totals.redemptions) || 0,
      customers: Number(totals.customers) || 0,
      units_sold: Number(totals.units_sold) || 0,
      original_value: toMajor(asMinor(totals.original_value)),
      discount_granted: toMajor(asMinor(totals.discount_granted)),
      sales_value: toMajor(asMinor(totals.sales_value)),
      average_discount: Number(totals.redemptions) > 0
        ? toMajor(Math.round(asMinor(totals.discount_granted) / Number(totals.redemptions)))
        : 0,
      by_property: byProperty.map((row) => ({
        property_id: row.property_id,
        property_name: row.property_name,
        redemptions: Number(row.redemptions) || 0,
        units_sold: Number(row.units_sold) || 0,
        discount_granted: toMajor(asMinor(row.discount_granted)),
        sales_value: toMajor(asMinor(row.sales_value)),
      })),
    },
  });
});

module.exports = {
  listPromotions, getPromotion, createPromotion, updatePromotion,
  setStatus, previewPromotion, validateDraft, quoteForUnit, promotionAnalytics,
};

const { QueryTypes } = require('sequelize');
const { asMinor } = require('./money');
const { q, insertReturningId } = require('./dialect');
const { STATUS, TRIGGER } = require('./promotions/types');
const { evaluateBasket, priceForUnit } = require('./promotions/evaluate');
const { validatePromotion } = require('./promotions/validate');

/**
 * Where the promotion engine meets the database.
 *
 * shared/src/promotions/ is pure arithmetic over plain objects. This module is
 * the only thing that knows promotions are rows: it loads the candidates for a
 * basket, hands them to the engine, and writes down what the engine decided.
 *
 * ── The split is not cosmetic ───────────────────────────────────────────────
 *
 * It is what makes the preview honest. An administrator testing a campaign
 * against a hypothetical basket on a date three weeks away runs the SAME
 * function a real purchase runs, with different inputs — not a second
 * implementation that agrees with the first until it does not.
 */

/** Bumped when the arithmetic changes in a way that could restate old money. */
const ENGINE_VERSION = '1.0.0';

/**
 * The promotions that could possibly apply to this basket.
 *
 * Narrowed in SQL to what is cheap to narrow — company, status, dates — and
 * left to the engine for everything else. Scope, quantity, combination and
 * eligibility are all in the JSON document, and pushing them into SQL would
 * mean the database and the engine each holding half the rule.
 */
const candidatesFor = async (sequelize, { companyId, at = new Date(), transaction = null }) => {
  const rows = await sequelize.query(
    `SELECT p.id, p.name, p.code, p.trigger_type, p.status, p.starts_at, p.ends_at,
            p.priority, p.stackable, p.customer_message, p.terms,
            v.id AS version_id, v.version, v.config
       FROM ${q(sequelize, 'promotions')} p
       JOIN ${q(sequelize, 'promotion_versions')} v ON v.id = p.current_version_id
      WHERE p.status = :active
        AND (p.company_id = :companyId OR (:companyId IS NULL AND p.company_id IS NULL))
        AND (p.starts_at IS NULL OR p.starts_at <= :at)
        AND (p.ends_at IS NULL OR p.ends_at >= :dayStart)
      ORDER BY p.priority ASC, p.id ASC`,
    {
      replacements: {
        active: STATUS.ACTIVE,
        companyId: companyId ?? null,
        at,
        /**
         * The end-date filter uses the START of the day so a campaign ending
         * "31 October" is still loaded at 22:00 on the 31st. The engine then
         * decides inclusively; this only has to avoid excluding it first.
         */
        dayStart: new Date(new Date(at).setHours(0, 0, 0, 0)),
      },
      type: QueryTypes.SELECT,
      transaction,
    },
  ).catch(() => []);

  return rows.map((row) => {
    let config = {};
    try {
      config = typeof row.config === 'string' ? JSON.parse(row.config) : (row.config || {});
    } catch {
      // A version whose document will not parse is skipped rather than allowed
      // to throw — one broken campaign must not stop every purchase.
      return null;
    }
    return {
      ...config,
      id: Number(row.id),
      version_id: Number(row.version_id),
      version: Number(row.version),
      name: row.name,
      code: row.code,
      trigger: row.trigger_type || TRIGGER.AUTOMATIC,
      status: row.status,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      priority: Number(row.priority),
      stackable: Boolean(row.stackable),
      customer_message: row.customer_message,
      terms: row.terms,
    };
  }).filter(Boolean);
};

/**
 * How much of each campaign has been taken up, for the usage limits.
 *
 * Counted from the redemptions rather than from a counter column, for the
 * reason a counter and a ledger always end up disagreeing — and when they do,
 * neither can be trusted. Only redemptions that still stand are counted.
 */
const usageFor = async (sequelize, { promotionIds, customerId = null, transaction = null }) => {
  if (!promotionIds?.length) return {};

  const rows = await sequelize.query(
    `SELECT promotion_id,
            COUNT(*) AS total_redemptions,
            COALESCE(SUM(units_count), 0) AS units_redeemed,
            SUM(CASE WHEN customer_id = :customerId THEN 1 ELSE 0 END) AS customer_redemptions,
            SUM(CASE WHEN redeemed_at >= :todayStart THEN 1 ELSE 0 END) AS today_redemptions
       FROM ${q(sequelize, 'promotion_redemptions')}
      WHERE promotion_id IN (:ids)
        AND status <> 'RELEASED'
      GROUP BY promotion_id`,
    {
      replacements: {
        ids: promotionIds,
        customerId: customerId ?? -1,
        todayStart: new Date(new Date().setHours(0, 0, 0, 0)),
      },
      type: QueryTypes.SELECT,
      transaction,
    },
  ).catch(() => []);

  return Object.fromEntries(rows.map((row) => [Number(row.promotion_id), {
    total_redemptions: Number(row.total_redemptions) || 0,
    units_redeemed: Number(row.units_redeemed) || 0,
    customer_redemptions: Number(row.customer_redemptions) || 0,
    today_redemptions: Number(row.today_redemptions) || 0,
  }]));
};

/**
 * What a basket costs once the company's live campaigns are taken into account.
 *
 * Writes nothing. This is what the unit picker, the preview and the purchase
 * flow all call; the purchase flow then records the result separately, so a
 * buyer who looks at a price and walks away has consumed nothing.
 */
const quoteBasket = async (sequelize, {
  companyId, basket, buyer = {}, paymentType = 'outright', installmentPlanId = null,
  upfrontPercentage = null, codes = [], resolution = null, at = new Date(), transaction = null,
}) => {
  const promotions = await candidatesFor(sequelize, { companyId, at, transaction });
  if (!promotions.length) {
    const original = (basket.lines || []).reduce(
      (sum, line) => sum + asMinor(line.unit_price_minor) * (Number(line.quantity) || 0), 0,
    );
    return {
      original_minor: original, discount_minor: 0, payable_minor: original,
      applied: [], considered: [], resolution,
    };
  }

  const usage = await usageFor(sequelize, {
    promotionIds: promotions.map((p) => p.id), customerId: buyer.id ?? null, transaction,
  });

  return evaluateBasket(promotions, basket, {
    now: at,
    buyer,
    payment_type: paymentType,
    installment_plan_id: installmentPlanId,
    upfront_percentage: upfrontPercentage,
    codes,
    usage,
    resolution,
  });
};

/** The same, for one unit — what a listing shows. */
const quoteUnit = async (sequelize, { companyId, unit, quantity = 1, at = new Date(), ...rest }) => {
  const promotions = await candidatesFor(sequelize, { companyId, at });
  if (!promotions.length) {
    const price = asMinor(unit.unit_price_minor ?? Math.round(Number(unit.price || 0) * 100));
    return {
      original_minor: price * quantity, discount_minor: 0, payable_minor: price * quantity,
      original_unit_minor: price, promotional_unit_minor: price, applied: [], considered: [],
    };
  }
  const usage = await usageFor(sequelize, {
    promotionIds: promotions.map((p) => p.id), customerId: rest.buyer?.id ?? null,
  });
  return priceForUnit(promotions, unit, { now: at, quantity, usage, ...rest });
};

/**
 * Write down that a purchase received a promotion.
 *
 * ── Every figure is copied, none is referenced ──────────────────────────────
 *
 * FRD 39. The discount, the original, the payable and the per-line breakdown
 * are all written here as they were at this moment. Later editing the campaign,
 * changing the unit's price or improving the engine cannot restate what this
 * buyer was given — which matters most for an instalment purchase, where the
 * buyer goes on paying against these figures for months.
 */
const recordRedemption = async (sequelize, {
  quote, companyId, customerId = null, realtorId = null, propertyId = null,
  invoiceId = null, purchaseRequestId = null, unitsCount = 0,
  status = 'RESERVED', at = new Date(), transaction = null,
}) => {
  const written = [];

  for (const applied of quote.applied || []) {
    /**
     * The breakdown holds the promotion's NAME and TERMS as well as its
     * numbers. A receipt printed in two years has to be able to say what the
     * offer was called, and the campaign may by then have been renamed or
     * archived.
     */
    const breakdown = JSON.stringify({
      name: applied.name,
      code: applied.code,
      benefit_type: applied.benefit_type,
      allocations: applied.allocations,
      perks: applied.perks,
      terms: applied.terms,
      message: applied.message,
      capped: applied.capped,
      claimed_minor: applied.claimed_minor,
      engine_version: ENGINE_VERSION,
    });

    // eslint-disable-next-line no-await-in-loop
    const insertId = await insertReturningId(
      sequelize,
      `INSERT INTO ${q(sequelize, 'promotion_redemptions')}
         (promotion_id, promotion_version_id, company_id, customer_id, realtor_id,
          property_id, invoice_id, purchase_request_id,
          original_minor, discount_minor, payable_minor, units_count,
          breakdown, status, redeemed_at, created_at)
       VALUES
         (:promotionId, :versionId, :companyId, :customerId, :realtorId,
          :propertyId, :invoiceId, :purchaseRequestId,
          :original, :discount, :payable, :units,
          :breakdown, :status, :at, :at)`,
      {
        replacements: {
          promotionId: applied.promotion_id,
          versionId: applied.version_id ?? null,
          companyId: companyId ?? null,
          customerId, realtorId, propertyId, invoiceId, purchaseRequestId,
          original: quote.original_minor,
          discount: applied.discount_minor,
          payable: quote.payable_minor,
          units: unitsCount,
          breakdown,
          status,
          at,
        },
        transaction,
      },
    );
    written.push({ id: insertId, promotion_id: applied.promotion_id, discount_minor: applied.discount_minor });
  }

  return written;
};

/**
 * Confirm or release the redemptions attached to an invoice.
 *
 * A reserved redemption holds a place in the campaign's limits. Confirming it
 * when the purchase stands makes it count; releasing it when the invoice is
 * cancelled or expires hands the allocation back — otherwise a campaign limited
 * to 100 redemptions would be exhausted by 100 abandoned baskets.
 */
const settleRedemptions = async (sequelize, { invoiceId, status, transaction = null }) => {
  if (!invoiceId) return 0;
  /**
   * The release timestamp is decided in JavaScript, not in the SET clause.
   *
   * A CASE that reads the status being assigned in the same statement is the
   * shape that computes differently on MySQL and Postgres — MySQL evaluates
   * SET clauses left to right and sees the new value, Postgres evaluates every
   * clause against the row as it was. Even where the branch reads a bound
   * parameter rather than the column, the lint refuses it on sight, and it is
   * right to: the next person to edit this would not notice the difference.
   */
  const releasedAt = status === 'RELEASED' ? new Date() : null;

  const [, metadata] = await sequelize.query(
    `UPDATE ${q(sequelize, 'promotion_redemptions')}
        SET status = :status,
            released_at = COALESCE(:releasedAt, released_at)
      WHERE invoice_id = :invoiceId AND status = 'RESERVED'`,
    {
      replacements: { status, invoiceId, releasedAt },
      type: QueryTypes.UPDATE,
      transaction,
    },
  );
  return Number(metadata?.rowCount ?? metadata?.affectedRows ?? metadata ?? 0);
};

/**
 * Save a promotion's rules as a NEW version and point the promotion at it.
 *
 * Never updates a version in place, because a version that can change is not a
 * record of what a purchase used the rules were. Editing a draft still writes a
 * version — drafts are cheap, and having one code path means a promotion that
 * was activated cannot be edited by a route that forgot the rule.
 */
const saveVersion = async (sequelize, {
  promotionId, companyId, config, changeNote = null, createdBy = null, transaction = null,
}) => {
  const verdict = validatePromotion({ ...config, name: config.name || 'x' });

  const [existing] = await sequelize.query(
    `SELECT COALESCE(MAX(version), 0) AS highest
       FROM ${q(sequelize, 'promotion_versions')} WHERE promotion_id = :promotionId`,
    { replacements: { promotionId }, type: QueryTypes.SELECT, transaction },
  );
  const version = Number(existing?.highest || 0) + 1;

  /**
   * insertReturningId rather than an INSERT followed by LAST_INSERT_ID().
   *
   * LAST_INSERT_ID() does not exist on Postgres and lastval() is per-connection
   * state that a pooled query can lose. This runs as one statement on both
   * engines, so the id belongs to this insert and no other.
   */
  const versionId = await insertReturningId(
    sequelize,
    `INSERT INTO ${q(sequelize, 'promotion_versions')}
       (promotion_id, company_id, version, config, engine_version, change_note, created_by, created_at)
     VALUES (:promotionId, :companyId, :version, :config, :engine, :note, :createdBy, :now)`,
    {
      replacements: {
        promotionId, companyId: companyId ?? null, version,
        config: JSON.stringify(config),
        engine: ENGINE_VERSION,
        note: changeNote,
        createdBy,
        now: new Date(),
      },
      transaction,
    },
  );

  await sequelize.query(
    `UPDATE ${q(sequelize, 'promotions')}
        SET current_version_id = :versionId, updated_at = :now
      WHERE id = :promotionId`,
    { replacements: { versionId, promotionId, now: new Date() }, type: QueryTypes.UPDATE, transaction },
  );

  return { version, version_id: versionId, validation: verdict };
};

module.exports = {
  ENGINE_VERSION,
  candidatesFor, usageFor,
  quoteBasket, quoteUnit,
  recordRedemption, settleRedemptions,
  saveVersion,
};

const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { buildCrudController, buildCompanyScope, withCompanyAudit } = require('../utils/crudFactory');
const {
  sequelize, InstallmentPlan, InstallmentPlanUnit, InvoicePaymentPlan,
} = require('../models');
const {
  ROUNDING_RULES, SURCHARGE_TYPES, DEFAULT_FEE_TYPES, DEFAULT_FEE_RECURRENCES,
  toMinor, toMajor,
} = require('../../../../shared/src/money');
const { quote } = require('../../../../shared/src/installmentPricing');

const companyScope = (req) => buildCompanyScope(req);

/**
 * Installment plan configuration (FRD 3) and the priced plan list a buyer
 * chooses from (FRD 4.1).
 *
 * Configuring plans is admin-only (FRD 13); READING the priced options is not,
 * because that is the plan picker on the purchase screen and the buyer is the
 * one using it. The routes gate the two differently.
 */

/**
 * Validates and normalises a plan payload.
 *
 * The enums are checked here rather than left to MySQL because an out-of-range
 * ENUM value inserts as '' under a non-strict sql_mode, and a plan with a blank
 * surcharge_type would then price every purchase at base — silently, and only
 * on that one company's plans.
 */
const normalisePlan = (body) => {
  const duration = Math.trunc(Number(body.duration_months));
  if (!Number.isFinite(duration) || duration < 1 || duration > 480) {
    throw Object.assign(new Error('Duration must be a whole number of months between 1 and 480.'), { status: 400 });
  }

  const pick = (value, allowed, field) => {
    const key = String(value ?? allowed[0]).toLowerCase();
    if (!allowed.includes(key)) {
      throw Object.assign(new Error(`${field} must be one of: ${allowed.join(', ')}.`), { status: 400 });
    }
    return key;
  };

  const surchargeType = pick(body.surcharge_type, SURCHARGE_TYPES, 'Surcharge type');
  const defaultFeeType = pick(body.default_fee_type, DEFAULT_FEE_TYPES, 'Default fee type');

  const amount = (value, field) => {
    const number = Number(value ?? 0);
    if (!Number.isFinite(number) || number < 0) {
      throw Object.assign(new Error(`${field} must be zero or more.`), { status: 400 });
    }
    return number;
  };

  const surchargeValue = amount(body.surcharge_value, 'Surcharge value');
  const defaultFeeValue = amount(body.default_fee_value, 'Default fee value');

  // A percentage over 100 is almost always a flat amount typed into the wrong
  // field, and it would price the plan at more than double the property.
  if (surchargeType === 'percentage' && surchargeValue > 100) {
    throw Object.assign(new Error('A percentage surcharge cannot exceed 100%. Use a flat surcharge for a fixed amount.'), { status: 400 });
  }
  if (defaultFeeType === 'percentage' && defaultFeeValue > 100) {
    throw Object.assign(new Error('A percentage default fee cannot exceed 100%. Use a flat fee for a fixed amount.'), { status: 400 });
  }

  const grace = Math.trunc(Number(body.grace_period_days ?? 0));
  if (!Number.isFinite(grace) || grace < 0 || grace > 365) {
    throw Object.assign(new Error('Grace period must be between 0 and 365 days.'), { status: 400 });
  }

  return {
    name: String(body.name || '').trim(),
    duration_months: duration,
    surcharge_type: surchargeType,
    surcharge_value: surchargeType === 'none' ? 0 : surchargeValue,
    rounding_rule: pick(body.rounding_rule, ROUNDING_RULES, 'Rounding rule'),
    grace_period_days: grace,
    default_fee_type: defaultFeeType,
    default_fee_value: defaultFeeType === 'none' ? 0 : defaultFeeValue,
    default_fee_recurrence: pick(body.default_fee_recurrence, DEFAULT_FEE_RECURRENCES, 'Default fee recurrence'),
    ...(body.is_active === undefined ? {} : { is_active: Boolean(body.is_active) }),
  };
};

const installmentPlanCrud = buildCrudController(InstallmentPlan, {
  include: ['unitAssignments'],
  searchFields: ['name'],
  defaultWhere: companyScope,
  scopeWhere: companyScope,
  order: [['duration_months', 'ASC'], ['id', 'ASC']],
  /**
   * company_id is carried through explicitly.
   *
   * withCompanyAudit reads it off the payload it is handed, and normalisePlan
   * returns only the plan's own fields — so passing the normalised payload
   * alone silently dropped it, and a superior admin creating a plan on behalf
   * of a company got a plan belonging to nobody. A plan with no company is
   * offered to nobody, because the quote endpoint matches plans against the
   * property's company.
   */
  beforeCreate: async (req) => withCompanyAudit(req, {
    ...normalisePlan(req.body),
    ...(req.body.company_id != null ? { company_id: req.body.company_id } : {}),
  }),
  /**
   * Editing a plan must not restate an issued invoice (FRD 3.3). It cannot:
   * the terms were snapshotted onto invoice_payment_plans at creation and
   * nothing reads back through installment_plan_id to calculate. So an edit is
   * allowed unconditionally, and only changes what is OFFERED from here on.
   */
  beforeUpdate: async (req) => normalisePlan(req.body),
  /**
   * A plan that has been sold against is provenance for those invoices. It
   * stays; `is_active: false` is how a company stops offering it (FRD 3.1).
   */
  beforeDelete: async (plan) => {
    const inUse = await InvoicePaymentPlan.count({ where: { installment_plan_id: plan.id } });
    if (inUse > 0) {
      throw Object.assign(
        new Error(`This plan has been used on ${inUse} invoice${inUse === 1 ? '' : 's'} and cannot be deleted. `
          + 'Deactivate it instead — existing invoices keep their agreed terms either way.'),
        { status: 409 },
      );
    }
    await InstallmentPlanUnit.destroy({ where: { installment_plan_id: plan.id } });
  },
});

/**
 * The property unit a plan is being assigned to, or priced for.
 *
 * property_units belongs to property-service. Read directly rather than
 * modelled here for the reason invoiceGateway.js gives in reverse: defining a
 * model for another service's table would let this service's
 * sync({ alter: true }) reshape it.
 */
const findPropertyUnit = async (propertyUnitId, companyId) => {
  const rows = await sequelize.query(
    `SELECT pu.id, pu.property_id, pu.name, pu.price, pu.quantity, pu.status,
            p.name AS property_name, p.company_id
       FROM property_units pu
       JOIN properties p ON p.id = pu.property_id AND p.deleted_at IS NULL
      WHERE pu.id = :id
        ${companyId ? 'AND p.company_id = :companyId' : ''}
      LIMIT 1`,
    { replacements: { id: propertyUnitId, companyId: companyId ?? null }, type: QueryTypes.SELECT },
  );
  return rows[0] || null;
};

/** Assigns a plan to one property unit (FRD 3.2). Idempotent. */
const assignPlanToUnit = asyncHandler(async (req, res) => {
  const plan = await InstallmentPlan.findOne({ where: { id: req.params.id, ...companyScope(req) } });
  if (!plan) return res.status(404).json({ message: 'Installment plan not found' });

  const propertyUnitId = Number(req.body.property_unit_id);
  if (!Number.isInteger(propertyUnitId) || propertyUnitId < 1) {
    return res.status(400).json({ message: 'Choose a property unit to assign this plan to.' });
  }

  const unit = await findPropertyUnit(propertyUnitId, plan.company_id);
  if (!unit) {
    return res.status(404).json({ message: 'That property unit does not exist, or belongs to another company.' });
  }

  // findOrCreate over create: the unique index already makes a repeat assign
  // fail, and a 409 for "it is already assigned" would be a worse answer than
  // the assignment the caller asked for.
  const [assignment] = await InstallmentPlanUnit.findOrCreate({
    where: { installment_plan_id: plan.id, property_unit_id: propertyUnitId },
    defaults: { company_id: plan.company_id ?? null },
  });

  res.status(201).json({ data: assignment });
});

const unassignPlanFromUnit = asyncHandler(async (req, res) => {
  const plan = await InstallmentPlan.findOne({ where: { id: req.params.id, ...companyScope(req) } });
  if (!plan) return res.status(404).json({ message: 'Installment plan not found' });

  // Unassigning only stops the plan being OFFERED on that unit from now on.
  // Invoices already issued against it are untouched — they hold their own
  // snapshot of the terms (FRD 3.3).
  const removed = await InstallmentPlanUnit.destroy({
    where: { installment_plan_id: plan.id, property_unit_id: req.params.unitId },
  });
  if (!removed) return res.status(404).json({ message: 'That plan is not assigned to this unit.' });

  res.json({ message: 'Plan unassigned from the unit.' });
});

/** Every plan assigned to one unit, for the admin assignment screen. */
const listPlansForUnit = asyncHandler(async (req, res) => {
  const plans = await InstallmentPlan.findAll({
    where: companyScope(req),
    include: [{
      association: 'unitAssignments',
      where: { property_unit_id: req.params.propertyUnitId },
      required: true,
    }],
    order: [['duration_months', 'ASC']],
  });
  res.json({ data: plans });
});

/**
 * The priced plan list for a purchase (FRD 4.1) plus the outright total to
 * compare it against (FRD 4.2).
 *
 * Every figure a buyer needs is computed here: total after surcharge and
 * rounding, the monthly amount, and the surcharge STATED SEPARATELY so it can
 * never be discovered later buried in a total. The client displays these; it
 * does not derive them, and whatever it sends back at checkout is recomputed
 * from the same function anyway.
 *
 * Inactive plans are excluded — they stay valid on invoices already issued
 * against them but are not offered (FRD 3.1).
 */
const getUnitPurchaseOptions = asyncHandler(async (req, res) => {
  const scope = companyScope(req);
  const unit = await findPropertyUnit(req.params.propertyUnitId, scope.company_id);
  if (!unit) return res.status(404).json({ message: 'Property unit not found' });

  const rawQuantity = req.query.quantity;
  const quantity = rawQuantity === undefined || rawQuantity === '' ? 1 : Number(rawQuantity);
  if (!Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ message: 'Quantity must be a whole number of at least 1.' });
  }

  const unitPriceMinor = toMinor(unit.price);

  const plans = await InstallmentPlan.findAll({
    where: { is_active: true, ...(unit.company_id ? { company_id: unit.company_id } : {}) },
    include: [{ association: 'unitAssignments', where: { property_unit_id: unit.id }, required: true }],
    order: [['duration_months', 'ASC'], ['id', 'ASC']],
  });

  const outright = quote({ unitPriceMinor, quantity, paymentType: 'outright' });

  const asMoney = (minor) => ({ minor, amount: toMajor(minor) });

  res.json({
    data: {
      unit: {
        id: unit.id,
        property_id: unit.property_id,
        property_name: unit.property_name,
        name: unit.name,
        unit_price: Number(unit.price) || 0,
      },
      quantity,
      // FRD 4.2 — shown alongside the plans so the cost of financing is visible.
      outright: {
        payment_type: 'outright',
        base: asMoney(outright.baseMinor),
        total: asMoney(outright.totalMinor),
      },
      // A unit with no assigned plans can only be bought outright (FRD 3.2);
      // an empty array here is that answer, not a missing one.
      installment_plans: plans.map((plan) => {
        const priced = quote({ unitPriceMinor, quantity, paymentType: 'installment', plan });
        return {
          installment_plan_id: plan.id,
          name: plan.name,
          duration_months: priced.durationMonths,
          base: asMoney(priced.baseMinor),
          // Stated explicitly, never folded into the total (FRD 4.1).
          surcharge: {
            ...asMoney(priced.surchargeMinor),
            type: plan.surcharge_type,
            value: Number(plan.surcharge_value) || 0,
          },
          rounding: {
            rule: plan.rounding_rule,
            ...asMoney(priced.roundingAdjustmentMinor),
          },
          total: asMoney(priced.totalMinor),
          monthly: asMoney(priced.perMonthMinor),
          // Differs from `monthly` only when rounding leaves a remainder, which
          // lands on the last schedule (FRD 4).
          final_month: asMoney(priced.finalMonthMinor),
          terms: {
            grace_period_days: plan.grace_period_days,
            default_fee_type: plan.default_fee_type,
            default_fee_value: Number(plan.default_fee_value) || 0,
            default_fee_recurrence: plan.default_fee_recurrence,
          },
        };
      }),
    },
  });
});

module.exports = {
  installmentPlanCrud,
  assignPlanToUnit,
  unassignPlanFromUnit,
  listPlansForUnit,
  getUnitPurchaseOptions,
  findPropertyUnit,
  normalisePlan,
};

const { QueryTypes } = require('sequelize');
const { toMinor, toMajor, asMinor } = require('./money');
const { quote, snapshotOf, buildSchedules, planTerms } = require('./installmentPricing');

/**
 * Creating and regenerating an invoice's payment plan and its schedules.
 *
 * Raw SQL over a passed-in connection, in the manner of notifier.js and
 * invoiceDueDays.js, because BOTH services need to write these rows and neither
 * can own them outright:
 *
 *   property-service  at checkout, in the same transaction as the purchase and
 *                     the invoice — a purchase whose schedules failed to write
 *                     would show a client an invoice with nothing to pay
 *                     against.
 *   finance-service   when an admin edits an unpaid invoice's quantity
 *                     (FRD 6.1) and the whole schedule set is regenerated.
 *
 * One implementation rather than two keeps FRD 4's calculation and FRD 9.1's
 * schedule generation in a single place; the arithmetic itself lives in
 * installmentPricing.js and this file only persists what that returns.
 *
 * Every function takes an explicit `transaction`. None of them commits.
 */

/** The plan template's terms, or null for an outright purchase. */
const loadInstallmentPlan = async (sequelize, planId, transaction = null) => {
  if (!planId) return null;
  const rows = await sequelize.query(
    `SELECT id, name, duration_months, surcharge_type, surcharge_value, rounding_rule,
            grace_period_days, default_fee_type, default_fee_value, default_fee_recurrence,
            is_active, company_id
       FROM installment_plans WHERE id = :id LIMIT 1`,
    { replacements: { id: planId }, type: QueryTypes.SELECT, transaction },
  );
  return rows[0] || null;
};

/** Is this plan offered on this unit? (FRD 3.2 — assignment is per unit.) */
const planIsAssignedToUnit = async (sequelize, planId, propertyUnitId, transaction = null) => {
  const rows = await sequelize.query(
    `SELECT 1 FROM installment_plan_units
      WHERE installment_plan_id = :planId AND property_unit_id = :unitId LIMIT 1`,
    { replacements: { planId, unitId: propertyUnitId }, type: QueryTypes.SELECT, transaction },
  );
  return rows.length > 0;
};

/**
 * Prices a purchase authoritatively and rejects a plan that may not be used.
 *
 * This is the server-side recompute FRD 4 requires: the caller passes what the
 * client CHOSE (unit, quantity, payment type, plan) and never a total, so there
 * is no client-supplied figure to override in the first place.
 *
 * Throws with a `status` so the express error handler surfaces the message.
 */
const priceForPurchase = async (sequelize, {
  propertyUnitId, unitPrice, quantity, paymentType, installmentPlanId,
}, transaction = null) => {
  const type = String(paymentType || 'outright').toLowerCase();
  if (!['outright', 'installment'].includes(type)) {
    throw Object.assign(new Error('Payment type must be outright or installment.'), { status: 400 });
  }

  const unitPriceMinor = toMinor(unitPrice);

  if (type === 'outright') {
    return { plan: null, priced: quote({ unitPriceMinor, quantity, paymentType: 'outright' }) };
  }

  if (!installmentPlanId) {
    throw Object.assign(new Error('Choose an installment plan.'), { status: 400 });
  }

  const plan = await loadInstallmentPlan(sequelize, installmentPlanId, transaction);
  if (!plan) throw Object.assign(new Error('That installment plan no longer exists.'), { status: 400 });

  // Inactive plans stay valid on invoices already issued against them but are
  // not offered for a NEW purchase (FRD 3.1).
  if (!plan.is_active) {
    throw Object.assign(new Error(`"${plan.name}" is no longer offered on this property.`), { status: 409 });
  }

  // The assignment check is authorisation, not validation: without it a buyer
  // could post any plan id and buy a full plot on the 1-month terms configured
  // for a half plot.
  if (!await planIsAssignedToUnit(sequelize, plan.id, propertyUnitId, transaction)) {
    throw Object.assign(
      new Error(`"${plan.name}" is not available on this unit. Choose one of the plans offered for it.`),
      { status: 409 },
    );
  }

  return { plan, priced: quote({ unitPriceMinor, quantity, paymentType: 'installment', plan }) };
};

/** Inserts the schedule rows for a plan, in one statement. */
const insertSchedules = async (sequelize, transaction, { paymentPlanId, invoiceId, companyId, schedules }) => {
  if (!schedules.length) return;

  // One multi-row INSERT rather than a loop: a 24-month plan is 24 round trips
  // inside a transaction that is also holding an inventory lock.
  const values = schedules
    .map((_, index) => `(:planId, :invoiceId, :seq${index}, :due${index}, :principal${index}, :principal${index}, 0, 0, 'upcoming', 'unpaid', :companyId, NOW(), NOW())`)
    .join(', ');

  const replacements = { planId: paymentPlanId, invoiceId, companyId: companyId ?? null };
  schedules.forEach((schedule, index) => {
    replacements[`seq${index}`] = schedule.sequence;
    replacements[`due${index}`] = schedule.due_date.toISOString().slice(0, 10);
    replacements[`principal${index}`] = schedule.principal_minor;
  });

  await sequelize.query(
    `INSERT INTO payment_schedules
       (invoice_payment_plan_id, invoice_id, sequence, due_date,
        principal_minor, principal_outstanding_minor,
        fee_accrued_minor, fee_outstanding_minor,
        timing_status, settlement_status, company_id, created_at, updated_at)
     VALUES ${values}`,
    { replacements, type: QueryTypes.INSERT, transaction },
  );
};

/**
 * Creates the payment plan for an invoice, and its schedules where the purchase
 * is on installments.
 *
 * The plan's terms are SNAPSHOTTED onto the row (FRD 3.3). Nothing downstream
 * reads the template again for this invoice, so an admin editing or retiring
 * the plan tomorrow cannot restate what this client agreed to pay.
 *
 * Returns { paymentPlanId, priced, schedules }.
 */
const createPaymentPlan = async (sequelize, transaction, {
  invoiceId, propertyUnitId, quantity, paymentType, installmentPlanId = null,
  unitPrice, companyId = null, createdBy = null, invoiceDate = null,
  outrightDueDate = null,
}) => {
  const { plan, priced } = await priceForPurchase(sequelize, {
    propertyUnitId, unitPrice, quantity, paymentType, installmentPlanId,
  }, transaction);

  const snapshot = priced.paymentType === 'installment'
    ? snapshotOf(plan)
    : snapshotOf({});

  await sequelize.query(
    `INSERT INTO invoice_payment_plans
       (invoice_id, payment_type, installment_plan_id, property_unit_id, quantity,
        unit_price_minor, base_minor, surcharge_minor, total_minor,
        credit_balance_minor, status,
        snapshot_plan_name, snapshot_duration_months, snapshot_surcharge_type,
        snapshot_surcharge_value, snapshot_rounding_rule, snapshot_grace_period_days,
        snapshot_default_fee_type, snapshot_default_fee_value, snapshot_default_fee_recurrence,
        created_by, company_id, created_at, updated_at)
     VALUES
       (:invoiceId, :paymentType, :installmentPlanId, :propertyUnitId, :quantity,
        :unitPriceMinor, :baseMinor, :surchargeMinor, :totalMinor,
        0, 'active',
        :planName, :duration, :surchargeType,
        :surchargeValue, :roundingRule, :graceDays,
        :feeType, :feeValue, :feeRecurrence,
        :createdBy, :companyId, NOW(), NOW())`,
    {
      replacements: {
        invoiceId,
        paymentType: priced.paymentType,
        installmentPlanId: plan?.id ?? null,
        propertyUnitId: propertyUnitId ?? null,
        quantity: priced.quantity,
        unitPriceMinor: priced.unitPriceMinor,
        baseMinor: priced.baseMinor,
        surchargeMinor: priced.surchargeMinor,
        totalMinor: priced.totalMinor,
        planName: snapshot.snapshot_plan_name,
        duration: snapshot.snapshot_duration_months,
        surchargeType: snapshot.snapshot_surcharge_type,
        surchargeValue: snapshot.snapshot_surcharge_value,
        roundingRule: snapshot.snapshot_rounding_rule,
        graceDays: snapshot.snapshot_grace_period_days,
        feeType: snapshot.snapshot_default_fee_type,
        feeValue: snapshot.snapshot_default_fee_value,
        feeRecurrence: snapshot.snapshot_default_fee_recurrence,
        createdBy,
        companyId,
      },
      type: QueryTypes.INSERT,
      transaction,
    },
  );

  // LAST_INSERT_ID() rather than a lookup by invoice_id: it is per-connection
  // and the transaction pins the connection, so it cannot pick up another
  // request's row.
  const [{ id: paymentPlanId }] = await sequelize.query(
    'SELECT LAST_INSERT_ID() AS id',
    { type: QueryTypes.SELECT, transaction },
  );

  /**
   * An outright purchase gets ONE schedule, not none.
   *
   * FRD 2 calls outright "one obligation", and modelling that obligation as a
   * single row rather than as the absence of rows means allocation, the
   * line-level audit trail (FRD 8.4), the credit balance and the plan lifecycle
   * (FRD 11) all work the same way for both payment types. The alternative —
   * a second code path that derives an outright balance by summing payments —
   * is how the two would drift apart.
   *
   * It carries no grace period and no default fee, since the snapshot for an
   * outright plan is all `none`, so the daily job moves it to DUE and leaves it
   * there.
   */
  const schedules = priced.paymentType === 'installment'
    ? buildSchedules({
      totalMinor: priced.totalMinor,
      durationMonths: priced.durationMonths,
      from: invoiceDate ? new Date(invoiceDate) : new Date(),
    })
    : [{
      sequence: 1,
      due_date: new Date(outrightDueDate || invoiceDate || Date.now()),
      principal_minor: priced.totalMinor,
    }];

  await insertSchedules(sequelize, transaction, {
    paymentPlanId, invoiceId, companyId, schedules,
  });

  return { paymentPlanId, priced, schedules, plan };
};

/**
 * Recalculates an invoice's plan for a new quantity and rebuilds its schedules
 * from scratch (FRD 6.1).
 *
 * Only ever called for an invoice with NO approved payment — the caller checks
 * that, because deleting schedules that allocations point at would orphan the
 * ledger. Reprices from the SNAPSHOT, not the live template, so an edit changes
 * the quantity and nothing else about the agreed terms.
 */
const regeneratePaymentPlan = async (sequelize, transaction, {
  paymentPlanId, quantity, invoiceDate, outrightDueDate = null,
}) => {
  const rows = await sequelize.query(
    `SELECT * FROM invoice_payment_plans WHERE id = :id LIMIT 1 FOR UPDATE`,
    { replacements: { id: paymentPlanId }, type: QueryTypes.SELECT, transaction },
  );
  const existing = rows[0];
  if (!existing) throw Object.assign(new Error('Payment plan not found.'), { status: 404 });

  const priced = quote({
    unitPriceMinor: asMinor(existing.unit_price_minor),
    quantity,
    paymentType: existing.payment_type,
    // The frozen terms (FRD 3.3). planTerms reads the snapshot_* columns.
    plan: existing.payment_type === 'installment' ? existing : null,
  });

  await sequelize.query(
    `UPDATE invoice_payment_plans
        SET quantity = :quantity, base_minor = :baseMinor,
            surcharge_minor = :surchargeMinor, total_minor = :totalMinor,
            updated_at = NOW()
      WHERE id = :id`,
    {
      replacements: {
        id: paymentPlanId,
        quantity: priced.quantity,
        baseMinor: priced.baseMinor,
        surchargeMinor: priced.surchargeMinor,
        totalMinor: priced.totalMinor,
      },
      type: QueryTypes.UPDATE,
      transaction,
    },
  );

  // Safe to delete and rebuild: the caller has established there are no
  // allocations against these schedules, and a partial rewrite would leave a
  // set that no longer sums to the invoice total.
  await sequelize.query(
    'DELETE FROM payment_schedules WHERE invoice_payment_plan_id = :id',
    { replacements: { id: paymentPlanId }, type: QueryTypes.DELETE, transaction },
  );

  const schedules = existing.payment_type === 'installment'
    ? buildSchedules({
      totalMinor: priced.totalMinor,
      durationMonths: planTerms(existing).durationMonths,
      from: invoiceDate ? new Date(invoiceDate) : new Date(),
    })
    : [{
      sequence: 1,
      due_date: new Date(outrightDueDate || invoiceDate || Date.now()),
      principal_minor: priced.totalMinor,
    }];

  await insertSchedules(sequelize, transaction, {
    paymentPlanId,
    invoiceId: existing.invoice_id,
    companyId: existing.company_id,
    schedules,
  });

  return { priced, schedules };
};

/** The plan and its schedules for one invoice, in due order. */
const readPaymentPlan = async (sequelize, invoiceId, { transaction = null, lock = false } = {}) => {
  const plans = await sequelize.query(
    `SELECT * FROM invoice_payment_plans WHERE invoice_id = :invoiceId LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    { replacements: { invoiceId }, type: QueryTypes.SELECT, transaction },
  );
  const plan = plans[0];
  if (!plan) return null;

  const schedules = await sequelize.query(
    `SELECT * FROM payment_schedules
      WHERE invoice_payment_plan_id = :planId
      ORDER BY due_date ASC, sequence ASC${lock ? ' FOR UPDATE' : ''}`,
    { replacements: { planId: plan.id }, type: QueryTypes.SELECT, transaction },
  );

  return { plan, schedules };
};

module.exports = {
  loadInstallmentPlan,
  planIsAssignedToUnit,
  priceForPurchase,
  createPaymentPlan,
  regeneratePaymentPlan,
  readPaymentPlan,
  insertSchedules,
  // Re-exported so callers converting to the older DECIMAL columns do not have
  // to reach into money.js separately.
  toMajor,
};

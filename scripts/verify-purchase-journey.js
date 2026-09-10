#!/usr/bin/env node
/**
 * `npm run verify:purchase` — exercises the purchase and payment journey
 * against a THROWAWAY database.
 *
 * There is no test runner in this repo, and the parts of this feature most
 * likely to be wrong are the parts that only misbehave against real SQL: the
 * allocation ordering, the unique index that makes the daily job idempotent,
 * the row locks that stop an oversell. Asserting those needs a database, so
 * this creates one, runs every service's bootstrap into it, drives the
 * scenarios, and drops it again.
 *
 * It NEVER touches the database in cred.env. The scratch database is named
 * from DB_NAME with a suffix, created and dropped here, and the script refuses
 * to run if that name somehow matches the configured one.
 *
 * Each check maps to a specific acceptance criterion in section 14 of the FRD,
 * named in its output so a failure points at the requirement rather than at a
 * line number.
 */

require('dotenv').config({ path: require('node:path').resolve(__dirname, '../cred.env') });

const { Sequelize, QueryTypes } = require('sequelize');

/**
 * The services migrated into the scratch database, in platform/boot.js's order.
 *
 * Each one has its OWN sequelize instance, and therefore its own connection
 * pool. Every one has to be closed before the database can be dropped — a
 * single pool left open holds a metadata lock and blocks DROP DATABASE
 * indefinitely.
 */
const SERVICE_DIRS = [
  'user-service', 'property-service', 'crm-service', 'finance-service', 'notification-service',
];

/** Closes every service's connection pool. Individually guarded. */
const closeAllPools = async () => {
  for (const dir of SERVICE_DIRS) {
    try {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      const { sequelize } = require(`../services/${dir}/src/models`);
      // eslint-disable-next-line no-await-in-loop
      await sequelize.close();
    } catch { /* never loaded, or already closed */ }
  }
};

const REAL_DB = process.env.DB_NAME || 'realto';
const SCRATCH_DB = `${REAL_DB}_verify_purchase`;

if (SCRATCH_DB === REAL_DB) {
  console.error('Refusing to run: the scratch database name matches the configured one.');
  process.exit(1);
}

const results = [];
let currentSection = '';

const section = (name) => { currentSection = name; console.log(`\n── ${name} ${'─'.repeat(Math.max(60 - name.length, 0))}`); };

const check = (criterion, passed, detail = '') => {
  results.push({ section: currentSection, criterion, passed, detail });
  console.log(`  ${passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${criterion}${detail ? `\n        ${detail}` : ''}`);
};

const adminConnection = () => new Sequelize('', process.env.DB_USER, process.env.DB_PASSWORD, {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  dialect: 'mysql',
  logging: false,
});

/**
 * Drops the scratch database, first killing anything still connected to it.
 *
 * An earlier aborted run can leave a sleeping connection behind, and MySQL then
 * blocks DROP DATABASE on a metadata lock indefinitely — so the NEXT run hangs
 * on startup rather than reporting the original failure. Clearing the
 * connections first makes this script recoverable from its own crashes instead
 * of needing the leftovers cleaned up by hand.
 */
const dropScratchDatabase = async (admin) => {
  const connections = await admin.query('SHOW PROCESSLIST', { type: QueryTypes.SELECT });
  for (const connection of connections) {
    if (connection.db !== SCRATCH_DB) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await admin.query(`KILL ${connection.Id}`);
    } catch { /* it may have finished on its own; the DROP below is the check */ }
  }

  /**
   * Bounded, so a stubborn lock FAILS instead of hanging.
   *
   * The default lock_wait_timeout is a year, and DROP DATABASE waits on a
   * metadata lock for the whole of it. That turned a cosmetic cleanup problem
   * into a script that printed its results and then appeared to freeze — so the
   * wait is capped and the caller reports what happened.
   */
  await admin.query('SET SESSION lock_wait_timeout = 10');
  await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
};

/**
 * Lets fire-and-forget work drain before the pools are closed.
 *
 * Notification dispatch is deliberately not awaited in the services — a failing
 * SMTP host must not roll back a payment — so a late dispatch can still be
 * mid-query when the script finishes. Closing the pool under it makes sequelize
 * reconnect, and the new connection is what holds the lock that blocks the
 * drop.
 */
const settle = (ms = 1500) => new Promise((resolve) => setTimeout(resolve, ms));

const main = async () => {
  // ── the scratch database ───────────────────────────────────────────────────
  const admin = adminConnection();
  await dropScratchDatabase(admin);
  await admin.query(`CREATE DATABASE \`${SCRATCH_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.close();
  console.log(`Scratch database ${SCRATCH_DB} created (${REAL_DB} untouched).`);

  // Every service's config/database.js reads DB_NAME at require time, so this
  // has to be set before any of them are loaded.
  process.env.DB_NAME = SCRATCH_DB;

  // ── migrate ───────────────────────────────────────────────────────────────
  // Same order and mechanism as platform/boot.js: user-service first, because
  // it owns the tables the others read.
  for (const dir of SERVICE_DIRS) {
    process.stdout.write(`Migrating ${dir}... `);
    // eslint-disable-next-line no-await-in-loop, import/no-dynamic-require, global-require
    await require(`../services/${dir}/src/index.js`).bootstrap();
    console.log('done');
  }

  const { sequelize } = require('../services/finance-service/src/models');
  const { toMinor, toMajor, asMinor } = require('../shared/src/money');
  const { createPaymentPlan, readPaymentPlan, regeneratePaymentPlan } = require('../shared/src/paymentPlanGateway');
  const { applyApprovedPayment } = require('../services/finance-service/src/services/allocationService');
  const { availabilityFor, heldQuantity, releaseHold, findContendedInvoices } = require('../shared/src/inventoryGateway');
  const { runScheduleSweep } = require('../services/finance-service/src/utils/scheduleJob');
  const { quote } = require('../shared/src/installmentPricing');

  // ── fixtures ──────────────────────────────────────────────────────────────
  const raw = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  const write = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.INSERT });
  const lastId = async () => (await raw('SELECT LAST_INSERT_ID() AS id'))[0].id;

  await write(`INSERT INTO companies (name, slug, email, status, created_at, updated_at)
               VALUES ('Verify Estates', 'verify-estates', 'verify@example.com', 'active', NOW(), NOW())`);
  const companyId = await lastId();

  const makeUser = async (name, email, type) => {
    await write(
      `INSERT INTO users (name, email, password, type, is_active, company_id, created_at, updated_at)
       VALUES (:name, :email, 'x', :type, 1, :companyId, NOW(), NOW())`,
      { name, email, type, companyId },
    );
    return lastId();
  };
  const clientA = await makeUser('Client A', 'a@example.com', 'client');
  const clientB = await makeUser('Client B', 'b@example.com', 'client');
  await makeUser('Admin', 'admin@example.com', 'admin');

  await write(
    `INSERT INTO properties (name, status, approval_status, company_id, created_at, updated_at)
     VALUES ('GPT, Lekki', 'available', 'approved', :companyId, NOW(), NOW())`,
    { companyId },
  );
  const propertyId = await lastId();

  const makeUnit = async (name, price, quantity) => {
    await write(
      `INSERT INTO property_units (property_id, name, price, status, quantity, created_at, updated_at)
       VALUES (:propertyId, :name, :price, 'available', :quantity, NOW(), NOW())`,
      { propertyId, name, price, quantity },
    );
    return lastId();
  };
  // FRD 3.2's worked example.
  const fullPlot = await makeUnit('Full plot', 12000000, 5);
  const halfPlot = await makeUnit('Half plot', 6000000, 20);

  const makePlan = async (attrs) => {
    await write(
      `INSERT INTO installment_plans
         (name, duration_months, surcharge_type, surcharge_value, rounding_rule,
          grace_period_days, default_fee_type, default_fee_value, default_fee_recurrence,
          is_active, company_id, created_at, updated_at)
       VALUES (:name, :duration, :surchargeType, :surchargeValue, :roundingRule,
               :grace, :feeType, :feeValue, :feeRecurrence, 1, :companyId, NOW(), NOW())`,
      { companyId, ...attrs },
    );
    return lastId();
  };
  const assign = (planId, unitId) => write(
    `INSERT INTO installment_plan_units (installment_plan_id, property_unit_id, company_id, created_at)
     VALUES (:planId, :unitId, :companyId, NOW())`,
    { planId, unitId, companyId },
  );

  const plan6 = await makePlan({
    name: '6-month plan', duration: 6, surchargeType: 'none', surchargeValue: 0,
    roundingRule: 'none', grace: 7, feeType: 'percentage', feeValue: 5, feeRecurrence: 'once',
  });
  const plan3 = await makePlan({
    name: '3-month plan', duration: 3, surchargeType: 'percentage', surchargeValue: 2,
    roundingRule: 'up_to_1000', grace: 0, feeType: 'flat', feeValue: 25000, feeRecurrence: 'monthly',
  });
  await assign(plan6, halfPlot);
  await assign(plan3, fullPlot);

  let invoiceSeq = 0;
  const makeInvoice = async (clientId, amount) => {
    invoiceSeq += 1;
    const ref = `INV-${String(invoiceSeq).padStart(4, '0')}`;
    await write(
      `INSERT INTO invoices (invoice_id, client_id, property_id, amount, due_date, status,
                             discount, created_by, company_id, created_at)
       VALUES (:ref, :clientId, :propertyId, :amount, DATE_ADD(NOW(), INTERVAL 30 DAY), 'sent',
               0, :clientId, :companyId, NOW())`,
      { ref, clientId, propertyId, amount, companyId },
    );
    return { id: await lastId(), ref };
  };

  /** Creates an invoice with its payment plan, the way checkout does. */
  const purchase = async ({ clientId, unitId, unitPrice, quantity, paymentType, planId = null }) => {
    const priced = quote({
      unitPriceMinor: toMinor(unitPrice),
      quantity,
      paymentType,
      plan: planId ? (await raw('SELECT * FROM installment_plans WHERE id = :id', { id: planId }))[0] : null,
    });
    const invoice = await makeInvoice(clientId, toMajor(priced.totalMinor));
    const transaction = await sequelize.transaction();
    const created = await createPaymentPlan(sequelize, transaction, {
      invoiceId: invoice.id,
      propertyUnitId: unitId,
      quantity,
      paymentType,
      installmentPlanId: planId,
      unitPrice,
      companyId,
      createdBy: clientId,
      invoiceDate: new Date(),
      outrightDueDate: new Date(Date.now() + 30 * 86400000),
    });
    await transaction.commit();
    return { invoice, ...created };
  };

  // ════════════════════════════════════════════════════════════════════════════
  section('Calculation (FRD 4, 14)');

  {
    const { invoice, priced } = await purchase({
      clientId: clientA, unitId: fullPlot, unitPrice: 12000000, quantity: 1,
      paymentType: 'installment', planId: plan3,
    });
    // 12,000,000 + 2% = 12,240,000, already on a 1,000 boundary.
    check('Surcharge is computed and stated separately from the total',
      priced.surchargeMinor === toMinor(240000) && priced.baseMinor === toMinor(12000000),
      `base ${toMajor(priced.baseMinor)}, surcharge ${toMajor(priced.surchargeMinor)}, total ${toMajor(priced.totalMinor)}`);

    const { schedules } = await readPaymentPlan(sequelize, invoice.id);
    const sum = schedules.reduce((acc, s) => acc + asMinor(s.principal_minor), 0);
    check('Schedules sum exactly to the invoice total',
      sum === priced.totalMinor,
      `${schedules.length} schedules summing to ${toMajor(sum)} against a total of ${toMajor(priced.totalMinor)}`);
  }

  {
    // A total that does NOT divide evenly, to put the remainder on the last one.
    const odd = await makePlan({
      name: 'awkward', duration: 7, surchargeType: 'percentage', surchargeValue: 3.33,
      roundingRule: 'nearest_100', grace: 5, feeType: 'none', feeValue: 0, feeRecurrence: 'once',
    });
    await assign(odd, halfPlot);
    const { invoice, priced } = await purchase({
      clientId: clientA, unitId: halfPlot, unitPrice: 6000000, quantity: 3,
      paymentType: 'installment', planId: odd,
    });
    const { schedules } = await readPaymentPlan(sequelize, invoice.id);
    const amounts = schedules.map((s) => asMinor(s.principal_minor));
    const sum = amounts.reduce((a, b) => a + b, 0);
    const remainderOnLast = amounts[amounts.length - 1] >= amounts[0];
    check('Rounding remainder lands on the FINAL schedule, and the set still sums exactly',
      sum === priced.totalMinor && remainderOnLast,
      `${amounts.slice(0, 2).map(toMajor).join(', ')}, ... , ${toMajor(amounts[amounts.length - 1])} = ${toMajor(sum)}`);
    await releaseHold(sequelize, { invoiceId: invoice.id, reason: 'fixture cleanup' });
  }

  {
    // FRD 3.2 / 14: a plan configured for one unit must not be usable on another.
    let rejected = false;
    let message = '';
    try {
      await purchase({
        clientId: clientA, unitId: fullPlot, unitPrice: 12000000, quantity: 1,
        paymentType: 'installment', planId: plan6, // assigned to the HALF plot
      });
    } catch (error) { rejected = true; message = error.message; }
    check('A plan not assigned to the chosen unit is rejected server-side',
      rejected, message);
  }

  // ════════════════════════════════════════════════════════════════════════════
  section('Payments and allocation (FRD 8, 14)');

  let scenarioInvoice;
  {
    // FRD 8.1 verbatim: 6,000,000 half plot on the 6-month plan, then four
    // payments within month one totalling 4,700,000.
    const purchased = await purchase({
      clientId: clientA, unitId: halfPlot, unitPrice: 6000000, quantity: 1,
      paymentType: 'installment', planId: plan6,
    });
    scenarioInvoice = purchased.invoice;

    const { schedules: initial } = await readPaymentPlan(sequelize, scenarioInvoice.id);
    check('A 6,000,000 purchase on a 6-month plan generates six 1,000,000 schedules',
      initial.length === 6 && initial.every((s) => asMinor(s.principal_minor) === toMinor(1000000)),
      `${initial.length} schedules of ${initial.map((s) => toMajor(s.principal_minor)).join(', ')}`);

    for (const amount of [500000, 200000, 1000000, 3000000]) {
      // eslint-disable-next-line no-await-in-loop
      await applyApprovedPayment({
        invoiceId: scenarioInvoice.id,
        amountMinor: toMinor(amount),
        paymentMethod: 'bank_transfer',
        reference: `VERIFY-${amount}`,
        companyId,
      });
    }

    const { plan, schedules } = await readPaymentPlan(sequelize, scenarioInvoice.id);
    const paidCount = schedules.filter((s) => s.settlement_status === 'paid').length;
    const fifth = schedules.find((s) => s.sequence === 5);
    const fifthPaid = toMinor(1000000) - asMinor(fifth.principal_outstanding_minor);

    check('The FRD 8.1 scenario resolves to schedules 1-4 paid and schedule 5 at 700,000',
      paidCount === 4 && fifth.settlement_status === 'partially_paid' && fifthPaid === toMinor(700000),
      `${paidCount} paid; schedule 5 is ${fifth.settlement_status} with ${toMajor(fifthPaid)} paid of 1,000,000`);

    check('Multiple payments in one month allocate oldest-schedule-first',
      schedules.slice(0, 4).every((s) => s.settlement_status === 'paid')
        && schedules[5].settlement_status === 'unpaid',
      `settlement order: ${schedules.map((s) => s.settlement_status).join(' | ')}`);

    const allocations = await raw(
      `SELECT pa.invoice_payment_id, ps.sequence, pa.principal_minor, pa.fee_minor
         FROM payment_allocations pa JOIN payment_schedules ps ON ps.id = pa.payment_schedule_id
        WHERE pa.invoice_id = :id ORDER BY pa.id`,
      { id: scenarioInvoice.id },
    );
    const allocatedTotal = allocations.reduce((sum, a) => sum + asMinor(a.principal_minor) + asMinor(a.fee_minor), 0);
    const distinctPayments = new Set(allocations.map((a) => a.invoice_payment_id)).size;
    check('Every allocation is traceable to its source transaction (FRD 8.4)',
      allocations.length > 0 && distinctPayments === 4 && allocatedTotal === toMinor(4700000),
      `${allocations.length} lines across ${distinctPayments} payments totalling ${toMajor(allocatedTotal)}`);

    check('Invoice status reflects part payment',
      (await raw('SELECT status FROM invoices WHERE id = :id', { id: scenarioInvoice.id }))[0].status === 'partially_paid',
      `plan status is ${plan.status}`);
  }

  {
    // FRD 8.2 / 14: surplus beyond every schedule becomes a flagged credit balance.
    const purchased = await purchase({
      clientId: clientB, unitId: halfPlot, unitPrice: 6000000, quantity: 1,
      paymentType: 'outright',
    });
    const result = await applyApprovedPayment({
      invoiceId: purchased.invoice.id,
      amountMinor: toMinor(6500000), // 500,000 more than owed
      paymentMethod: 'bank_transfer',
      reference: 'VERIFY-OVERPAY',
      companyId,
    });
    const { plan } = await readPaymentPlan(sequelize, purchased.invoice.id);
    check('Overpayment beyond the final schedule records a credit balance and flags it',
      asMinor(plan.credit_balance_minor) === toMinor(500000) && plan.credit_balance_flagged_at != null,
      `credit balance ${toMajor(plan.credit_balance_minor)}, flagged at ${plan.credit_balance_flagged_at}`);
    check('The overpaid amount is not silently clamped away',
      result.appliedMinor === toMinor(6000000) && result.creditBalanceMinor === toMinor(500000),
      `applied ${toMajor(result.appliedMinor)}, surplus ${toMajor(result.creditBalanceMinor)}`);
    await releaseHold(sequelize, { invoiceId: purchased.invoice.id, reason: 'fixture cleanup' });
  }

  // ════════════════════════════════════════════════════════════════════════════
  section('Inventory holding (FRD 10, 14)');

  {
    const before = await availabilityFor(sequelize, fullPlot);
    const purchased = await purchase({
      clientId: clientB, unitId: fullPlot, unitPrice: 12000000, quantity: 2,
      paymentType: 'installment', planId: plan3,
    });
    const after = await availabilityFor(sequelize, fullPlot);
    check('Creating an invoice does not reduce availability (FRD 10.1)',
      after.available === before.available,
      `availability stayed at ${after.available} after an invoice for 2 units`);

    await applyApprovedPayment({
      invoiceId: purchased.invoice.id,
      amountMinor: toMinor(100),
      paymentMethod: 'bank_transfer',
      reference: 'VERIFY-ANY',
      companyId,
    });
    const held = await availabilityFor(sequelize, fullPlot);
    check('An approved payment reduces availability by the FULL invoiced quantity under ANY_PAYMENT',
      held.available === before.available - 2 && held.held === 2,
      `availability ${before.available} -> ${held.available}; ${held.held} held for an invoice of 2`);
  }

  {
    // FRD 10.2 THRESHOLD_PERCENTAGE: nothing is held until the threshold is met.
    await write(
      `INSERT INTO settings (\`key\`, \`value\`, \`group\`, company_id, created_at)
       VALUES ('inventory_hold_policy', 'threshold_percentage', 'inventory', :companyId, NOW()),
              ('inventory_hold_threshold_percentage', '50', 'inventory', :companyId, NOW())`,
      { companyId },
    );

    const thresholdUnit = await makeUnit('Flat', 4000000, 4);
    const purchased = await purchase({
      clientId: clientA, unitId: thresholdUnit, unitPrice: 4000000, quantity: 1,
      paymentType: 'outright',
    });

    await applyApprovedPayment({
      invoiceId: purchased.invoice.id,
      amountMinor: toMinor(1000000), // 25% — under the threshold
      paymentMethod: 'bank_transfer',
      reference: 'VERIFY-UNDER',
      companyId,
    });
    const under = await availabilityFor(sequelize, thresholdUnit);
    check('A threshold policy does NOT hold until the threshold is met',
      under.available === 4 && under.held === 0,
      `25% paid: availability ${under.available}, held ${under.held}`);

    await applyApprovedPayment({
      invoiceId: purchased.invoice.id,
      amountMinor: toMinor(1200000), // cumulative 55% — over the threshold
      paymentMethod: 'bank_transfer',
      reference: 'VERIFY-OVER',
      companyId,
    });
    const over = await availabilityFor(sequelize, thresholdUnit);
    check('The hold triggers once CUMULATIVE approved payments reach the threshold',
      over.available === 3 && over.held === 1,
      `55% paid cumulatively: availability ${over.available}, held ${over.held}`);

    await sequelize.query('DELETE FROM settings WHERE `group` = \'inventory\' AND company_id = :companyId',
      { replacements: { companyId }, type: QueryTypes.DELETE });
  }

  {
    // FRD 10.3's worked example: 20 available, A holds an unpaid invoice for 10,
    // B pays for 15, and A must be notified without being cancelled.
    const unit = await makeUnit('Contention plot', 1000000, 20);
    const invoiceA = await purchase({
      clientId: clientA, unitId: unit, unitPrice: 1000000, quantity: 10, paymentType: 'outright',
    });
    const invoiceB = await purchase({
      clientId: clientB, unitId: unit, unitPrice: 1000000, quantity: 15, paymentType: 'outright',
    });

    const result = await applyApprovedPayment({
      invoiceId: invoiceB.invoice.id,
      amountMinor: toMinor(15000000),
      paymentMethod: 'bank_transfer',
      reference: 'VERIFY-CONTENTION',
      companyId,
    });

    const state = await availabilityFor(sequelize, unit);
    check('Client B paying for 15 of 20 leaves 5 available',
      state.available === 5, `availability is ${state.available}`);

    const contendedIds = (result.contended || []).map((c) => c.id);
    check("Client A's undercut invoice is identified for notification (FRD 10.3)",
      contendedIds.includes(invoiceA.invoice.id),
      `contended invoices: ${contendedIds.join(', ') || 'none'}`);

    const stillOpen = (await raw('SELECT status FROM invoices WHERE id = :id', { id: invoiceA.invoice.id }))[0];
    check("Client A's invoice is NOT auto-cancelled", stillOpen.status === 'sent',
      `status remains "${stillOpen.status}"`);

    // FRD 10.4: approving A's payment now would oversell, and must be blocked.
    let blocked = false;
    let blockMessage = '';
    try {
      await applyApprovedPayment({
        invoiceId: invoiceA.invoice.id,
        amountMinor: toMinor(10000000),
        paymentMethod: 'bank_transfer',
        reference: 'VERIFY-OVERSELL',
        companyId,
      });
    } catch (error) { blocked = true; blockMessage = error.message; }
    check('Approving a payment that would oversell is blocked (FRD 10.4)',
      blocked, blockMessage);

    const afterBlock = await availabilityFor(sequelize, unit);
    const paymentsOnA = await raw(
      "SELECT COUNT(*) n FROM invoice_payments WHERE invoice_id = :id AND status = 'completed'",
      { id: invoiceA.invoice.id },
    );
    check('The blocked approval rolled back entirely — no payment, no negative inventory',
      afterBlock.available === 5 && Number(paymentsOnA[0].n) === 0,
      `availability ${afterBlock.available}, payments recorded against A: ${paymentsOnA[0].n}`);

    // FRD 6.1 / 10.3: the admin reduces A's invoice to what is available.
    const transaction = await sequelize.transaction();
    const { priced } = await regeneratePaymentPlan(sequelize, transaction, {
      paymentPlanId: invoiceA.paymentPlanId,
      quantity: 5,
      invoiceDate: new Date(),
      outrightDueDate: new Date(),
    });
    await transaction.commit();
    check('An admin can reduce the invoice quantity, and totals recalculate (FRD 6.1)',
      priced.totalMinor === toMinor(5000000),
      `total repriced to ${toMajor(priced.totalMinor)} for 5 units`);

    const allowed = await applyApprovedPayment({
      invoiceId: invoiceA.invoice.id,
      amountMinor: toMinor(5000000),
      paymentMethod: 'bank_transfer',
      reference: 'VERIFY-REDUCED',
      companyId,
    });
    check('The reduced invoice can then be paid and held',
      allowed.hold?.held === true && (await availabilityFor(sequelize, unit)).available === 0,
      `hold placed for ${allowed.hold?.quantity} units; availability now 0`);
  }

  // ════════════════════════════════════════════════════════════════════════════
  section('Schedules, grace and default (FRD 9, 14)');

  {
    // Backdate the FRD 8.1 invoice's unpaid schedules so grace has elapsed on
    // schedule 5, whose plan carries a 7-day grace and a 5% one-off fee.
    await sequelize.query(
      `UPDATE payment_schedules
          SET due_date = DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        WHERE invoice_id = :id AND sequence = 5`,
      { replacements: { id: scenarioInvoice.id }, type: QueryTypes.UPDATE },
    );

    const first = await runScheduleSweep(new Date());
    const afterFirst = (await raw(
      'SELECT * FROM payment_schedules WHERE invoice_id = :id AND sequence = 5',
      { id: scenarioInvoice.id },
    ))[0];

    // 5% of the 300,000 still outstanding on schedule 5.
    check('Grace elapsing applies the default fee automatically, with no admin action (FRD 9.3)',
      afterFirst.timing_status === 'overdue' && asMinor(afterFirst.fee_outstanding_minor) === toMinor(15000),
      `timing ${afterFirst.timing_status}, fee ${toMajor(afterFirst.fee_outstanding_minor)} (5% of 300,000 outstanding)`);

    const second = await runScheduleSweep(new Date());
    const afterSecond = (await raw(
      'SELECT * FROM payment_schedules WHERE invoice_id = :id AND sequence = 5',
      { id: scenarioInvoice.id },
    ))[0];
    const applications = await raw(
      'SELECT COUNT(*) n FROM schedule_fee_applications WHERE payment_schedule_id = :id',
      { id: afterFirst.id },
    );
    check('Running the daily job twice does not apply the fee twice (FRD 9.4)',
      asMinor(afterSecond.fee_outstanding_minor) === asMinor(afterFirst.fee_outstanding_minor)
        && Number(applications[0].n) === 1 && second.feesApplied === 0,
      `fee still ${toMajor(afterSecond.fee_outstanding_minor)}; ${applications[0].n} application row; `
        + `second run applied ${second.feesApplied} fees (first run applied ${first.feesApplied})`);

    const plan = (await raw(
      'SELECT status FROM invoice_payment_plans WHERE invoice_id = :id', { id: scenarioInvoice.id },
    ))[0];
    check('A plan with an overdue schedule moves to IN_DEFAULT (FRD 11)',
      plan.status === 'in_default', `plan status is ${plan.status}`);

    /**
     * FRD 8.2 / 9.3: pay exactly the outstanding PRINCIPAL and watch where it
     * lands. Because fees settle first, the 300,000 clears the 15,000 fee and
     * then 285,000 of principal — leaving 15,000 of PRINCIPAL outstanding, not
     * the fee. Getting this the wrong way round is the whole reason the
     * ordering is asserted rather than assumed.
     */
    const payable = asMinor(afterSecond.principal_outstanding_minor) + asMinor(afterSecond.fee_outstanding_minor);
    const principalBefore = asMinor(afterSecond.principal_outstanding_minor);
    const feeBefore = asMinor(afterSecond.fee_outstanding_minor);
    await applyApprovedPayment({
      invoiceId: scenarioInvoice.id,
      amountMinor: principalBefore,
      paymentMethod: 'bank_transfer',
      reference: 'VERIFY-PRINCIPAL-ONLY',
      companyId,
    });
    const partial = (await raw(
      'SELECT * FROM payment_schedules WHERE id = :id', { id: afterFirst.id },
    ))[0];
    check('Fees settle before principal within a schedule (FRD 8.2)',
      asMinor(partial.fee_outstanding_minor) === 0
        && asMinor(partial.principal_outstanding_minor) === feeBefore,
      `paying ${toMajor(principalBefore)} against ${toMajor(principalBefore)} principal + `
        + `${toMajor(feeBefore)} fee cleared the fee first, leaving `
        + `${toMajor(partial.principal_outstanding_minor)} of principal`);

    check('A part-settled schedule stays short of PAID while anything is outstanding',
      partial.settlement_status === 'partially_paid',
      `settlement ${partial.settlement_status} with ${toMajor(partial.principal_outstanding_minor)} still owing`);

    await applyApprovedPayment({
      invoiceId: scenarioInvoice.id,
      amountMinor: asMinor(partial.principal_outstanding_minor),
      paymentMethod: 'bank_transfer',
      reference: 'VERIFY-REMAINDER',
      companyId,
    });
    const settled = (await raw('SELECT * FROM payment_schedules WHERE id = :id', { id: afterFirst.id }))[0];
    check('A schedule reaches PAID only once principal and accrued fees are both settled',
      settled.settlement_status === 'paid' && asMinor(settled.fee_outstanding_minor) === 0,
      `settlement ${settled.settlement_status}, payable was ${toMajor(payable)}`);

    const recovered = (await raw(
      'SELECT status FROM invoice_payment_plans WHERE invoice_id = :id', { id: scenarioInvoice.id },
    ))[0];
    check('IN_DEFAULT is recoverable — settling the overdue schedule returns the plan to ACTIVE (FRD 11)',
      recovered.status === 'active', `plan status is now ${recovered.status}`);
  }

  {
    /**
     * The timing progression itself, asserted date by date (FRD 9.2).
     *
     * The scenario above proves OVERDUE is reached and the fee bites; this
     * pins the three transitions before it, which a single backdated schedule
     * cannot show. Driven through the job's own pure function so the dates are
     * exact rather than approximated by backdating rows.
     */
    const { timingStatusFor, highestFeePeriod } = require('../services/finance-service/src/utils/scheduleJob');
    const due = new Date(Date.UTC(2026, 5, 15));
    const on = (days) => new Date(Date.UTC(2026, 5, 15 + days));
    const graced = { due_date: due };
    const terms7 = { gracePeriodDays: 7, defaultFeeRecurrence: 'once' };

    check('Timing status progresses UPCOMING -> DUE -> IN_GRACE -> OVERDUE on the correct dates',
      timingStatusFor(graced, terms7, on(-1)) === 'upcoming'
        && timingStatusFor(graced, terms7, due) === 'due'
        && timingStatusFor(graced, terms7, on(1)) === 'in_grace'
        && timingStatusFor(graced, terms7, on(7)) === 'in_grace'
        && timingStatusFor(graced, terms7, on(8)) === 'overdue',
      'day -1 upcoming, due date DUE, days 1-7 IN_GRACE (7-day grace), day 8 OVERDUE');

    const terms0 = { gracePeriodDays: 0, defaultFeeRecurrence: 'once' };
    check('A zero-day grace period is not a one-day one',
      timingStatusFor(graced, terms0, due) === 'due'
        && timingStatusFor(graced, terms0, on(1)) === 'overdue',
      'with no grace configured the schedule goes DUE -> OVERDUE the next day');

    check('A ONCE default fee triggers a single period however long it stays overdue',
      highestFeePeriod(graced, terms0, on(1)) === 0
        && highestFeePeriod(graced, terms0, on(400)) === 0,
      'period 0 on day 1, still period 0 after 400 days');

    const monthly = { gracePeriodDays: 7, defaultFeeRecurrence: 'monthly' };
    check('A MONTHLY default fee triggers a further period every 30 days',
      highestFeePeriod(graced, monthly, on(7)) === -1
        && highestFeePeriod(graced, monthly, on(8)) === 0
        && highestFeePeriod(graced, monthly, on(38)) === 1
        && highestFeePeriod(graced, monthly, on(98)) === 3,
      'nothing within grace; period 0 at day 8, period 1 thirty days later, period 3 by day 98');
  }

  {
    // FRD 8.3: paying ahead stops a schedule ever entering DUE or OVERDUE.
    const purchased = await purchase({
      clientId: clientB, unitId: halfPlot, unitPrice: 6000000, quantity: 1,
      paymentType: 'installment', planId: plan6,
    });
    await applyApprovedPayment({
      invoiceId: purchased.invoice.id,
      amountMinor: toMinor(6000000),
      paymentMethod: 'bank_transfer',
      reference: 'VERIFY-EARLY',
      companyId,
    });
    await sequelize.query(
      `UPDATE payment_schedules SET due_date = DATE_SUB(CURDATE(), INTERVAL 60 DAY) WHERE invoice_id = :id`,
      { replacements: { id: purchased.invoice.id }, type: QueryTypes.UPDATE },
    );
    await runScheduleSweep(new Date());
    const schedules = await raw(
      'SELECT timing_status, settlement_status, fee_outstanding_minor FROM payment_schedules WHERE invoice_id = :id',
      { id: purchased.invoice.id },
    );
    check('Early settlement in month one stops every schedule entering DUE or OVERDUE (FRD 8.3)',
      schedules.every((s) => s.settlement_status === 'paid' && s.timing_status === 'upcoming'
        && asMinor(s.fee_outstanding_minor) === 0),
      `all ${schedules.length} schedules paid and still "upcoming", with no fees, despite being 60 days past due`);

    const plan = (await raw(
      'SELECT status FROM invoice_payment_plans WHERE invoice_id = :id', { id: purchased.invoice.id },
    ))[0];
    check('A fully settled plan is COMPLETED (FRD 11)', plan.status === 'completed', `plan status ${plan.status}`);
  }

  // ════════════════════════════════════════════════════════════════════════════
  section('Notifications (FRD 12, 14)');

  {
    const { resolveNotificationConfig, PLATFORM_DEFAULTS } = require('../shared/src/notificationConfig');
    const seeded = await raw('SELECT COUNT(*) n FROM notification_configs WHERE company_id IS NULL');
    check('The platform default matrix is seeded',
      Number(seeded[0].n) === Object.keys(PLATFORM_DEFAULTS).length,
      `${seeded[0].n} platform rows for ${Object.keys(PLATFORM_DEFAULTS).length} events`);

    const platform = await resolveNotificationConfig(sequelize, companyId);
    check('A company with no configuration of its own falls back to the platform set',
      platform('schedule_overdue').admin === true && platform('invoice_created').realtor === true,
      'schedule_overdue notifies admins, invoice_created notifies the realtor');

    // One company row, deliberately narrow, to prove the override REPLACES
    // rather than merges (FRD 12.1).
    await write(
      `INSERT INTO notification_configs
         (company_id, event_key, enabled, notify_client, notify_realtor, notify_admin, channel, created_at, updated_at)
       VALUES (:companyId, 'schedule_overdue', 1, 1, 0, 0, 'in_app', NOW(), NOW())`,
      { companyId },
    );
    const overridden = await resolveNotificationConfig(sequelize, companyId);
    check('A company configuration fully overrides the platform set where present (FRD 12.1)',
      overridden('schedule_overdue').realtor === false && overridden('schedule_overdue').admin === false,
      'the company row wins: realtor and admin are off despite the platform default having them on');
    check('Resolution is per-company, not per-event — omitted events do not inherit',
      overridden('invoice_created').enabled === false,
      'invoice_created, absent from the company set, is off rather than falling back');

    const notifications = await raw(
      'SELECT type, COUNT(*) n FROM notifications GROUP BY type ORDER BY n DESC',
    );
    check('Journey events actually dispatched in-app notifications',
      notifications.length > 0,
      notifications.map((r) => `${r.type} x${r.n}`).join(', ') || 'none');
  }

  // ════════════════════════════════════════════════════════════════════════════
  section('Permissions (out of the box)');

  {
    /**
     * The default permission catalogue has to exist on a fresh database with no
     * manual step. It used to be seeded only by `npm run seed`, so a new
     * deployment came up with an empty `permissions` table — which meant every
     * permission check either failed or was avoided in favour of a role check.
     *
     * This database has had nothing run against it but the services' own
     * bootstrap, which is exactly the state a new deployment boots into.
     */
    const catalogue = require('../services/user-service/src/migrations/permissionCatalog');

    const [counts] = await raw(
      `SELECT (SELECT COUNT(*) FROM permissions) AS permissions,
              (SELECT COUNT(*) FROM roles) AS roles,
              (SELECT COUNT(*) FROM role_permissions) AS links`,
    );
    check('Permissions and roles are seeded by bootstrap alone, with no `npm run seed`',
      Number(counts.permissions) === catalogue.PERMISSIONS.length
        && Number(counts.roles) === catalogue.ROLES.length
        && Number(counts.links) > 0,
      `${counts.permissions} permissions, ${counts.roles} roles, ${counts.links} role→permission links`);

    const heldBy = async (roleName) => (await raw(
      `SELECT p.name FROM roles r
         JOIN role_permissions rp ON rp.role_id = r.id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE r.name = :roleName`,
      { roleName },
    )).map((row) => row.name);

    const superior = await heldBy('superior_admin');
    check('The platform admin role holds every permission in the catalogue',
      superior.length === catalogue.PERMISSIONS.length,
      `${superior.length}/${catalogue.PERMISSIONS.length}`);

    const admin = await heldBy('admin');
    const journeyPermissions = [
      'properties.units.manage', 'properties.installment-plans.manage',
      'finance.installment-plans.view', 'finance.installment-plans.manage',
      'finance.payment-schedules.view', 'finance.payment-schedules.manage',
      'finance.purchase-notifications.manage',
    ];
    check('A company admin holds the purchase-journey permissions',
      journeyPermissions.every((name) => admin.includes(name)),
      `missing: ${journeyPermissions.filter((n) => !admin.includes(n)).join(', ') || 'none'}`);

    const productManager = await heldBy('product_manager');
    check('A product manager can set allowable plans without defining their terms',
      productManager.includes('properties.units.manage')
        && productManager.includes('properties.installment-plans.manage')
        && !productManager.includes('finance.installment-plans.manage'),
      'the inventory decision is theirs; the finance terms are not');

    const client = await heldBy('client');
    check('A client holds none of the purchase-journey permissions',
      !client.some((name) => journeyPermissions.includes(name)),
      `client holds: ${client.join(', ')}`);

    /**
     * The seeder runs on EVERY boot, so the property that matters is that it
     * does not reassert defaults over an administrator's customisation.
     */
    const [taxes] = await raw("SELECT id FROM permissions WHERE name = 'finance.taxes.manage'");
    await sequelize.query(
      `DELETE rp FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE r.name = 'admin' AND rp.permission_id = :id`,
      { replacements: { id: taxes.id }, type: QueryTypes.DELETE },
    );
    const models = require('../services/user-service/src/models');
    await require('../services/user-service/src/migrations/seedRolesAndPermissions')(models);
    const readmitted = await heldBy('admin');
    check('Re-running the seeder does not undo a customised role',
      !readmitted.includes('finance.taxes.manage'),
      'a permission removed from admin stays removed across a reboot');
  }

  // ════════════════════════════════════════════════════════════════════════════
  section('Results');

  const failed = results.filter((r) => !r.passed);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('\n  Failures:');
    failed.forEach((f) => console.log(`    - [${f.section}] ${f.criterion}\n      ${f.detail}`));
  }

  await settle();
  await closeAllPools();

  const cleanup = adminConnection();
  if (process.env.KEEP_VERIFY_DB === '1') {
    console.log(`\n  KEEP_VERIFY_DB=1 — leaving ${SCRATCH_DB} in place for inspection.`);
  } else {
    try {
      await dropScratchDatabase(cleanup);
      console.log(`\n  Scratch database ${SCRATCH_DB} dropped.`);
    } catch (error) {
      // Cosmetic: the next run kills any leftover connection and drops it
      // first thing. Never let this change the verification's verdict.
      console.log(`\n  Note: ${SCRATCH_DB} could not be dropped (${error.message}). `
        + 'The next run will clear it.');
    }
  }
  await cleanup.close();

  process.exit(failed.length ? 1 : 0);
};

main().catch(async (error) => {
  console.error('\nVerification aborted:', error.message);
  console.error(error.stack);

  /**
   * Close the connection pool before exiting.
   *
   * Without this an abort left a live connection to the scratch database, and
   * the next run blocked forever on DROP DATABASE waiting for a metadata lock —
   * hiding this failure behind a hang. Reporting the real error matters more
   * than a tidy exit, so every step here is individually guarded.
   */
  await settle();
  await closeAllPools();

  if (process.env.KEEP_VERIFY_DB !== '1') {
    try {
      const cleanup = adminConnection();
      await dropScratchDatabase(cleanup);
      await cleanup.close();
      console.error(`Scratch database ${SCRATCH_DB} dropped.`);
    } catch (cleanupError) {
      console.error(`Could not drop ${SCRATCH_DB}: ${cleanupError.message}`);
    }
  }

  process.exit(1);
});

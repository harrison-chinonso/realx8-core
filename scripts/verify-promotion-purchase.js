/**
 * A promotion carried all the way through a purchase.
 *
 * verify:promotions proves the arithmetic; verify:promotion-store proves the
 * rows. This proves the join between them and the rest of the platform, which
 * is where the expensive mistakes live:
 *
 *   - the discount comes off BEFORE the plan surcharge, not after
 *   - the instalment schedules add up to the PROMOTIONAL total
 *   - the unit's own price is still its own price afterwards
 *   - an abandoned invoice hands its allocation back
 *   - a payment turns the reservation into a redemption that counts
 *
 * The schedules one is the reason this script exists. An invoice showing the
 * promotional total while its schedules were generated from the list price is
 * invisible until somebody adds up six months of instalments, and by then the
 * buyer has been billed the wrong amount six times.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { QueryTypes } = require('sequelize');
const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_promotion_purchase`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifypromobuy';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

const naira = (amount) => Math.round(amount * 100);
const show = (minor) => `₦${(Number(minor) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

(async () => {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  // Every service's real migrations, so the tables are the ones production has.
  for (const dir of ['user-service', 'property-service', 'finance-service']) {
    process.stdout.write(`Migrating ${dir}… `);
    // eslint-disable-next-line no-await-in-loop, import/no-dynamic-require, global-require
    await require(`../services/${dir}/src/index.js`).bootstrap();
    console.log('done');
  }

  const { sequelize } = require('../services/finance-service/src/models');
  const { toMinor, toMajor } = require('../shared/src/money');
  const { createPaymentPlan, readPaymentPlan } = require('../shared/src/paymentPlanGateway');
  const { applyApprovedPayment } = require('../services/finance-service/src/services/allocationService');
  const promotions = require('../shared/src/promotionStore');
  const { BENEFIT, STATUS, TRIGGER } = require('../shared/src/promotions/types');

  const raw = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  const write = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.INSERT });
  const lastId = async () => (await raw('SELECT LAST_INSERT_ID() AS id'))[0].id;

  // ── fixtures ──────────────────────────────────────────────────────────────
  await write(`INSERT INTO companies (name, slug, email, status, created_at, updated_at)
               VALUES ('Promo Estates', 'promo-estates', 'promo@example.com', 'active', NOW(), NOW())`);
  const companyId = await lastId();

  await write(`INSERT INTO users (name, email, password, type, is_active, company_id, created_at, updated_at)
               VALUES ('Buyer', 'buyer@promo.test', 'x', 'client', 1, :companyId, NOW(), NOW())`, { companyId });
  const buyerId = await lastId();

  /*
   * Approved and available, because checkoutPurchase only sells listed stock —
   * a fixture that skips this gets "Property not found" and looks like a
   * promotion bug.
   */
  await write(`INSERT INTO properties (name, company_id, approval_status, status, created_at, updated_at)
               VALUES ('Lekki Gardens', :companyId, 'approved', 'available', NOW(), NOW())`, { companyId });
  const propertyId = await lastId();

  const UNIT_PRICE = 20_000_000;
  await write(`INSERT INTO property_units (property_id, name, price, status, quantity, created_at, updated_at)
               VALUES (:propertyId, 'Full Plot', :price, 'available', 50, NOW(), NOW())`,
  { propertyId, price: UNIT_PRICE });
  const unitId = await lastId();

  await write(`INSERT INTO installment_plans
                 (name, duration_months, surcharge_type, surcharge_value, is_active, company_id, created_at, updated_at)
               VALUES ('6 months', 6, 'percentage', 10, 1, :companyId, NOW(), NOW())`, { companyId });
  const planId = await lastId();
  await write(`INSERT INTO installment_plan_units (installment_plan_id, property_unit_id, created_at)
               VALUES (:planId, :unitId, NOW())`, { planId, unitId });

  /** A 10% campaign on the full plot, live today. */
  await write(`INSERT INTO promotions
                 (company_id, name, trigger_type, status, starts_at, ends_at, priority, created_at)
               VALUES (:companyId, 'Independence Promo', :trigger, :status, :starts, :ends, 1, NOW())`,
  {
    companyId, trigger: TRIGGER.AUTOMATIC, status: STATUS.ACTIVE,
    starts: new Date(Date.now() - 86400000), ends: new Date(Date.now() + 30 * 86400000),
  });
  const promotionId = await lastId();
  const version = await promotions.saveVersion(sequelize, {
    promotionId, companyId,
    config: {
      benefit_type: BENEFIT.PERCENTAGE, percentage: 10,
      scope: { unit_ids: [unitId] },
      name: 'Independence Promo',
    },
  });

  let invoiceCounter = 0;
  const makeInvoice = async (amount) => {
    invoiceCounter += 1;
    await write(`INSERT INTO invoices (invoice_id, client_id, property_id, amount, status, company_id, created_at)
                 VALUES (:ref, :buyerId, :propertyId, :amount, 'sent', :companyId, NOW())`,
    { ref: `INV-PROMO-${invoiceCounter}`, buyerId, propertyId, amount, companyId });
    return lastId();
  };

  /** The purchase path, as propertyController walks it. */
  const purchase = async ({ quantity, paymentType, usePlan = false }) => {
    const basket = {
      lines: [{ unit_id: unitId, property_id: propertyId, quantity, unit_price_minor: toMinor(UNIT_PRICE) }],
    };
    const quote = await promotions.quoteBasket(sequelize, {
      companyId, basket, buyer: { id: buyerId, completed_purchases: 0 },
      paymentType, installmentPlanId: usePlan ? planId : null,
    });

    const transaction = await sequelize.transaction();
    try {
      const plan = await createPaymentPlan(sequelize, transaction, {
        invoiceId: null, propertyUnitId: unitId, quantity, paymentType,
        installmentPlanId: usePlan ? planId : null,
        unitPrice: UNIT_PRICE, companyId, createdBy: buyerId,
        invoiceDate: new Date(), outrightDueDate: new Date(Date.now() + 30 * 86400000),
        promotionDiscountMinor: quote.discount_minor,
      }).catch(async (error) => { throw error; });
      await transaction.rollback();
      return { quote, plan };
    } catch (error) {
      if (!transaction.finished) await transaction.rollback();
      throw error;
    }
  };

  console.log('\n── The discount comes off before the plan surcharge ────────────');
  {
    /**
     * ₦60m of full plots, 10% off, on a 6-month plan charging 10%.
     *
     * Discount first:  60m − 6m = 54m, + 10% surcharge = ₦59,400,000
     * Surcharge first: 60m + 6m = 66m, − 10% discount  = ₦59,400,000
     *
     * They coincide at equal percentages, so the case is built with DIFFERENT
     * ones below. Here the point is only the promotional total.
     */
    const invoiceId = await makeInvoice(54_000_000);
    const basket = {
      lines: [{ unit_id: unitId, property_id: propertyId, quantity: 3, unit_price_minor: toMinor(UNIT_PRICE) }],
    };
    const quote = await promotions.quoteBasket(sequelize, {
      companyId, basket, buyer: { id: buyerId }, paymentType: 'installment', installmentPlanId: planId,
    });
    check('₦60m of plots attracts a ₦6,000,000 discount',
      quote.discount_minor === naira(6_000_000), show(quote.discount_minor));

    const transaction = await sequelize.transaction();
    const { paymentPlanId, schedules } = await createPaymentPlan(sequelize, transaction, {
      invoiceId, propertyUnitId: unitId, quantity: 3, paymentType: 'installment',
      installmentPlanId: planId, unitPrice: UNIT_PRICE, companyId, createdBy: buyerId,
      invoiceDate: new Date(), outrightDueDate: null,
      promotionDiscountMinor: quote.discount_minor,
    });
    await transaction.commit();

    const [plan] = await raw(
      'SELECT base_minor, promotion_discount_minor, surcharge_minor, total_minor FROM invoice_payment_plans WHERE id = :id',
      { id: paymentPlanId },
    );

    check('The plan records the FULL base, undiscounted',
      Number(plan.base_minor) === naira(60_000_000), show(plan.base_minor));
    check('...the discount beside it',
      Number(plan.promotion_discount_minor) === naira(6_000_000), show(plan.promotion_discount_minor));
    /**
     * The surcharge is 10% of ₦54m, not of ₦60m. Charging it on the full price
     * would make the buyer pay interest on a discount they were given.
     */
    check('...and a surcharge computed on the DISCOUNTED base',
      Number(plan.surcharge_minor) === naira(5_400_000),
      `${show(plan.surcharge_minor)} — 10% of ₦54m, not of ₦60m`);
    check('...for a total of ₦59,400,000',
      Number(plan.total_minor) === naira(59_400_000), show(plan.total_minor));

    /**
     * The one that would otherwise go unnoticed for six months.
     */
    const scheduleTotal = schedules.reduce((sum, s) => sum + Number(s.principal_minor), 0);
    check('The instalments add up to the promotional total, not the list price',
      scheduleTotal === naira(59_400_000),
      `${schedules.length} instalments summing to ${show(scheduleTotal)}`);

    const [unit] = await raw('SELECT price FROM property_units WHERE id = :id', { id: unitId });
    check('...and the unit is still priced at ₦20,000,000',
      Number(unit.price) === UNIT_PRICE,
      `${show(toMinor(unit.price))} — the promotional price is derived, never stored`);
  }

  console.log('\n── Discount before surcharge, proven with different rates ──────');
  {
    /**
     * A 25% discount against a 10% surcharge, so the two orders disagree:
     *   discount first:  20m − 5m = 15m, +10% = ₦16,500,000
     *   surcharge first: 20m + 2m = 22m, −25% = ₦16,500,000
     * Still equal. Use a FLAT surcharge instead, where they cannot coincide:
     *   discount first:  20m − 5m = 15m, + ₦1m = ₦16,000,000
     *   surcharge first: 20m + ₦1m = 21m, − 25% = ₦15,750,000
     */
    await write(`INSERT INTO installment_plans
                   (name, duration_months, surcharge_type, surcharge_value, is_active, company_id, created_at, updated_at)
                 VALUES ('Flat fee plan', 4, 'flat', 1000000, 1, :companyId, NOW(), NOW())`, { companyId });
    const flatPlanId = await lastId();
    await write(`INSERT INTO installment_plan_units (installment_plan_id, property_unit_id, created_at)
                 VALUES (:planId, :unitId, NOW())`, { planId: flatPlanId, unitId });

    const { quote } = require('../shared/src/installmentPricing');
    const [flatPlan] = await raw('SELECT * FROM installment_plans WHERE id = :id', { id: flatPlanId });

    const priced = quote({
      unitPriceMinor: toMinor(UNIT_PRICE), quantity: 1, paymentType: 'installment',
      plan: flatPlan, promotionDiscountMinor: naira(5_000_000),
    });
    check('A ₦5m discount then a ₦1m flat fee gives ₦16,000,000',
      priced.totalMinor === naira(16_000_000),
      `${show(priced.totalMinor)} — the other order would give ${show(naira(15_750_000))}`);
    check('...and the base is still reported as ₦20,000,000',
      priced.baseMinor === naira(20_000_000), show(priced.baseMinor));
  }

  console.log('\n── A reservation becomes a redemption when money arrives ───────');
  {
    const invoiceId = await makeInvoice(18_000_000);
    const basket = {
      lines: [{ unit_id: unitId, property_id: propertyId, quantity: 1, unit_price_minor: toMinor(UNIT_PRICE) }],
    };
    const quote = await promotions.quoteBasket(sequelize, {
      companyId, basket, buyer: { id: buyerId }, paymentType: 'outright',
    });

    const transaction = await sequelize.transaction();
    await createPaymentPlan(sequelize, transaction, {
      invoiceId, propertyUnitId: unitId, quantity: 1, paymentType: 'outright',
      unitPrice: UNIT_PRICE, companyId, createdBy: buyerId,
      invoiceDate: new Date(), outrightDueDate: new Date(Date.now() + 30 * 86400000),
      promotionDiscountMinor: quote.discount_minor,
    });
    await promotions.recordRedemption(sequelize, {
      quote, companyId, customerId: buyerId, propertyId, invoiceId, unitsCount: 1,
      status: 'RESERVED', transaction,
    });
    await transaction.commit();

    const [reserved] = await raw(
      'SELECT status, discount_minor FROM promotion_redemptions WHERE invoice_id = :id', { id: invoiceId },
    );
    check('An unpaid invoice holds the allocation, but only holds it',
      reserved.status === 'RESERVED', reserved.status);
    check('...for the amount the buyer was actually quoted',
      Number(reserved.discount_minor) === naira(2_000_000), show(reserved.discount_minor));

    await applyApprovedPayment({
      invoiceId, amountMinor: naira(18_000_000),
      paymentMethod: 'bank_transfer', reference: 'PROMO-PAID', companyId,
    });

    const [confirmed] = await raw(
      'SELECT status FROM promotion_redemptions WHERE invoice_id = :id', { id: invoiceId },
    );
    /**
     * Money has arrived, so the campaign's allocation is genuinely spent. Until
     * this point it was only held.
     */
    check('Paying turns the reservation into a redemption that counts',
      confirmed.status === 'CONFIRMED', confirmed.status);

    const plan = await readPaymentPlan(sequelize, invoiceId);
    check('...and the invoice settles at the promotional amount',
      plan.schedules.every((s) => Number(s.principal_outstanding_minor) === 0),
      `${plan.schedules.length} schedule(s), all settled at ${show(naira(18_000_000))}`);
  }

  console.log('\n── The checkout controller itself, end to end ──────────────────');
  {
    /**
     * Driven through `checkoutPurchase`, not around it.
     *
     * Every other case here calls quoteBasket and createPaymentPlan directly,
     * which is how a missing import in the controller that joins them reached a
     * browser: each layer was proven and the seam between them was not. The
     * controller is the only place the whole thing is assembled, so it is the
     * only place that can prove the assembly.
     */
    const controller = require('../services/property-service/src/controllers/propertyController');

    const call = (handler, req) => new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { resolve({ status: this.statusCode, body }); return this; },
      };
      Promise.resolve(handler(req, res, reject)).catch(reject);
    });

    // A live 10% campaign on the unit, as the earlier fixtures set up.
    await sequelize.query(
      "UPDATE promotions SET status = 'ACTIVE' WHERE id = :id",
      { replacements: { id: promotionId }, type: QueryTypes.UPDATE },
    );

    const result = await call(controller.checkoutPurchase, {
      params: { id: String(propertyId) },
      body: { unit_id: unitId, quantity: 2, payment_type: 'outright' },
      user: { id: buyerId, company_id: companyId, type: 'client' },
      query: {},
    });

    check('A purchase made through the controller succeeds',
      result.status === 201, `${result.status} — ${result.body?.message || 'created'}`);

    const pricing = result.body?.data?.pricing;
    check('...priced at the promotional total',
      pricing && Number(pricing.total) === 36_000_000,
      pricing ? `${Number(pricing.total).toLocaleString()} for 2 × ₦20m less 10%` : 'no pricing returned');
    check('...reporting the list price and the discount separately',
      pricing && Number(pricing.base) === 40_000_000 && Number(pricing.promotion_discount) === 4_000_000,
      pricing ? `base ${Number(pricing.base).toLocaleString()}, off ${Number(pricing.promotion_discount).toLocaleString()}` : '');
    check('...and naming the campaign back to the caller',
      result.body?.data?.promotions?.applied?.[0]?.promotion_id === promotionId,
      result.body?.data?.promotions?.applied?.[0]?.name);

    const newInvoiceId = result.body?.data?.invoice_id ?? 0;
    const [redemption] = await raw(
      'SELECT status, discount_minor, units_count FROM promotion_redemptions WHERE invoice_id = :id',
      { id: newInvoiceId },
    );
    check('...having reserved the redemption against the new invoice',
      redemption && redemption.status === 'RESERVED' && Number(redemption.units_count) === 2,
      redemption ? `${redemption.status}, ${redemption.units_count} unit(s)` : 'no redemption written');

    const [plan] = await raw(
      'SELECT base_minor, promotion_discount_minor, total_minor FROM invoice_payment_plans WHERE invoice_id = :id',
      { id: newInvoiceId },
    );
    check('...and written the discount onto the payment plan',
      plan && Number(plan.promotion_discount_minor) === naira(4_000_000)
        && Number(plan.total_minor) === naira(36_000_000),
      plan ? `${show(plan.base_minor)} less ${show(plan.promotion_discount_minor)} = ${show(plan.total_minor)}` : '');
  }

  console.log('\n── Expiry never revokes a purchase already made (FRD 27) ───────');
  {
    await sequelize.query("UPDATE promotions SET status = 'EXPIRED' WHERE id = :id",
      { replacements: { id: promotionId }, type: QueryTypes.UPDATE });

    /**
     * The redemption for the PAID invoice specifically, not "the latest one".
     *
     * Reaching for the most recent row made this assertion depend on what every
     * case above happened to create — it broke the moment another purchase was
     * added, and it broke by reading somebody else's money.
     */
    const [kept] = await raw(
      `SELECT discount_minor, promotion_version_id FROM promotion_redemptions
        WHERE promotion_id = :id AND status = 'CONFIRMED' ORDER BY id DESC LIMIT 1`,
      { id: promotionId },
    );
    check('The buyer keeps the ₦2,000,000 they were given',
      Number(kept.discount_minor) === naira(2_000_000), show(kept.discount_minor));
    check('...against the version it was calculated under',
      Number(kept.promotion_version_id) === version.version_id, `version ${kept.promotion_version_id}`);

    const now = await promotions.quoteBasket(sequelize, {
      companyId,
      basket: { lines: [{ unit_id: unitId, property_id: propertyId, quantity: 1, unit_price_minor: toMinor(UNIT_PRICE) }] },
      buyer: { id: buyerId }, paymentType: 'outright',
    });
    check('...while a new purchase pays the full price',
      now.discount_minor === 0 && now.payable_minor === naira(20_000_000), show(now.payable_minor));
  }

  await sequelize.close();
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error('\n  Harness error:', error);
  process.exit(1);
});

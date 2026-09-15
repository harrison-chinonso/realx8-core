/**
 * The promotion engine's persistence layer, against a real database.
 *
 * verify:promotions proves the arithmetic with no database at all. This proves
 * the half arithmetic cannot: that a version is immutable, that a purchase made
 * under version 1 keeps version 1's terms after the campaign is edited, that a
 * redemption reserved by an abandoned basket is handed back, and that usage
 * limits are counted from what actually stands.
 *
 * Drives the REAL migration and the REAL store against a throwaway database.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { QueryTypes } = require('sequelize');
const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_promotion_store`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifypromostore';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

const naira = (amount) => Math.round(amount * 100);
const show = (minor) => `₦${(Number(minor) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

const COMPANY = 1;
const LEKKI = 1;
const FULL_PLOT = 10;
const HALF_PLOT = 11;
const PRICE = naira(20_000_000);

const line = (unitId, quantity, price = PRICE) => ({
  unit_id: unitId, property_id: LEKKI, quantity, unit_price_minor: price,
});

(async () => {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  const { sequelize } = require('../services/property-service/src/config/database');
  await require('../services/property-service/src/migrations/createPromotionEngine')(sequelize);

  const store = require('../shared/src/promotionStore');
  const { STATUS, BENEFIT, TRIGGER } = require('../shared/src/promotions/types');

  /** Create a promotion and its first version, as the controller will. */
  const createPromotion = async ({ name, config, status = STATUS.ACTIVE, code = null, priority = 100, stackable = false }) => {
    const [id] = await sequelize.query(
      `INSERT INTO promotions
         (company_id, name, code, trigger_type, status, starts_at, ends_at, priority, stackable, created_at)
       VALUES (:company, :name, :code, :trigger, :status, :starts, :ends, :priority, :stackable, NOW())`,
      {
        replacements: {
          company: COMPANY, name, code,
          trigger: code ? TRIGGER.CODE : TRIGGER.AUTOMATIC,
          status,
          starts: '2026-10-01 00:00:00',
          ends: '2026-10-31 00:00:00',
          priority,
          stackable: stackable ? 1 : 0,
        },
        type: QueryTypes.INSERT,
      },
    );
    const saved = await store.saveVersion(sequelize, {
      promotionId: id, companyId: COMPANY, config, changeNote: 'initial',
    });
    return { id, ...saved };
  };

  const OCTOBER = new Date('2026-10-15T12:00:00Z');

  console.log('\n── A live campaign is found and applied ────────────────────────');
  let promo;
  {
    promo = await createPromotion({
      name: 'Independence Promo',
      config: {
        benefit_type: BENEFIT.PERCENTAGE, percentage: 20,
        scope: { unit_ids: [FULL_PLOT] },
      },
    });

    const quote = await store.quoteBasket(sequelize, {
      companyId: COMPANY, basket: { lines: [line(FULL_PLOT, 1)] }, at: OCTOBER,
    });
    check('The campaign is loaded and applied',
      quote.discount_minor === naira(4_000_000), show(quote.discount_minor));
    check('...naming itself, so a buyer knows what they got',
      quote.applied[0]?.name === 'Independence Promo', quote.applied[0]?.name);
    check('...and carrying the version it was calculated under',
      quote.applied[0]?.version_id === promo.version_id, `version ${quote.applied[0]?.version_id}`);
  }

  console.log('\n── Quoting writes nothing ──────────────────────────────────────');
  {
    const [before] = await sequelize.query('SELECT COUNT(*) AS n FROM promotion_redemptions', { type: QueryTypes.SELECT });
    await store.quoteBasket(sequelize, {
      companyId: COMPANY, basket: { lines: [line(FULL_PLOT, 3)] }, at: OCTOBER,
    });
    const [after] = await sequelize.query('SELECT COUNT(*) AS n FROM promotion_redemptions', { type: QueryTypes.SELECT });
    /**
     * A buyer who looks at a promotional price and walks away must consume
     * nothing. Otherwise a campaign limited to 100 redemptions is exhausted by
     * 100 people browsing.
     */
    check('Looking at a price consumes no allocation',
      Number(before.n) === Number(after.n), `${after.n} redemption(s)`);
  }

  console.log('\n── Editing a live campaign writes a new version ────────────────');
  {
    const second = await store.saveVersion(sequelize, {
      promotionId: promo.id, companyId: COMPANY,
      config: { benefit_type: BENEFIT.PERCENTAGE, percentage: 10, scope: { unit_ids: [FULL_PLOT] } },
      changeNote: 'reduced to 10%',
    });
    check('The edit becomes version 2', second.version === 2, `version ${second.version}`);

    const [v1] = await sequelize.query(
      'SELECT config FROM promotion_versions WHERE promotion_id = :id AND version = 1',
      { replacements: { id: promo.id }, type: QueryTypes.SELECT },
    );
    /**
     * The point of versioning. Version 1 still says 20% — an administrator
     * reducing the campaign has not rewritten what earlier buyers were given.
     */
    check('Version 1 is untouched and still says 20%',
      JSON.parse(v1.config).percentage === 20, `${JSON.parse(v1.config).percentage}%`);

    const nowQuote = await store.quoteBasket(sequelize, {
      companyId: COMPANY, basket: { lines: [line(FULL_PLOT, 1)] }, at: OCTOBER,
    });
    check('A NEW purchase is calculated under version 2',
      nowQuote.discount_minor === naira(2_000_000) && nowQuote.applied[0].version_id === second.version_id,
      `${show(nowQuote.discount_minor)} under version ${nowQuote.applied[0].version_id}`);
  }

  console.log('\n── A completed purchase keeps what it was given (FRD 39) ───────');
  {
    /**
     * The scenario the FRD spells out: purchased on the 28th under 20%, the
     * campaign is later reduced, and the buyer goes on paying at the old rate.
     * The figures are READ BACK from the redemption, not recomputed — that is
     * what makes it true.
     */
    const purchaseQuote = {
      original_minor: naira(20_000_000),
      discount_minor: naira(4_000_000),
      payable_minor: naira(16_000_000),
      applied: [{
        promotion_id: promo.id, version_id: promo.version_id, name: 'Independence Promo',
        benefit_type: BENEFIT.PERCENTAGE, discount_minor: naira(4_000_000),
        allocations: [{ unit_id: FULL_PLOT, quantity: 1, discount_minor: naira(4_000_000) }],
        terms: 'Full plots only.',
      }],
    };
    await store.recordRedemption(sequelize, {
      quote: purchaseQuote, companyId: COMPANY, customerId: 50, propertyId: LEKKI,
      invoiceId: 900, unitsCount: 1, status: 'CONFIRMED', at: new Date('2026-10-28T10:00:00Z'),
    });

    // The campaign is reduced again, and then ends entirely.
    await store.saveVersion(sequelize, {
      promotionId: promo.id, companyId: COMPANY,
      config: { benefit_type: BENEFIT.PERCENTAGE, percentage: 5, scope: { unit_ids: [FULL_PLOT] } },
      changeNote: 'reduced again',
    });
    await sequelize.query("UPDATE promotions SET status = 'EXPIRED' WHERE id = :id",
      { replacements: { id: promo.id }, type: QueryTypes.UPDATE });

    const [kept] = await sequelize.query(
      `SELECT discount_minor, payable_minor, promotion_version_id, breakdown
         FROM promotion_redemptions WHERE invoice_id = 900`,
      { type: QueryTypes.SELECT },
    );
    check('The October purchase still shows ₦4,000,000 off',
      Number(kept.discount_minor) === naira(4_000_000), show(kept.discount_minor));
    check('...and ₦16,000,000 payable, after two edits and an expiry',
      Number(kept.payable_minor) === naira(16_000_000), show(kept.payable_minor));
    check('...still naming version 1, which is what it was calculated under',
      Number(kept.promotion_version_id) === promo.version_id, `version ${kept.promotion_version_id}`);
    check('...and keeping the campaign name and terms as they were',
      JSON.parse(kept.breakdown).name === 'Independence Promo'
      && JSON.parse(kept.breakdown).terms === 'Full plots only.',
      JSON.parse(kept.breakdown).terms);

    const afterExpiry = await store.quoteBasket(sequelize, {
      companyId: COMPANY, basket: { lines: [line(FULL_PLOT, 1)] }, at: new Date('2026-11-05T10:00:00Z'),
    });
    check('An expired campaign applies to nothing new',
      afterExpiry.discount_minor === 0, show(afterExpiry.discount_minor));
  }

  console.log('\n── Usage limits count what actually stands (FRD 28) ────────────');
  {
    const limited = await createPromotion({
      name: 'First fifty',
      config: {
        benefit_type: BENEFIT.PERCENTAGE, percentage: 10, scope: { unit_ids: [HALF_PLOT] },
        limits: { total_redemptions: 2, per_customer: 1 },
      },
    });

    const half = () => ({ lines: [line(HALF_PLOT, 1, naira(12_000_000))] });
    const quoteFor = (buyerId) => store.quoteBasket(sequelize, {
      companyId: COMPANY, basket: half(), buyer: { id: buyerId }, at: OCTOBER,
    });

    const first = await quoteFor(60);
    check('The first buyer qualifies', first.discount_minor > 0, show(first.discount_minor));

    await store.recordRedemption(sequelize, {
      quote: first, companyId: COMPANY, customerId: 60, invoiceId: 901, unitsCount: 1, status: 'CONFIRMED',
    });

    const same = await quoteFor(60);
    check('The same buyer cannot use it twice', same.discount_minor === 0,
      same.considered.find((c) => c.promotion_id === limited.id)?.message);

    const second = await quoteFor(61);
    check('A different buyer still can', second.discount_minor > 0, show(second.discount_minor));

    await store.recordRedemption(sequelize, {
      quote: second, companyId: COMPANY, customerId: 61, invoiceId: 902, unitsCount: 1, status: 'CONFIRMED',
    });

    const third = await quoteFor(62);
    check('Once the total is reached, nobody else can', third.discount_minor === 0,
      third.considered.find((c) => c.promotion_id === limited.id)?.message);
  }

  console.log('\n── An abandoned basket hands its allocation back ───────────────');
  {
    const scarce = await createPromotion({
      name: 'Only one',
      config: {
        benefit_type: BENEFIT.FIXED_AMOUNT, amount_minor: naira(1_000_000),
        scope: { unit_ids: [FULL_PLOT] }, limits: { total_redemptions: 1 },
      },
      priority: 1,
    });

    const cart = { lines: [line(FULL_PLOT, 1)] };
    const reserved = await store.quoteBasket(sequelize, {
      companyId: COMPANY, basket: cart, buyer: { id: 70 }, at: OCTOBER,
    });
    const applied = reserved.applied.find((a) => a.promotion_id === scarce.id);
    check('The last allocation is quoted to the first buyer', Boolean(applied), applied?.name);

    await store.recordRedemption(sequelize, {
      quote: { ...reserved, applied: [applied] },
      companyId: COMPANY, customerId: 70, invoiceId: 903, unitsCount: 1, status: 'RESERVED',
    });

    const blocked = await store.quoteBasket(sequelize, {
      companyId: COMPANY, basket: cart, buyer: { id: 71 }, at: OCTOBER,
    });
    check('...and a second buyer is refused while it is held',
      !blocked.applied.some((a) => a.promotion_id === scarce.id),
      blocked.considered.find((c) => c.promotion_id === scarce.id)?.message);

    /**
     * The first buyer abandons the invoice. Their hold must be handed back —
     * otherwise a campaign limited to 100 is exhausted by 100 people who never
     * paid, and nobody can tell why it stopped working.
     */
    const released = await store.settleRedemptions(sequelize, { invoiceId: 903, status: 'RELEASED' });
    check('Releasing an abandoned invoice frees its hold', released === 1, `${released} released`);

    const freed = await store.quoteBasket(sequelize, {
      companyId: COMPANY, basket: cart, buyer: { id: 71 }, at: OCTOBER,
    });
    check('...and the next buyer can have it',
      freed.applied.some((a) => a.promotion_id === scarce.id),
      freed.applied.map((a) => a.name).join(', '));

    const [row] = await sequelize.query(
      'SELECT status, released_at FROM promotion_redemptions WHERE invoice_id = 903',
      { type: QueryTypes.SELECT },
    );
    check('...and the release is timestamped rather than merely flagged',
      row.status === 'RELEASED' && row.released_at != null, `${row.status} at ${row.released_at}`);
  }

  console.log('\n── A campaign nobody can read does not break every purchase ────');
  {
    /**
     * One broken configuration must not take the whole checkout down. A version
     * whose document will not parse is skipped, and everything else still
     * applies — the alternative is that a single bad edit stops the company
     * selling anything.
     */
    const broken = await createPromotion({
      name: 'Broken', priority: 1,
      config: { benefit_type: BENEFIT.PERCENTAGE, percentage: 50, scope: {} },
    });
    await sequelize.query(
      "UPDATE promotion_versions SET config = 'not json at all' WHERE promotion_id = :id",
      { replacements: { id: broken.id }, type: QueryTypes.UPDATE },
    );

    const working = await createPromotion({
      name: 'Still working', priority: 2,
      config: { benefit_type: BENEFIT.PERCENTAGE, percentage: 15, scope: { unit_ids: [FULL_PLOT] } },
    });

    const quote = await store.quoteBasket(sequelize, {
      companyId: COMPANY, basket: { lines: [line(FULL_PLOT, 1)] }, buyer: { id: 80 }, at: OCTOBER,
    });
    check('The unreadable campaign is skipped, not thrown',
      !quote.applied.some((a) => a.promotion_id === broken.id), '');
    check('...and the working one still applies',
      quote.applied.some((a) => a.promotion_id === working.id),
      quote.applied.map((a) => a.name).join(', '));
  }

  console.log('\n── One company cannot see another\'s campaigns ──────────────────');
  {
    const [otherId] = await sequelize.query(
      `INSERT INTO promotions (company_id, name, trigger_type, status, starts_at, ends_at, priority, created_at)
       VALUES (99, 'Somebody else''s promo', 'AUTOMATIC', 'ACTIVE', '2026-10-01', '2026-10-31', 1, NOW())`,
      { type: QueryTypes.INSERT },
    );
    await store.saveVersion(sequelize, {
      promotionId: otherId, companyId: 99,
      config: { benefit_type: BENEFIT.PERCENTAGE, percentage: 90, scope: {} },
    });

    const mine = await store.quoteBasket(sequelize, {
      companyId: COMPANY, basket: { lines: [line(FULL_PLOT, 1)] }, buyer: { id: 90 }, at: OCTOBER,
    });
    check('Another company\'s 90% campaign is invisible',
      !mine.applied.some((a) => a.promotion_id === otherId)
      && !mine.considered.some((c) => c.promotion_id === otherId),
      mine.applied.map((a) => a.name).join(', ') || 'nothing applied');
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

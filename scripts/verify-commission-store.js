/**
 * The commission engine's persistence layer, against a real database.
 *
 * verify:commission proves the arithmetic with no database at all. This proves
 * the half that arithmetic cannot: that a plan version is chosen by the deal's
 * date and not by today's, that re-running a calculation pays nobody twice,
 * that the status gate is re-asked at release, and that a wallet derived from
 * the ledger agrees with the entitlements it came from.
 *
 * Drives the REAL migrations and the REAL store against a throwaway database.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { Sequelize, QueryTypes } = require('sequelize');
const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_commission_store`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }

/**
 * Point the SERVICES' models at the scratch database before anything requires
 * them — config/database.js reads this at require time.
 *
 * Not optional, and not merely tidy. The controllers exercised further down
 * import `sequelize` from their service's models rather than taking one, so
 * without this they connect to whatever cred.env names and write plans into
 * the real database. An ACTIVE plan there would silently switch that company
 * onto the engine, which is a behaviour change nobody asked for, made by a
 * test. The other verify scripts in this directory do the same thing first,
 * for the same reason.
 */
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifycommission';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

const naira = (amount) => Math.round(amount * 100);
const show = (minor) => (Number(minor) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });

/** A plan that pays the seller 6% and three generations, capped at 8%. */
const PLAN_CONFIG = {
  commissionable_base: { mode: 'GROSS_PRICE' },
  pool: { mode: 'PERCENTAGE', percentage: 8 },
  resolution: 'PRORATE',
  rules: [
    { id: 'direct', type: 'DIRECT_SALE', value_type: 'PERCENTAGE', basis: 'OF_COMMISSIONABLE_BASE' },
    {
      id: 'gen',
      type: 'GENERATIONAL_OVERRIDE',
      compression: 'NONE',
      tiers: [
        { generation: 1, value_type: 'PERCENTAGE', value: 1.5, basis: 'OF_COMMISSIONABLE_BASE' },
        { generation: 2, value_type: 'PERCENTAGE', value: 1.0, basis: 'OF_COMMISSIONABLE_BASE' },
        { generation: 3, value_type: 'PERCENTAGE', value: 0.5, basis: 'OF_COMMISSIONABLE_BASE' },
      ],
    },
  ],
};

/** The same plan, but paying the seller far less — used to prove date resolution. */
const OLD_PLAN_CONFIG = {
  ...PLAN_CONFIG,
  rules: [
    { id: 'direct', type: 'DIRECT_SALE', value_type: 'PERCENTAGE', value: 2, basis: 'OF_COMMISSIONABLE_BASE' },
  ],
};

(async () => {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  // The very connection the controllers will use, so there is no possibility of
  // the test proving something about a different database than the code touches.
  const { sequelize } = require('../services/finance-service/src/config/database');

  /**
   * `users` and `realtor_levels` are built from the REAL models, not from a
   * hand-written stand-in.
   *
   * The checks further down exercise the model's own hooks, so the table has to
   * be the shape the model actually expects — a trimmed copy diverges the
   * moment a column is added, and the test then fails for a reason that has
   * nothing to do with what it is testing.
   */
  const userModels = require('../services/user-service/src/models');
  // Parents before children: `users` carries foreign keys to both, and MySQL
  // refuses to create a table whose referenced table is not there yet.
  await userModels.Company.sync({ force: true });
  await userModels.RealtorLevel.sync({ force: true });
  await userModels.User.sync({ force: true });
  // Through the model, so every NOT NULL column the schema requires is filled
  // by the model's own defaults rather than enumerated here.
  await userModels.Company.create({
    id: 1, name: 'Test Company', slug: 'test-company', email: 'company@test',
  });

  await require('../services/user-service/src/migrations/addRealtorStatusHistory')(sequelize);
  await require('../services/finance-service/src/migrations/createCommissionEngine')(sequelize);
  // The store and the controllers both take this connection; naming it once
  // makes it obvious they share one.
  const { User } = userModels;

  const store = require('../shared/src/commissionStore');
  const { recordStatus, STATUS } = require('../shared/src/realtorStatus');

  // ── A company, a ladder, and a four-deep genealogy ────────────────────────
  await sequelize.query("INSERT INTO realtor_levels (id, name, position, commission_percentage, company_id, created_at, updated_at) VALUES (1, 'Senior', 3, 6.00, 1, NOW(), NOW())");
  await sequelize.query(`INSERT INTO users (id, name, email, password, type, realtor_code, realtor_id, realtor_level_id, company_id, created_at, updated_at) VALUES
    (10, 'Seller',   'seller@test',  'x', 'realtor', 'AAAAA', 11,   1, 1, '2026-01-01', NOW()),
    (11, 'Gen One',  'gen1@test',    'x', 'realtor', 'BBBBB', 12,   1, 1, '2026-01-01', NOW()),
    (12, 'Gen Two',  'gen2@test',    'x', 'realtor', 'CCCCC', 13,   1, 1, '2026-01-01', NOW()),
    (13, 'Gen Three','gen3@test',    'x', 'realtor', 'DDDDD', NULL, 1, 1, '2026-01-01', NOW())`);

  for (const id of [10, 11, 12, 13]) {
    // eslint-disable-next-line no-await-in-loop
    await recordStatus(sequelize, {
      userId: id, status: STATUS.ACTIVE, reason: 'administrative', at: '2026-01-01T00:00:00Z',
    });
  }

  const insertPlan = async ({ planId, versionId, config, from, to = null, scopeType = null, scopeId = null, isDefault = 1 }) => {
    await sequelize.query(
      `INSERT INTO commission_plans (id, company_id, name, is_default, scope_type, scope_id, status, created_at)
       VALUES (:planId, 1, :name, :isDefault, :scopeType, :scopeId, 'active', NOW())`,
      { replacements: { planId, name: `Plan ${planId}`, isDefault, scopeType, scopeId }, type: QueryTypes.INSERT },
    );
    await sequelize.query(
      `INSERT INTO commission_plan_versions
         (id, plan_id, company_id, version, effective_from, effective_to, status, config, engine_version, created_at)
       VALUES (:versionId, :planId, 1, 1, :from, :to, 'active', :config, :engine, NOW())`,
      {
        replacements: {
          versionId, planId, from, to, config: JSON.stringify(config), engine: store.ENGINE_VERSION,
        },
        type: QueryTypes.INSERT,
      },
    );
  };

  // An old plan that lapsed, and the one in force now.
  await insertPlan({ planId: 1, versionId: 1, config: OLD_PLAN_CONFIG, from: '2025-01-01', to: '2026-06-01' });
  await insertPlan({ planId: 2, versionId: 2, config: PLAN_CONFIG, from: '2026-06-01' });

  const deal = {
    deal_ref: 'DEAL-1',
    company_id: 1,
    property_id: 100,
    invoice_id: 500,
    selling_realtor_id: 10,
    gross_price_minor: naira(50_000_000),
    discount_minor: 0,
    unit_count: 1,
    attribution_date: '2026-08-01T00:00:00Z',
  };

  // ── Resolving the version ─────────────────────────────────────────────────
  console.log('\n── The version is chosen by the deal\'s date, not by today ──────');
  {
    const current = await store.resolvePlanVersion(sequelize, {
      companyId: 1, propertyId: 100, at: '2026-08-01T00:00:00Z',
    });
    check('A deal today resolves the plan in force today', current?.id === 2, `version ${current?.id}`);

    const historical = await store.resolvePlanVersion(sequelize, {
      companyId: 1, propertyId: 100, at: '2026-03-01T00:00:00Z',
    });
    check('A deal from March resolves the plan that was in force in March',
      historical?.id === 1,
      `version ${historical?.id} — changing a plan must never restate an old deal`);

    const beforeAny = await store.resolvePlanVersion(sequelize, {
      companyId: 1, propertyId: 100, at: '2024-01-01T00:00:00Z',
    });
    check('A deal before any plan existed resolves nothing', beforeAny === null);

    const otherCompany = await store.resolvePlanVersion(sequelize, {
      companyId: 99, propertyId: 100, at: '2026-08-01T00:00:00Z',
    });
    check('Another company sees none of it', otherCompany === null);
  }

  // ── The genealogy ─────────────────────────────────────────────────────────
  console.log('\n── The upline chain ────────────────────────────────────────────');
  {
    const chain = await store.uplineOf(sequelize, 10);
    check('Three ancestors, nearest first',
      chain.length === 3 && chain[0].id === 11 && chain[2].id === 13,
      chain.map((r) => r.name).join(' → '));

    // A cycle is possible because realtor_id is admin-editable.
    await sequelize.query('UPDATE users SET realtor_id = 10 WHERE id = 13');
    const looped = await store.uplineOf(sequelize, 10);
    check('A cycle terminates instead of hanging', looped.length === 3, `${looped.length} node(s)`);
    await sequelize.query('UPDATE users SET realtor_id = NULL WHERE id = 13');
  }

  // ── Accrual ───────────────────────────────────────────────────────────────
  console.log('\n── Accruing a deal ─────────────────────────────────────────────');
  let accrual;
  {
    accrual = await store.accrueForDeal(sequelize, deal);
    check('Four entitlements are written', accrual.accrued === 4, `${accrual.accrued}`);

    const rows = await sequelize.query(
      'SELECT realtor_id, role, generation, gross_minor, constrained_minor, status FROM commission_entitlements ORDER BY realtor_id',
      { type: QueryTypes.SELECT },
    );
    const byRealtor = Object.fromEntries(rows.map((r) => [r.realtor_id, r]));
    check('The seller is prorated to 2,666,666.67',
      Number(byRealtor[10].constrained_minor) === naira(2_666_666.67), show(byRealtor[10].constrained_minor));
    check('...and the constrained figure differs from the gross, as the cap requires',
      Number(byRealtor[10].gross_minor) === naira(3_000_000),
      `gross ${show(byRealtor[10].gross_minor)} → allowed ${show(byRealtor[10].constrained_minor)}`);
    check('Generations are numbered on the row, not just in the trace',
      byRealtor[11].generation === 1 && byRealtor[13].generation === 3);
    check('The direct line stores generation 0, never NULL',
      byRealtor[10].generation === 0,
      'a NULL there would switch off the uniqueness that stops a double payment');

    const ledger = await sequelize.query(
      "SELECT entry_type, COUNT(*) AS n, COALESCE(SUM(amount_minor),0) AS total FROM commission_ledger_entries GROUP BY entry_type",
      { type: QueryTypes.SELECT },
    );
    const accrualRow = ledger.find((r) => r.entry_type === 'ACCRUAL');
    check('Every entitlement posted one accrual entry', Number(accrualRow?.n) === 4);
    check('...and they sum to exactly the pool',
      Number(accrualRow?.total) === naira(4_000_000), show(accrualRow?.total));
  }

  // ── Idempotency ───────────────────────────────────────────────────────────
  console.log('\n── Running it again pays nobody twice (FR-CLC-002, AC-010) ─────');
  {
    const again = await store.accrueForDeal(sequelize, deal);
    const [{ entitlements }] = await sequelize.query(
      'SELECT COUNT(*) AS entitlements FROM commission_entitlements', { type: QueryTypes.SELECT },
    );
    const [{ entries }] = await sequelize.query(
      'SELECT COUNT(*) AS entries FROM commission_ledger_entries', { type: QueryTypes.SELECT },
    );
    check('The second run writes no new entitlement', Number(entitlements) === 4, `${entitlements} total`);
    /**
     * Four, not five: a percentage cap that is BREACHED leaves no breakage.
     * Proration spends the pool exactly, so there is nothing unallocated to
     * retain. The breakage path is exercised by the flat-pool deal below.
     */
    check('...and no new ledger entry', Number(entries) === 4, `${entries} total (4 accruals, no breakage)`);
    check('...and says so rather than pretending it worked', again.accrued === 0, `accrued: ${again.accrued}`);
  }

  // ── Release, and the gate being asked again ───────────────────────────────
  console.log('\n── The status gate is re-asked at release (§5.9, FR-ELG-002) ───');
  {
    // Gen One is suspended AFTER the deal was attributed but BEFORE release.
    await recordStatus(sequelize, {
      userId: 11, status: STATUS.SUSPENDED, reason: 'suspension', at: '2026-08-15T00:00:00Z',
    });

    const released = await store.releaseForDeal(sequelize, { dealRef: 'DEAL-1', at: '2026-09-01T00:00:00Z' });
    check('Three release, one forfeits',
      released.released === 3 && released.forfeited === 1,
      `released ${released.released}, forfeited ${released.forfeited}`);

    const rows = await sequelize.query(
      'SELECT realtor_id, status, released_minor, forfeited_minor FROM commission_entitlements ORDER BY realtor_id',
      { type: QueryTypes.SELECT },
    );
    const by = Object.fromEntries(rows.map((r) => [r.realtor_id, r]));

    check('AC-011  the suspended upline is FORFEITED, not paid',
      by[11].status === 'FORFEITED' && Number(by[11].released_minor) === 0,
      `${by[11].status}, released ${show(by[11].released_minor)}`);
    check('...and the forfeited amount is recorded on the row',
      Number(by[11].forfeited_minor) === naira(666_666.67), show(by[11].forfeited_minor));
    check('AC-014  the seller is unaffected',
      by[10].status === 'RELEASED' && Number(by[10].released_minor) === naira(2_666_666.67),
      show(by[10].released_minor));
    check('...as are the generations either side of the suspended one',
      by[12].status === 'RELEASED' && by[13].status === 'RELEASED');

    const forfeit = await sequelize.query(
      "SELECT amount_minor, metadata FROM commission_ledger_entries WHERE entry_type = 'FORFEIT'",
      { type: QueryTypes.SELECT },
    );
    check('FR-ELG-011  the failing check is on the ledger entry, explainable without re-running',
      forfeit.length === 1 && /suspended/.test(forfeit[0].metadata || ''),
      JSON.parse(forfeit[0]?.metadata || '{}')?.eligibility_check?.status);
  }

  console.log('\n── Releasing again changes nothing ─────────────────────────────');
  {
    const before = await sequelize.query('SELECT COUNT(*) AS n FROM commission_ledger_entries', { type: QueryTypes.SELECT });
    const again = await store.releaseForDeal(sequelize, { dealRef: 'DEAL-1', at: '2026-09-02T00:00:00Z' });
    const after = await sequelize.query('SELECT COUNT(*) AS n FROM commission_ledger_entries', { type: QueryTypes.SELECT });
    check('Nothing left to release, and nothing posted',
      again.released === 0 && Number(before[0].n) === Number(after[0].n),
      `${after[0].n} entries`);
  }

  // ── The wallet ────────────────────────────────────────────────────────────
  console.log('\n── The wallet is derived from the ledger (FR-PAY-001) ──────────');
  {
    const seller = await store.walletFor(sequelize, 10);
    check('The seller has their release available',
      seller.available_minor === naira(2_666_666.67), show(seller.available_minor));
    check('...and nothing still accruing',
      seller.accrued_minor === 0, show(seller.accrued_minor));

    const suspended = await store.walletFor(sequelize, 11);
    check('The forfeited upline has nothing available',
      suspended.available_minor === 0, show(suspended.available_minor));
    check('...and the forfeiture is visible rather than just absent',
      suspended.forfeited_minor === naira(666_666.67), show(suspended.forfeited_minor));

    const wallets = await Promise.all([10, 11, 12, 13].map((id) => store.walletFor(sequelize, id)));
    const totalOut = wallets.reduce((sum, w) => sum + w.available_minor, 0);
    const [{ breakage }] = await sequelize.query(
      "SELECT COALESCE(SUM(amount_minor),0) AS breakage FROM commission_ledger_entries WHERE entry_type IN ('BREAKAGE','FORFEIT')",
      { type: QueryTypes.SELECT },
    );
    check('Paid out plus retained equals the pool exactly',
      totalOut + Number(breakage) === naira(4_000_000),
      `${show(totalOut)} + ${show(breakage)} = ${show(totalOut + Number(breakage))}`);
  }

  // ── A realtor who was never active ────────────────────────────────────────
  // ── Breakage ──────────────────────────────────────────────────────────────
  console.log('\n── A flat pool nobody claims all of is retained (FR-ANL-004) ───');
  {
    const FLAT_PLAN = {
      commissionable_base: { mode: 'GROSS_PRICE' },
      pool: { mode: 'FLAT', flat_amount_minor: naira(1_500_000) },
      resolution: 'PRORATE',
      surplus: 'BREAKAGE',
      rules: [
        { id: 'direct', type: 'DIRECT_SALE', value_type: 'PERCENTAGE', value: 60, basis: 'OF_POOL' },
        {
          id: 'gen', type: 'GENERATIONAL_OVERRIDE', compression: 'NONE',
          tiers: [
            { generation: 1, value_type: 'PERCENTAGE', value: 20, basis: 'OF_POOL' },
            { generation: 2, value_type: 'PERCENTAGE', value: 12, basis: 'OF_POOL' },
            { generation: 3, value_type: 'PERCENTAGE', value: 8, basis: 'OF_POOL' },
          ],
        },
      ],
    };
    // Scoped to one property, so it outranks the company default for this deal
    // and leaves every other deal alone.
    await insertPlan({
      planId: 3, versionId: 3, config: FLAT_PLAN, from: '2026-06-01',
      scopeType: 'property', scopeId: 200, isDefault: 0,
    });

    // A seller with only TWO ancestors — there is no Gen 3 to take the 8%.
    await sequelize.query(`INSERT INTO users (id, name, email, password, type, realtor_code, realtor_id, realtor_level_id, company_id, created_at, updated_at) VALUES
      (30, 'Shallow Seller', 'sh0@test', 'x', 'realtor', 'FFFFF', 31,   1, 1, '2026-01-01', NOW()),
      (31, 'Shallow Gen 1',  'sh1@test', 'x', 'realtor', 'GGGGG', 32,   1, 1, '2026-01-01', NOW()),
      (32, 'Shallow Gen 2',  'sh2@test', 'x', 'realtor', 'HHHHH', NULL, 1, 1, '2026-01-01', NOW())`);
    for (const id of [30, 31, 32]) {
      // eslint-disable-next-line no-await-in-loop
      await recordStatus(sequelize, { userId: id, status: STATUS.ACTIVE, at: '2026-01-01T00:00:00Z' });
    }

    const flat = await store.accrueForDeal(sequelize, {
      ...deal, deal_ref: 'DEAL-3', property_id: 200, selling_realtor_id: 30,
    });
    check('The property-scoped plan outranks the company default',
      flat.planVersion?.id === 3, `version ${flat.planVersion?.id}`);
    check('Three participants, because there is no Gen 3', flat.accrued === 3, `${flat.accrued}`);

    const [{ allocated }] = await sequelize.query(
      `SELECT COALESCE(SUM(amount_minor),0) AS allocated FROM commission_ledger_entries
        WHERE deal_ref = 'DEAL-3' AND entry_type = 'ACCRUAL'`, { type: QueryTypes.SELECT },
    );
    check('1,380,000 is allocated', Number(allocated) === naira(1_380_000), show(allocated));

    const breakage = await sequelize.query(
      `SELECT amount_minor, metadata FROM commission_ledger_entries
        WHERE deal_ref = 'DEAL-3' AND entry_type = 'BREAKAGE'`, { type: QueryTypes.SELECT },
    );
    check('AC-002  the unclaimed 120,000 is posted as breakage',
      breakage.length === 1 && Number(breakage[0].amount_minor) === naira(120_000),
      show(breakage[0]?.amount_minor));
    check('...with the cause recorded, so the report can say WHY',
      /ABSENT/.test(breakage[0]?.metadata || ''),
      'a company cannot act on "money went unallocated"');
    check('...and the deal still reconciles to the pool',
      Number(allocated) + Number(breakage[0].amount_minor) === naira(1_500_000),
      `${show(allocated)} + ${show(breakage[0].amount_minor)}`);
  }

  console.log('\n── Somebody inactive at attribution never accrues at all ───────');
  {
    await sequelize.query(`INSERT INTO users (id, name, email, password, type, realtor_code, realtor_id, realtor_level_id, company_id, created_at, updated_at)
      VALUES (20, 'Dormant', 'dormant@test', 'x', 'realtor', 'EEEEE', NULL, 1, 1, '2026-01-01', NOW())`);
    await recordStatus(sequelize, { userId: 20, status: STATUS.INACTIVE, at: '2026-01-01T00:00:00Z' });

    const result = await store.accrueForDeal(sequelize, {
      ...deal, deal_ref: 'DEAL-2', selling_realtor_id: 20,
    });
    check('FR-ELG-001  no entitlement is created for them', result.accrued === 0, `${result.accrued}`);
    const rows = await sequelize.query(
      "SELECT COUNT(*) AS n FROM commission_entitlements WHERE deal_ref = 'DEAL-2'", { type: QueryTypes.SELECT },
    );
    check('...not even a zero one, which would read as "the rules paid nothing"',
      Number(rows[0].n) === 0);
  }

  // ── The history maintains itself ──────────────────────────────────────────
  console.log('\n── Status history is kept by the model, not by call sites ──────');
  {
    const { statusAt, STATUS } = require('../shared/src/realtorStatus');

    const historyOf = (userId) => sequelize.query(
      `SELECT status, reason, note, changed_by, effective_from
         FROM realtor_status_history WHERE user_id = :userId ORDER BY id ASC`,
      { replacements: { userId }, type: QueryTypes.SELECT },
    );

    // ── Creation ────────────────────────────────────────────────────────────
    const fresh = await User.create({
      name: 'Newly Hired', email: `hired.${Date.now()}@example.test`, password: 'x',
      type: 'realtor', company_id: 1, realtor_level_id: 1, is_active: true,
    });
    let rows = await historyOf(fresh.id);
    check('A realtor created AFTER the backfill still gets a history',
      rows.length === 1 && rows[0].status === STATUS.ACTIVE,
      'without this the gate refuses them and every entitlement is forfeited');

    // ...and the engine can therefore actually pay them.
    const eligible = await statusAt(sequelize, fresh.id, new Date());
    check('...so the gate can place them', eligible.status === STATUS.ACTIVE, eligible.status);

    // ── A client is not a realtor ──────────────────────────────────────────
    const buyer = await User.create({
      name: 'Just A Buyer', email: `buyer.${Date.now()}@example.test`, password: 'x',
      type: 'client', company_id: 1, is_active: true,
    });
    check('A client gets no history — they never earn (§5.10)',
      (await historyOf(buyer.id)).length === 0);

    // ── Promotion ───────────────────────────────────────────────────────────
    await buyer.update({ type: 'realtor' });
    check('...until they become one, and then they do',
      (await historyOf(buyer.id)).length === 1,
      'a client promoted to realtor needs their first row');

    // ── Deactivation, with a reason that means something ────────────────────
    await fresh.update({ is_active: false }, {
      statusReason: 'compliance_lapse', statusNote: 'KYC expired', statusActorId: 5,
    });
    rows = await historyOf(fresh.id);
    check('Deactivating appends a transition', rows.length === 2 && rows[1].status === STATUS.INACTIVE,
      rows.map((r) => r.status).join(' → '));
    check('...carrying the reason the endpoint knew, not just the flag that moved',
      rows[1].reason === 'compliance_lapse' && rows[1].note === 'KYC expired',
      `${rows[1].reason} — FR-ELG-008 lets disposition vary by this`);
    check('...and who did it', Number(rows[1].changed_by) === 5);

    // ── Noise ───────────────────────────────────────────────────────────────
    await fresh.update({ name: 'Renamed Person' });
    check('Renaming somebody appends nothing',
      (await historyOf(fresh.id)).length === 2,
      'a history that fills with "still inactive" cannot explain a forfeiture');

    await fresh.update({ is_active: false });
    check('Re-saving the SAME status appends nothing either',
      (await historyOf(fresh.id)).length === 2);

    // ── Reinstatement ───────────────────────────────────────────────────────
    await fresh.update({ is_active: true }, { statusReason: 'reinstatement' });
    rows = await historyOf(fresh.id);
    check('Reinstating appends the return', rows.length === 3 && rows[2].status === STATUS.ACTIVE,
      rows.map((r) => r.status).join(' → '));

    /**
     * ── The point of all of it ────────────────────────────────────────────
     *
     * The spell out of action is still IN the history after reinstatement.
     * That is the whole difference from a current-status column, which would
     * now read `active` and make a forfeiture recorded during the gap
     * inexplicable.
     *
     * Asserted on the sequence rather than by querying an instant: these three
     * transitions are milliseconds apart and the column is second-resolution,
     * so a point-in-time query between them is a coin toss. The release check
     * further up covers that question properly, with dates weeks apart.
     */
    check('FR-ELG-013  the spell out of action survives reinstatement',
      rows.map((r) => r.status).join(',') === 'active,inactive,active',
      rows.map((r) => r.status).join(' → '));
    check('...and nothing was overwritten to get there',
      rows.length === 3, 'the history is appended to, never updated');

    // ── Soft deletion ───────────────────────────────────────────────────────
    await fresh.update({ deleted_at: new Date(), is_active: false }, {
      statusReason: 'termination_for_cause',
    });
    rows = await historyOf(fresh.id);
    check('Deleting the account records TERMINATED, not merely inactive',
      rows[rows.length - 1].status === STATUS.TERMINATED
        && rows[rows.length - 1].reason === 'termination_for_cause',
      rows.map((r) => r.status).join(' → '));
  }

  // ── The plan API ──────────────────────────────────────────────────────────
  console.log('\n── Plans are created as drafts and activated deliberately ──────');
  {
    const controller = require('../services/finance-service/src/controllers/commissionPlanController');
    const ADMIN = { id: 5, type: 'super_admin', effectiveType: 'super_admin', company_id: 1 };

    const call = (handler, req) => new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(payload) { resolve({ status: this.statusCode, ...payload }); return this; },
      };
      Promise.resolve(handler({ user: ADMIN, query: {}, params: {}, body: {}, ...req }, res,
        (e) => resolve({ status: e?.status || 500, message: e?.message })))
        .catch((e) => resolve({ status: 500, message: e.message }));
    });

    const created = await call(controller.createPlan, {
      body: { name: 'Engine Plan', config: PLAN_CONFIG, is_default: false },
    });
    check('A new plan is created', created.status === 201, `${created.status}`);
    check('...as a DRAFT, not live',
      created.data?.status === 'draft',
      'a structure typed into a form is not yet a decision');

    const planId = created.data.id;
    const beforeActivation = await store.resolvePlanVersion(sequelize, {
      companyId: 1, propertyId: 999, at: '2026-08-01T00:00:00Z',
    });
    check('...and a draft pays nothing until it is activated',
      beforeActivation?.plan_id !== planId,
      'resolution only ever sees active versions');

    const detail = await call(controller.getPlan, { params: { id: planId } });
    const versionId = detail.data.versions[0].id;
    const activated = await call(controller.activateVersion, { params: { versionId } });
    check('Activating it makes it live', activated.status === 200 && activated.data?.status === 'active',
      `${activated.status}`);

    // ── A plan the validator refuses ────────────────────────────────────────
    const broken = await call(controller.createPlan, {
      body: {
        name: 'Broken Plan',
        config: {
          pool: { mode: 'UNCAPPED' },
          // A percentage with no basis: the ambiguity §5.4 exists to remove.
          rules: [{ id: 'd', type: 'DIRECT_SALE', value_type: 'PERCENTAGE', value: 5 }],
        },
      },
    });
    check('A plan with an undeclared basis still saves as a draft', broken.status === 201);
    check('...but is reported as unactivatable, with the reason',
      broken.validation?.ok === false
        && broken.validation.errors.some((e) => e.code === 'BASIS_UNDEFINED'),
      broken.validation?.errors?.[0]?.message);

    const brokenDetail = await call(controller.getPlan, { params: { id: broken.data.id } });
    const refused = await call(controller.activateVersion, {
      params: { versionId: brokenDetail.data.versions[0].id },
    });
    check('...and activation is refused outright',
      refused.status === 422, `${refused.status} — a plan that cannot be calculated must not start paying`);
  }

  console.log('\n── The simulator runs the real engine and writes nothing ───────');
  {
    const controller = require('../services/finance-service/src/controllers/commissionPlanController');
    const before = await sequelize.query('SELECT COUNT(*) AS n FROM commission_entitlements', { type: QueryTypes.SELECT });

    const result = await new Promise((resolve) => {
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(p) { resolve(p); return this; } };
      controller.simulate({
        user: { id: 5, type: 'super_admin', effectiveType: 'super_admin', company_id: 1 },
        query: {}, params: {},
        body: { config: PLAN_CONFIG, price_minor: naira(50_000_000), generations: 3, level_rate: 6 },
      }, res, () => {});
    });

    check('It reproduces §10.1 exactly',
      result.data?.allocated_minor === naira(4_000_000), show(result.data?.allocated_minor));
    check('...and reports the cost as a share of the sale',
      Math.abs(result.data.cost_ratio - 0.08) < 1e-9, `${(result.data.cost_ratio * 100).toFixed(2)}%`);

    const after = await sequelize.query('SELECT COUNT(*) AS n FROM commission_entitlements', { type: QueryTypes.SELECT });
    check('FR-SIM-005  nothing was written',
      Number(before[0].n) === Number(after[0].n), `${after[0].n} entitlements, unchanged`);
  }

  console.log('\n── Taxes and charges on a commission ────────────────────────────');
  {
    const controller = require('../services/finance-service/src/controllers/commissionPlanController');
    const simulate = (config) => new Promise((resolve) => {
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(p) { resolve(p); return this; } };
      controller.simulate({
        user: { id: 5, type: 'super_admin', effectiveType: 'super_admin', company_id: 1 },
        query: {}, params: {},
        body: { config, price_minor: naira(50_000_000), generations: 3, level_rate: 6 },
      }, res, () => {});
    });

    const plain = await simulate(PLAN_CONFIG);
    check('With no charges configured there is no net figure to show',
      plain.data?.net_to_seller === null, JSON.stringify(plain.data?.net_to_seller));

    /**
     * 5% withholding and a 2.5% admin charge, BOTH on the gross.
     *
     * The base is the seller's CONSTRAINED entitlement, not their headline 6%.
     * This plan's rules claim 9% between them against an 8% cap, so PRORATE
     * reduces everyone — the seller's 3,000,000 claim becomes 4,000,000 × 6/9,
     * or 2,666,666.67. Charges apply to what the person is actually entitled
     * to, which is the figure after the cap and never the one before it.
     *
     * 5% of that is 133,333.34 and 2.5% is 66,666.67 — both rounded UP, because
     * a statutory withholding that rounds down leaves the company remitting
     * less than it withheld. Net: 2,466,666.66.
     */
    const bothOnGross = await simulate({
      ...PLAN_CONFIG,
      deductions: [
        { code: 'WHT', label: 'Withholding tax', type: 'PERCENTAGE', value: 5, basis: 'GROSS', order: 0 },
        { code: 'ADMIN', label: 'Admin charge', type: 'PERCENTAGE', value: 2.5, basis: 'GROSS', order: 1 },
      ],
    });
    check('Charges on the gross come off the seller\'s own entitlement',
      bothOnGross.data?.net_to_seller?.net_minor === 246_666_666,
      show(bothOnGross.data?.net_to_seller?.net_minor));
    check('...and each one is itemised, so a realtor can see why',
      bothOnGross.data?.net_to_seller?.lines?.length === 2,
      (bothOnGross.data?.net_to_seller?.lines || []).map((l) => `${l.label} ${show(l.amount_minor)}`).join(', '));

    /**
     * The same two charges, but the admin one on the RUNNING balance. Now it is
     * 2.5% of 2,533,333.33 rather than of 2,666,666.67 — 63,333.34 rather than
     * 66,666.67, and the realtor is paid 3,333.33 more.
     *
     * This is why the basis is configurable rather than assumed: both
     * arrangements exist, jurisdictions differ, and a system that fixed one
     * would be quietly wrong for every tenant on the other — wrong by an amount
     * small enough that nobody notices until a tax return does.
     */
    const adminOnRunning = await simulate({
      ...PLAN_CONFIG,
      deductions: [
        { code: 'WHT', label: 'Withholding tax', type: 'PERCENTAGE', value: 5, basis: 'GROSS', order: 0 },
        { code: 'ADMIN', label: 'Admin charge', type: 'PERCENTAGE', value: 2.5, basis: 'RUNNING', order: 1 },
      ],
    });
    check('The order and basis change the answer, which is why they are settings',
      adminOnRunning.data?.net_to_seller?.net_minor === 246_999_999,
      `${show(adminOnRunning.data?.net_to_seller?.net_minor)} against `
      + `${show(bothOnGross.data?.net_to_seller?.net_minor)} when both are on the gross`);

    /**
     * A profile that asks for more than the commission. The realtor is paid
     * nothing — never a negative amount, which would be a bill for having made
     * a sale.
     */
    const greedy = await simulate({
      ...PLAN_CONFIG,
      deductions: [
        { code: 'A', label: 'Everything', type: 'PERCENTAGE', value: 80, basis: 'GROSS', order: 0 },
        { code: 'B', label: 'And more', type: 'PERCENTAGE', value: 60, basis: 'GROSS', order: 1 },
      ],
    });
    check('Charges beyond the commission floor at zero rather than going negative',
      greedy.data?.net_to_seller?.net_minor === 0,
      show(greedy.data?.net_to_seller?.net_minor));
    check('...and the line that was cut short says so',
      (greedy.data?.net_to_seller?.lines || []).some((line) => line.capped), '');
  }

  console.log('\n── Only ONE commission system pays for a sale ──────────────────');
  {
    const { dealFromInvoice } = require('../services/finance-service/src/services/commissionBridge');
    await sequelize.query(`CREATE TABLE invoices (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, client_id INT UNSIGNED, property_id INT UNSIGNED,
      company_id INT UNSIGNED, discount DECIMAL(12,2) DEFAULT 0, created_at DATETIME)`);
    await sequelize.query(`INSERT INTO users (id, name, email, password, type, company_id, realtor_id, created_at, updated_at)
      VALUES (40, 'Buyer', 'buyer@test', 'x', 'client', 1, 10, '2026-01-01', NOW())`);
    await sequelize.query(`INSERT INTO invoices (id, client_id, property_id, company_id, created_at)
      VALUES (900, 40, 100, 1, '2026-08-01')`);

    const [invoice] = await sequelize.query('SELECT * FROM invoices WHERE id = 900', { type: QueryTypes.SELECT });
    const built = await dealFromInvoice(invoice, naira(50_000_000));

    check('The deal is attributed to the buyer\'s own realtor',
      built.selling_realtor_id === 10, `realtor ${built.selling_realtor_id}`);
    check('...and dated to when the INVOICE was raised, not when it was paid',
      new Date(built.attribution_date).toISOString().startsWith('2026-08-01'),
      'a plan change mid-instalment must not reprice a sale agreed under the old one');
    check('...with a deal_ref derived from the invoice, so a replay is recognisable',
      built.deal_ref === 'INV-900', built.deal_ref);
  }

  console.log('\n── Results ─────────────────────────────────────────────────────\n');
  console.log(`  ${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass}/${pass + fail} checks passed.\x1b[0m`);

  await sequelize.close();
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();
  console.log(`\n  Scratch database ${DB} dropped.\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\n\x1b[31mThe verification itself failed:\x1b[0m', error);
  process.exit(1);
});

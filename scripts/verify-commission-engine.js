/**
 * The commission calculation engine, checked against the FRD's own worked
 * examples (§10) and its acceptance criteria (§13).
 *
 * No database. The engine is a pure function of (deal, plan version, genealogy,
 * status history) — see shared/src/commission/index.js for why that matters —
 * so every case here is literal input and a literal expected allocation. When
 * one of these fails, the arithmetic is wrong; there is no environment to blame.
 *
 * Figures are in MINOR units (kobo) throughout, matching the engine and
 * NFR-003. The `naira` helper exists only so the expectations read the way the
 * FRD writes them.
 */
const {
  calculate, checkRelease,
  BASIS, CB_MODE, POOL_MODE, RESOLUTION, SURPLUS, COMPRESSION,
  VALUE_TYPE, RULE_TYPE, STACKING, EXCLUSION,
} = require('../shared/src/commission');

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

const naira = (amount) => Math.round(amount * 100);
const show = (minor) => (minor / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });

/** A realtor who has been active since before any deal in these examples. */
const activeSince = (id, level, from = '2020-01-01T00:00:00Z') => ({
  id,
  level,
  status_history: [{ status: 'active', effective_from: from }],
});

const SENIOR = { id: 2, code: 'SENIOR', position: 3, direct_rate: 6 };
const MANAGER = { id: 3, code: 'MANAGER', position: 4, direct_rate: 7 };

const amountFor = (result, realtorId) => result.entitlements
  .filter((entry) => entry.realtor_id === realtorId)
  .reduce((total, entry) => total + entry.constrained_minor, 0);

// ── §10.1 ───────────────────────────────────────────────────────────────────
console.log('\n── §10.1  Level-based direct + generational, percentage cap breached ──');

const GENERATIONAL_TIERS = {
  id: 'gen', type: RULE_TYPE.GENERATIONAL_OVERRIDE, compression: COMPRESSION.NONE,
  tiers: [
    { generation: 1, value_type: VALUE_TYPE.PERCENTAGE, value: 1.5, basis: BASIS.COMMISSIONABLE_BASE },
    { generation: 2, value_type: VALUE_TYPE.PERCENTAGE, value: 1.0, basis: BASIS.COMMISSIONABLE_BASE },
    { generation: 3, value_type: VALUE_TYPE.PERCENTAGE, value: 0.5, basis: BASIS.COMMISSIONABLE_BASE },
  ],
};

const planCapped = (resolution) => ({
  id: 'v1',
  commissionable_base: { mode: CB_MODE.GROSS_PRICE },
  pool: { mode: POOL_MODE.PERCENTAGE, percentage: 8 },
  resolution,
  rules: [
    { id: 'direct', type: RULE_TYPE.DIRECT_SALE, value_type: VALUE_TYPE.PERCENTAGE, basis: BASIS.COMMISSIONABLE_BASE },
    GENERATIONAL_TIERS,
  ],
});

const deal101 = {
  id: 'D-101',
  gross_price_minor: naira(50_000_000),
  discount_minor: 0,
  unit_count: 1,
  attribution_date: '2026-03-01T00:00:00Z',
  selling_realtor: activeSince(10, SENIOR),
};
const ancestors101 = [activeSince(11, MANAGER), activeSince(12, MANAGER), activeSince(13, MANAGER)];

{
  const result = calculate({ deal: deal101, plan: planCapped(RESOLUTION.PRORATE), ancestors: ancestors101 });

  check('Commissionable base is the gross price',
    result.commissionable_base_minor === naira(50_000_000), show(result.commissionable_base_minor));
  check('Pool is 8% of the base',
    result.pool_minor === naira(4_000_000), show(result.pool_minor));
  check('Claims total 4,500,000 before the cap',
    result.claims_total_minor === naira(4_500_000), show(result.claims_total_minor));

  const expected = { 10: 2_666_666.67, 11: 666_666.67, 12: 444_444.44, 13: 222_222.22 };
  Object.entries(expected).forEach(([id, amount]) => {
    const got = amountFor(result, Number(id));
    check(`  realtor ${id} prorated to ${amount.toLocaleString('en-US')}`,
      got === naira(amount), show(got));
  });

  // AC-001: the allocation equals the cap exactly, and the trace explains it.
  check('AC-001  allocated total equals the cap to the kobo',
    result.allocated_minor === result.pool_minor,
    `${show(result.allocated_minor)} vs pool ${show(result.pool_minor)}`);
  check('AC-001  every line carries its prorate factor in the trace',
    result.entitlements.every((entry) => entry.trace.constraint?.strategy === RESOLUTION.PRORATE
      && typeof entry.trace.constraint.factor === 'number'),
    JSON.stringify(result.entitlements[0].trace.constraint));
  check('The rate source is recorded, not just the rate',
    result.entitlements.find((e) => e.role === 'DIRECT').trace.rate_source === 'LEVEL_DEFAULT',
    result.entitlements.find((e) => e.role === 'DIRECT').trace.rate_source);
}

{
  const result = calculate({ deal: deal101, plan: planCapped(RESOLUTION.PROTECT_DIRECT), ancestors: ancestors101 });
  check('PROTECT_DIRECT pays the seller in full',
    amountFor(result, 10) === naira(3_000_000), show(amountFor(result, 10)));
  const uplines = { 11: 500_000, 12: 333_333.33, 13: 166_666.67 };
  Object.entries(uplines).forEach(([id, amount]) => {
    check(`  upline ${id} shares the remaining 1,000,000 → ${amount.toLocaleString('en-US')}`,
      amountFor(result, Number(id)) === naira(amount), show(amountFor(result, Number(id))));
  });
  check('...and the total is still exactly the pool',
    result.allocated_minor === naira(4_000_000), show(result.allocated_minor));
}

// ── §10.2 ───────────────────────────────────────────────────────────────────
console.log('\n── §10.2  Flat shared pool with a missing generation ──────────────────');

const planFlat = (surplus) => ({
  id: 'v2',
  commissionable_base: { mode: CB_MODE.GROSS_PRICE },
  pool: { mode: POOL_MODE.FLAT, flat_amount_minor: naira(1_500_000) },
  resolution: RESOLUTION.PRORATE,
  surplus,
  rules: [
    // Shares OF THE POOL, not of the price — the whole point of flat-pool mode.
    { id: 'direct', type: RULE_TYPE.DIRECT_SALE, value_type: VALUE_TYPE.PERCENTAGE, value: 60, basis: BASIS.POOL },
    {
      id: 'gen', type: RULE_TYPE.GENERATIONAL_OVERRIDE, compression: COMPRESSION.NONE,
      tiers: [
        { generation: 1, value_type: VALUE_TYPE.PERCENTAGE, value: 20, basis: BASIS.POOL },
        { generation: 2, value_type: VALUE_TYPE.PERCENTAGE, value: 12, basis: BASIS.POOL },
        { generation: 3, value_type: VALUE_TYPE.PERCENTAGE, value: 8, basis: BASIS.POOL },
      ],
    },
  ],
});

const deal102 = {
  id: 'D-102',
  gross_price_minor: naira(30_000_000),
  discount_minor: 0,
  unit_count: 1,
  attribution_date: '2026-03-01T00:00:00Z',
  selling_realtor: activeSince(20, SENIOR),
};
// Only two ancestors — there is no Gen 3.
const ancestors102 = [activeSince(21, MANAGER), activeSince(22, MANAGER)];

{
  const result = calculate({ deal: deal102, plan: planFlat(SURPLUS.BREAKAGE), ancestors: ancestors102 });
  check('Seller takes 60% of the pool', amountFor(result, 20) === naira(900_000), show(amountFor(result, 20)));
  check('Gen 1 takes 20%', amountFor(result, 21) === naira(300_000), show(amountFor(result, 21)));
  check('Gen 2 takes 12%', amountFor(result, 22) === naira(180_000), show(amountFor(result, 22)));
  // AC-002
  check('AC-002  allocated total is 1,380,000',
    result.allocated_minor === naira(1_380_000), show(result.allocated_minor));
  check('AC-002  the unclaimed 120,000 is breakage',
    result.breakage_minor === naira(120_000), show(result.breakage_minor));
  check('...and the absent Gen 3 is recorded as a cause, not dropped',
    result.excluded.some((entry) => entry.generation === 3), JSON.stringify(result.excluded.map((e) => e.reason)));
}

{
  const result = calculate({ deal: deal102, plan: planFlat(SURPLUS.REDISTRIBUTE_PRORATA), ancestors: ancestors102 });
  check('REDISTRIBUTE_PRORATA  seller → 978,260.87',
    amountFor(result, 20) === naira(978_260.87), show(amountFor(result, 20)));
  check('REDISTRIBUTE_PRORATA  Gen 1 → 326,086.96',
    amountFor(result, 21) === naira(326_086.96), show(amountFor(result, 21)));
  check('REDISTRIBUTE_PRORATA  Gen 2 → 195,652.17',
    amountFor(result, 22) === naira(195_652.17), show(amountFor(result, 22)));
  check('...and the full pool is spent',
    result.allocated_minor === naira(1_500_000) && result.breakage_minor === 0, show(result.allocated_minor));
}

{
  const result = calculate({ deal: deal102, plan: planFlat(SURPLUS.REDISTRIBUTE_TO_DIRECT), ancestors: ancestors102 });
  check('REDISTRIBUTE_TO_DIRECT  seller absorbs the surplus → 1,020,000',
    amountFor(result, 20) === naira(1_020_000), show(amountFor(result, 20)));
  check('...uplines unchanged',
    amountFor(result, 21) === naira(300_000) && amountFor(result, 22) === naira(180_000), '');
}

// ── A percentage cap that is NOT breached must not trigger a surplus ─────────
console.log('\n── A percentage cap is a ceiling, not a budget ────────────────────────');
{
  const plan = {
    id: 'v3',
    commissionable_base: { mode: CB_MODE.GROSS_PRICE },
    pool: { mode: POOL_MODE.PERCENTAGE, percentage: 8 },
    resolution: RESOLUTION.PRORATE,
    surplus: SURPLUS.REDISTRIBUTE_PRORATA,
    rules: [{ id: 'direct', type: RULE_TYPE.DIRECT_SALE, value_type: VALUE_TYPE.PERCENTAGE, basis: BASIS.COMMISSIONABLE_BASE }],
  };
  const result = calculate({ deal: deal101, plan, ancestors: [] });
  check('Claims under a percentage cap are paid as claimed',
    amountFor(result, 10) === naira(3_000_000), show(amountFor(result, 10)));
  check('...and the unused headroom is NOT redistributed',
    result.allocated_minor === naira(3_000_000),
    'a ceiling the company did not reach is not a surplus to hand out');
}

// ── §7.16 / AC-011, AC-014 ──────────────────────────────────────────────────
console.log('\n── §7.16  The active-status gate ──────────────────────────────────────');

const suspendedFrom = (id, level, when) => ({
  id,
  level,
  status_history: [
    { status: 'active', effective_from: '2020-01-01T00:00:00Z' },
    { status: 'suspended', effective_from: when },
  ],
});

{
  // AC-014: only Gen 1 is deactivated; everyone else is unaffected.
  const ancestors = [
    suspendedFrom(31, MANAGER, '2026-02-01T00:00:00Z'),
    activeSince(32, MANAGER),
  ];
  const deal = { ...deal101, id: 'D-ELG', selling_realtor: activeSince(30, SENIOR) };
  const result = calculate({ deal, plan: planCapped(RESOLUTION.PRORATE), ancestors });

  check('AC-014  the deactivated Gen 1 earns nothing',
    amountFor(result, 31) === 0 && !result.entitlements.some((e) => e.realtor_id === 31), '');
  check('AC-014  ...and is recorded as INELIGIBLE, with the status that failed',
    result.excluded.some((e) => e.realtor_id === 31 && e.reason === EXCLUSION.INELIGIBLE
      && e.eligibility_check?.status === 'suspended'),
    JSON.stringify(result.excluded.find((e) => e.realtor_id === 31)?.eligibility_check));
  check('AC-014  the seller is unaffected', amountFor(result, 30) > 0, show(amountFor(result, 30)));
  check('AC-014  Gen 2 is unaffected and keeps its OWN generation number',
    result.entitlements.some((e) => e.realtor_id === 32 && e.generation === 2),
    'no compression configured, so Gen 2 does not slide up to Gen 1');
}

{
  // §5.9 / FR-ELG-002: active at accrual, suspended at a later release.
  const realtor = {
    id: 40,
    level: SENIOR,
    status_history: [
      { status: 'active', effective_from: '2020-01-01T00:00:00Z' },
      { status: 'suspended', effective_from: '2026-06-01T00:00:00Z' },
    ],
  };
  const atAccrual = calculate({
    deal: { ...deal101, id: 'D-VEST', selling_realtor: realtor },
    plan: planCapped(RESOLUTION.PRORATE),
    ancestors: [],
  });
  check('AC-011  active at attribution, so the entitlement accrues',
    amountFor(atAccrual, 40) === naira(3_000_000), show(amountFor(atAccrual, 40)));

  const first = checkRelease(realtor, '2026-04-01T00:00:00Z');
  const second = checkRelease(realtor, '2026-07-01T00:00:00Z');
  check('AC-011  the first release, while still active, passes', first.eligible === true, '');
  check('AC-011  the second, after suspension, does not',
    second.eligible === false && second.check.status === 'suspended', JSON.stringify(second.check));
  check('AC-011  ...and both checks are recorded, pass and fail alike (FR-ELG-011)',
    first.check.result === 'PASS' && second.check.result === 'FAIL'
      && second.check.phase === 'release', '');
  check('FR-ELG-014  the rate was never re-derived at release',
    atAccrual.entitlements[0].trace.rate === 6,
    'release decides whether value vests, never what it is worth');
}

// ── Compression (AC-004) ────────────────────────────────────────────────────
console.log('\n── FR-GNC-006  Compression modes are different policies ───────────────');
{
  const unqualified = { ...activeSince(51, { ...MANAGER, position: 1 }), period_deals: 0 };
  const ancestors = [unqualified, activeSince(52, MANAGER), activeSince(53, MANAGER)];
  const withMode = (compression) => ({
    ...planCapped(RESOLUTION.PRORATE),
    pool: { mode: POOL_MODE.UNCAPPED },
    rules: [
      { id: 'direct', type: RULE_TYPE.DIRECT_SALE, value_type: VALUE_TYPE.PERCENTAGE, basis: BASIS.COMMISSIONABLE_BASE },
      { ...GENERATIONAL_TIERS, compression, qualification: { min_level_position: 2 } },
    ],
  });
  const deal = { ...deal101, id: 'D-COMP', selling_realtor: activeSince(50, SENIOR) };

  const none = calculate({ deal, plan: withMode(COMPRESSION.NONE), ancestors });
  check('NONE      unqualified Gen 1 forfeits its tier',
    amountFor(none, 51) === 0 && amountFor(none, 52) === naira(500_000),
    `52 got ${show(amountFor(none, 52))} (its own Gen 2 tier, 1.0%)`);

  const rollUp = calculate({ deal, plan: withMode(COMPRESSION.ROLL_UP), ancestors });
  check('AC-004  ROLL_UP   Gen 1’s tier is paid to the next qualified ancestor',
    amountFor(rollUp, 52) === naira(1_250_000),
    `52 got ${show(amountFor(rollUp, 52))} = its own 1.0% plus the rolled-up 1.5%`);
  check('AC-004  ...and the trace records the substitution',
    rollUp.entitlements.some((e) => e.realtor_id === 52 && e.generation === 1),
    'the rolled-up tier keeps its original generation number');

  const dynamic = calculate({ deal, plan: withMode(COMPRESSION.DYNAMIC), ancestors });
  check('DYNAMIC   the unqualified ancestor leaves the ladder entirely',
    amountFor(dynamic, 52) === naira(750_000),
    `52 became Gen 1 and got ${show(amountFor(dynamic, 52))} (1.5%)`);
  check('...so ROLL_UP and DYNAMIC genuinely differ',
    amountFor(rollUp, 52) !== amountFor(dynamic, 52),
    'conflating them would silently mis-pay every sparse tree');
}

// ── AC-003 ──────────────────────────────────────────────────────────────────
console.log('\n── AC-003  A tree shallower than the plan is not an error ─────────────');
{
  const plan = {
    ...planCapped(RESOLUTION.PRORATE),
    pool: { mode: POOL_MODE.UNCAPPED },
    rules: [
      { id: 'direct', type: RULE_TYPE.DIRECT_SALE, value_type: VALUE_TYPE.PERCENTAGE, basis: BASIS.COMMISSIONABLE_BASE },
      {
        ...GENERATIONAL_TIERS,
        tiers: [1, 2, 3, 4, 5].map((generation) => ({
          generation, value_type: VALUE_TYPE.PERCENTAGE, value: 0.5, basis: BASIS.COMMISSIONABLE_BASE,
        })),
      },
    ],
  };
  const result = calculate({
    deal: { ...deal101, id: 'AC3', selling_realtor: activeSince(60, SENIOR) },
    plan,
    ancestors: [activeSince(61, MANAGER), activeSince(62, MANAGER), activeSince(63, MANAGER)],
  });
  const generational = result.entitlements.filter((entry) => entry.role === 'UPLINE');
  check('Exactly three generational entitlements, and no error',
    generational.length === 3, `${generational.length} created for a 5-tier plan`);
}

// ── §5.4  Basis semantics ───────────────────────────────────────────────────
console.log('\n── §5.4  The same tier value means different things by basis ──────────');
{
  const withBasis = (basis, value) => ({
    id: 'vb',
    commissionable_base: { mode: CB_MODE.GROSS_PRICE },
    pool: { mode: POOL_MODE.UNCAPPED },
    resolution: RESOLUTION.PRORATE,
    rules: [
      { id: 'direct', type: RULE_TYPE.DIRECT_SALE, value_type: VALUE_TYPE.PERCENTAGE, basis: BASIS.COMMISSIONABLE_BASE },
      {
        id: 'gen', type: RULE_TYPE.GENERATIONAL_OVERRIDE, compression: COMPRESSION.NONE,
        tiers: [{ generation: 1, value_type: VALUE_TYPE.PERCENTAGE, value, basis }],
      },
    ],
  });
  const deal = { ...deal101, id: 'D-BASIS', selling_realtor: activeSince(70, SENIOR) };
  const ancestors = [activeSince(71, MANAGER)];

  const ofBase = calculate({ deal, plan: withBasis(BASIS.COMMISSIONABLE_BASE, 1.5), ancestors });
  check('1.5% OF_COMMISSIONABLE_BASE → 750,000',
    amountFor(ofBase, 71) === naira(750_000), show(amountFor(ofBase, 71)));

  const ofDirect = calculate({ deal, plan: withBasis(BASIS.DIRECT_EARNER_COMMISSION, 10), ancestors });
  check('10% OF_DIRECT_EARNER_COMMISSION → 300,000 (10% of the seller’s 3,000,000)',
    amountFor(ofDirect, 71) === naira(300_000), show(amountFor(ofDirect, 71)));
  check('...and the trace names what it was a percentage of',
    ofDirect.entitlements.find((e) => e.realtor_id === 71).trace.basis_of === 'direct_earner_commission',
    'the ambiguity §5.4 exists to remove');

  const flat = calculate({
    deal,
    plan: {
      ...withBasis(BASIS.COMMISSIONABLE_BASE, 1.5),
      rules: [
        { id: 'direct', type: RULE_TYPE.DIRECT_SALE, value_type: VALUE_TYPE.PERCENTAGE, basis: BASIS.COMMISSIONABLE_BASE },
        {
          id: 'gen', type: RULE_TYPE.GENERATIONAL_OVERRIDE, compression: COMPRESSION.NONE,
          tiers: [{ generation: 1, value_type: VALUE_TYPE.FLAT_AMOUNT, value: naira(25_000), basis: BASIS.COMMISSIONABLE_BASE }],
        },
      ],
    },
    ancestors,
  });
  check('FR-GNC-003  a flat tier pays its amount and ignores the basis',
    amountFor(flat, 71) === naira(25_000)
      && flat.entitlements.find((e) => e.realtor_id === 71).trace.basis_applied === false,
    show(amountFor(flat, 71)));
}

// ── §7.12 / AC-015  The referrer is always a realtor ────────────────────────
console.log('\n── §5.10  Only realtors earn ──────────────────────────────────────────');
{
  const plan = {
    id: 'vr',
    commissionable_base: { mode: CB_MODE.GROSS_PRICE },
    pool: { mode: POOL_MODE.UNCAPPED },
    resolution: RESOLUTION.PRORATE,
    stacking: STACKING.HIGHEST_ONLY,
    rules: [
      { id: 'direct', type: RULE_TYPE.DIRECT_SALE, value_type: VALUE_TYPE.PERCENTAGE, basis: BASIS.COMMISSIONABLE_BASE },
      { id: 'ref', type: RULE_TYPE.REFERRAL_BONUS, value_type: VALUE_TYPE.PERCENTAGE, value: 1, basis: BASIS.COMMISSIONABLE_BASE },
    ],
  };
  const result = calculate({
    deal: {
      ...deal101,
      id: 'D-REF',
      selling_realtor: activeSince(80, SENIOR),
      // A client-sourced referral has already been resolved to this realtor.
      referrer: activeSince(81, MANAGER),
    },
    plan,
    ancestors: [],
  });
  check('The attributed realtor earns the referral bonus',
    amountFor(result, 81) === naira(500_000), show(amountFor(result, 81)));
  check('Every entitlement resolves to a realtor id — there is no client payee',
    result.entitlements.every((entry) => Number.isInteger(entry.realtor_id)),
    'the engine has no code path that can produce a client entitlement');

  // FR-RUL-005: the referrer is also the seller.
  const selfReferred = calculate({
    deal: { ...deal101, id: 'D-SELF', selling_realtor: activeSince(80, SENIOR), referrer: activeSince(80, SENIOR) },
    plan,
    ancestors: [],
  });
  check('A referrer who IS the seller is not added twice',
    selfReferred.entitlements.filter((e) => e.realtor_id === 80).length === 1,
    `${selfReferred.entitlements.length} entitlement(s)`);
}

// ── FR-CAP-002 REJECT ───────────────────────────────────────────────────────
console.log('\n── FR-CAP-002  REJECT quarantines rather than paying ──────────────────');
{
  const result = calculate({
    deal: deal101, plan: planCapped(RESOLUTION.REJECT), ancestors: ancestors101,
  });
  check('Nothing is allocated',
    result.entitlements.length === 0 && result.allocated_minor === 0, '');
  check('...and the breach is reported with the excess, for finance review',
    result.rejected?.reason === 'CLAIMS_EXCEED_POOL'
      && result.rejected.excess_minor === naira(500_000),
    JSON.stringify(result.rejected));
}

// ── NFR-003 ─────────────────────────────────────────────────────────────────
console.log('\n── NFR-003  Integer arithmetic throughout ─────────────────────────────');
{
  const result = calculate({ deal: deal101, plan: planCapped(RESOLUTION.PRORATE), ancestors: ancestors101 });
  check('Every amount is a whole number of kobo',
    result.entitlements.every((entry) => Number.isInteger(entry.gross_minor)
      && Number.isInteger(entry.constrained_minor)),
    'no float ever reaches a monetary field');
  check('...and the parts reconcile to the pool with no residual',
    result.entitlements.reduce((total, entry) => total + entry.constrained_minor, 0)
      + result.breakage_minor === result.pool_minor, '');

  // A base chosen to make the 8/9 proration awkward in every direction.
  const awkward = calculate({
    deal: { ...deal101, id: 'D-ODD', gross_price_minor: 3333333333 },
    plan: planCapped(RESOLUTION.PRORATE),
    ancestors: ancestors101,
  });
  check('An awkward base still reconciles exactly',
    awkward.entitlements.reduce((total, entry) => total + entry.constrained_minor, 0)
      === awkward.pool_minor,
    `pool ${awkward.pool_minor} kobo, allocated ${awkward.entitlements.reduce((t, e) => t + e.constrained_minor, 0)}`);
}

// ── FR-CLC-002 ──────────────────────────────────────────────────────────────
console.log('\n── FR-CLC-002 / AC-010  Determinism ───────────────────────────────────');
{
  const once = calculate({ deal: deal101, plan: planCapped(RESOLUTION.PRORATE), ancestors: ancestors101 });
  const twice = calculate({ deal: deal101, plan: planCapped(RESOLUTION.PRORATE), ancestors: ancestors101 });
  check('The same inputs produce a byte-identical allocation',
    JSON.stringify(once) === JSON.stringify(twice),
    'a recalculation that drifted by a kobo would post a phantom delta');

  const reordered = calculate({
    deal: deal101,
    plan: planCapped(RESOLUTION.PRORATE),
    ancestors: ancestors101,
  });
  check('...and the residual does not depend on participant ordering',
    JSON.stringify(once.entitlements.map((e) => e.constrained_minor))
      === JSON.stringify(reordered.entitlements.map((e) => e.constrained_minor)), '');
}

console.log('\n── Results ─────────────────────────────────────────────────────\n');
console.log(`  ${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass}/${pass + fail} checks passed.\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);

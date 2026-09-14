/**
 * Phases 2 and 4 of the commission engine: when money vests, what comes back,
 * what comes off, and the structures beyond a flat generational ladder.
 *
 * Pure, like verify:commission — every case is literal input and a literal
 * expected answer, because these are arithmetic rules about money and the only
 * useful test of one is whether it produces the right number.
 */
const {
  calculate, TRIGGER, vestedAmount, applyHoldback, isMatured,
  reverseLine, withinClawbackWindow, recoveryFromPayout, cascadesToUpline,
  applyDeductions, DISPOSITION, dispositionFor, redistribute, withinGraceWindow,
  BASIS, CB_MODE, POOL_MODE, RESOLUTION, VALUE_TYPE, RULE_TYPE, COMPRESSION,
} = require('../shared/src/commission');
const { applyPeriodicCaps, applyFloor } = require('../shared/src/commission/constraints');

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};
const naira = (amount) => Math.round(amount * 100);
const show = (minor) => (Number(minor) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });

// ── Vesting ─────────────────────────────────────────────────────────────────
console.log('\n── §7.9  When an entitlement becomes payable ───────────────────');
{
  const base = naira(50_000_000);
  const entitlement = naira(3_000_000);
  const at = (received, plan = {}) => vestedAmount(
    { release_trigger: plan.trigger, ...plan },
    { entitlement_minor: entitlement, commissionable_base_minor: base, received_minor: received, confirmed: true },
  ).vested_minor;

  check('ON_DEAL_CONFIRMATION vests everything before a naira arrives',
    at(0, { trigger: TRIGGER.ON_DEAL_CONFIRMATION }) === entitlement, show(at(0, { trigger: TRIGGER.ON_DEAL_CONFIRMATION })));

  check('ON_INITIAL_DEPOSIT waits for the first payment',
    at(0, { trigger: TRIGGER.ON_INITIAL_DEPOSIT }) === 0
      && at(naira(1), { trigger: TRIGGER.ON_INITIAL_DEPOSIT }) === entitlement);

  check('ON_FULL_PAYMENT vests nothing at 99%',
    at(base - 1, { trigger: TRIGGER.ON_FULL_PAYMENT }) === 0);
  check('...and everything at 100%',
    at(base, { trigger: TRIGGER.ON_FULL_PAYMENT }) === entitlement);

  const threshold = { trigger: TRIGGER.ON_THRESHOLD, threshold_percentage: 50 };
  check('ON_THRESHOLD waits for its percentage of the BASE',
    at(naira(24_999_999), threshold) === 0 && at(naira(25_000_000), threshold) === entitlement,
    'of the base, not of a plan total that may include a surcharge');

  // FR-VST-002, and the example in §10.3: 40% paid, 40% released.
  check('PRO_RATA releases in step with the buyer — 40% paid, 40% vested',
    at(naira(20_000_000), { trigger: TRIGGER.PRO_RATA }) === naira(1_200_000),
    show(at(naira(20_000_000), { trigger: TRIGGER.PRO_RATA })));
  check('...and never more than the entitlement, however much arrives',
    at(base * 2, { trigger: TRIGGER.PRO_RATA }) === entitlement,
    'an overpayment must not vest more than is owed');

  const milestones = {
    release_trigger: TRIGGER.MILESTONE,
    milestones: [{ code: 'deposit', weight: 1 }, { code: 'title', weight: 1 }, { code: 'handover', weight: 2 }],
  };
  const met = (codes) => vestedAmount(milestones, {
    entitlement_minor: entitlement, commissionable_base_minor: base, received_minor: 0, milestones_met: codes,
  }).vested_minor;
  check('MILESTONE vests only what has been reached',
    met(['deposit']) === naira(750_000), show(met(['deposit'])));
  check('...weighted, and summing to exactly the entitlement when all are met',
    met(['deposit', 'title', 'handover']) === entitlement, show(met(['deposit', 'title', 'handover'])));

  const scheduled = { release_trigger: TRIGGER.SCHEDULED, schedule_steps: 4, schedule_interval_days: 30 };
  const after = (days) => vestedAmount(scheduled, {
    entitlement_minor: entitlement, commissionable_base_minor: base, received_minor: 0, elapsed_days: days,
  }).vested_minor;
  check('SCHEDULED pays by the calendar, not by receipts',
    after(0) === 0 && after(30) === naira(750_000) && after(120) === entitlement,
    `day 30 → ${show(after(30))}, day 120 → ${show(after(120))}`);
}

console.log('\n── FR-VST-004/005  Holdback and maturity ──────────────────────');
{
  const entitlement = naira(1_000_000);
  const held = applyHoldback(entitlement, entitlement, { holdback_percentage: 10 }, {});
  check('A 10% holdback keeps 100,000 back',
    held.vested_minor === naira(900_000) && held.held_minor === naira(100_000),
    `payable ${show(held.vested_minor)}, held ${show(held.held_minor)}`);

  const releasedNow = applyHoldback(entitlement, entitlement, { holdback_percentage: 10 }, { holdback_released: true });
  check('...and releases it once its own condition is met',
    releasedNow.vested_minor === entitlement, show(releasedNow.vested_minor));

  const fortnight = { maturity_days: 14 };
  const eightDaysAgo = new Date(Date.now() - 8 * 864e5);
  const twentyDaysAgo = new Date(Date.now() - 20 * 864e5);
  check('A cooling-off period holds money on the premises',
    isMatured(fortnight, eightDaysAgo) === false && isMatured(fortnight, twentyDaysAgo) === true,
    'an early cancellation is absorbed rather than chased');
}

// ── Reversal ────────────────────────────────────────────────────────────────
console.log('\n── §7.10  Taking commission back, in the right order ───────────');
{
  // Nothing released yet: the whole reduction is absorbed by the accrual.
  const untouched = reverseLine(
    { constrained_minor: naira(1_000_000), released_minor: 0, paid_minor: 0 }, naira(200_000),
  );
  check('An unreleased accrual absorbs it, and nobody is asked for anything',
    untouched.cancel_accrual_minor === naira(800_000)
      && untouched.clawback_minor === 0,
    `cancelled ${show(untouched.cancel_accrual_minor)}`);

  // Released but not paid: the wallet absorbs it.
  const inWallet = reverseLine(
    { constrained_minor: naira(1_000_000), released_minor: naira(1_000_000), paid_minor: 0 }, naira(200_000),
  );
  check('Released-but-unpaid is offset against the wallet, not invoiced',
    inWallet.offset_wallet_minor === naira(800_000) && inWallet.clawback_minor === 0,
    `offset ${show(inWallet.offset_wallet_minor)}`);

  // Already paid: the only case that becomes a receivable.
  const gone = reverseLine(
    { constrained_minor: naira(1_000_000), released_minor: naira(1_000_000), paid_minor: naira(1_000_000) },
    naira(200_000),
  );
  check('Only money that has actually left becomes a clawback',
    gone.clawback_minor === naira(800_000)
      && gone.cancel_accrual_minor === 0 && gone.offset_wallet_minor === 0,
    show(gone.clawback_minor));

  // The mixed case, which is the realistic one.
  const mixed = reverseLine(
    { constrained_minor: naira(1_000_000), released_minor: naira(600_000), paid_minor: naira(400_000) },
    naira(300_000),
  );
  check('A mixed position is drained cheapest-first',
    mixed.cancel_accrual_minor === naira(400_000)
      && mixed.offset_wallet_minor === naira(200_000)
      && mixed.clawback_minor === naira(100_000),
    `accrual ${show(mixed.cancel_accrual_minor)} → wallet ${show(mixed.offset_wallet_minor)} → owed ${show(mixed.clawback_minor)}`);
  check('...and the three parts account for the whole reduction',
    mixed.cancel_accrual_minor + mixed.offset_wallet_minor + mixed.clawback_minor === naira(700_000));

  const up = reverseLine({ constrained_minor: naira(500_000), released_minor: 0, paid_minor: 0 }, naira(900_000));
  check('A revision UPWARDS reverses nothing', up.unchanged === true);
}

console.log('\n── FR-ADJ-003/006  Windows and recovery ───────────────────────');
{
  const march = '2026-03-01T00:00:00Z';
  const plan = { clawback_window_months: 12 };
  check('Inside the window, a clawback may be raised',
    withinClawbackWindow(plan, march, new Date('2026-09-01')) === true);
  check('Outside it, the payment is final',
    withinClawbackWindow(plan, march, new Date('2027-06-01')) === false,
    'a realtor cannot hold a reserve against a sale forever');
  check('No window configured means no expiry',
    withinClawbackWindow({}, march, new Date('2099-01-01')) === true);

  const half = recoveryFromPayout(naira(400_000), naira(1_000_000), { clawback_recovery_percentage: 50 });
  check('Recovery is capped at a share of each payout',
    half.recovered_minor === naira(200_000) && half.net_minor === naira(200_000),
    `took ${show(half.recovered_minor)}, paid ${show(half.net_minor)}, still owed ${show(half.still_owed_minor)}`);
  check('...and never more than is actually owed',
    recoveryFromPayout(naira(400_000), naira(50_000), { clawback_recovery_percentage: 100 }).recovered_minor === naira(50_000));

  check('Clawbacks cascade to uplines by default', cascadesToUpline({}) === true);
  check('...unless the plan protects them',
    cascadesToUpline({ clawback_scope: 'PROTECT_UPLINE' }) === false);
}

// ── Deductions ──────────────────────────────────────────────────────────────
console.log('\n── §7.11  What comes off before it reaches somebody ────────────');
{
  const gross = naira(1_000_000);
  const profile = [
    { code: 'wht', label: 'Withholding tax', type: 'PERCENTAGE', value: 5, basis: 'GROSS', order: 1 },
    { code: 'admin', label: 'Platform fee', type: 'PERCENTAGE', value: 2, basis: 'RUNNING', order: 2 },
  ];
  const result = applyDeductions(gross, profile);
  check('Tax on the gross, fee on what is left',
    result.lines[0].amount_minor === naira(50_000) && result.lines[1].amount_minor === naira(19_000),
    `${show(result.lines[0].amount_minor)} then ${show(result.lines[1].amount_minor)}`);
  check('...and the net is the gross less both',
    result.net_minor === naira(931_000), show(result.net_minor));
  check('FR-PAY-003  the advice shows every line, so a short payment explains itself',
    result.lines.length === 2 && result.lines.every((line) => line.label && line.amount_minor >= 0));

  /**
   * Percentages commute whatever their bases — 0.95 x 0.98 is 0.98 x 0.95 — so
   * two of them in either order give the same net. What genuinely depends on
   * order is a FLAT charge against a RUNNING percentage, which is the common
   * arrangement: whether the platform fee is taken before or after withholding
   * decides who absorbs the tax on it.
   */
  const feeFirst = applyDeductions(gross, [
    { code: 'admin', type: 'FLAT', value_minor: naira(100_000), order: 1 },
    { code: 'wht', type: 'PERCENTAGE', value: 5, basis: 'RUNNING', order: 2 },
  ]);
  const taxFirst = applyDeductions(gross, [
    { code: 'wht', type: 'PERCENTAGE', value: 5, basis: 'RUNNING', order: 1 },
    { code: 'admin', type: 'FLAT', value_minor: naira(100_000), order: 2 },
  ]);
  check('A flat charge against a percentage gives a different net by order',
    feeFirst.net_minor === naira(855_000) && taxFirst.net_minor === naira(850_000),
    `fee first ${show(feeFirst.net_minor)} vs tax first ${show(taxFirst.net_minor)}`);

  const greedy = applyDeductions(naira(1_000), [
    { code: 'fee', type: 'FLAT', value_minor: naira(5_000), order: 1 },
  ]);
  check('A deduction can never exceed the commission',
    greedy.net_minor === 0 && greedy.lines[0].capped === true,
    'a negative payout would be a bill, not a payment');
}

// ── Forfeiture dispositions ─────────────────────────────────────────────────
console.log('\n── FR-ELG-007/008/009  Where forfeited value goes ──────────────');
{
  const plan = {
    forfeiture_disposition: DISPOSITION.BREAKAGE,
    forfeiture_by_reason: {
      compliance_lapse: DISPOSITION.HOLD_PENDING_REINSTATEMENT,
      termination_for_cause: DISPOSITION.BREAKAGE,
    },
    reinstatement_grace_days: 30,
  };
  check('A compliance suspension holds rather than forfeits',
    dispositionFor(plan, 'compliance_lapse') === DISPOSITION.HOLD_PENDING_REINSTATEMENT);
  check('...while a termination for cause does not',
    dispositionFor(plan, 'termination_for_cause') === DISPOSITION.BREAKAGE,
    'the same event costing the same money regardless of cause would be the wrong design');
  check('An unlisted reason falls back to the plan default',
    dispositionFor(plan, 'resignation') === DISPOSITION.BREAKAGE);

  const shared = redistribute(naira(300_000), [
    { id: 1, realtor_id: 10, constrained_minor: naira(600_000) },
    { id: 2, realtor_id: 11, constrained_minor: naira(400_000) },
  ]);
  check('REDISTRIBUTE shares it in the proportions the plan already set',
    shared.allocations[0].amount_minor === naira(180_000)
      && shared.allocations[1].amount_minor === naira(120_000),
    shared.allocations.map((a) => show(a.amount_minor)).join(' / '));
  check('...and the parts sum to exactly what was forfeited',
    shared.allocations.reduce((t, a) => t + a.amount_minor, 0) === naira(300_000));
  check('With nobody left to share it, it is retained rather than lost',
    redistribute(naira(300_000), []).breakage_minor === naira(300_000));

  const heldToday = new Date();
  const heldLongAgo = new Date(Date.now() - 60 * 864e5);
  check('AC-012  reinstatement inside the grace window resumes the schedule',
    withinGraceWindow(plan, heldToday) === true);
  check('...and outside it, the hold converts to forfeiture',
    withinGraceWindow(plan, heldLongAgo) === false);
}

// ── Periodic caps and floors ────────────────────────────────────────────────
console.log('\n── FR-CAP-006/007  Caps on the person, not the deal ────────────');
{
  const lines = [
    { realtor_id: 10, constrained_minor: naira(500_000), trace: {} },
    { realtor_id: 11, constrained_minor: naira(200_000), trace: {} },
  ];
  const earned = new Map([[10, naira(800_000)]]);

  const forfeit = applyPeriodicCaps(lines, { periodic_cap_minor: naira(1_000_000), periodic_overflow: 'FORFEIT' }, earned);
  check('Somebody near their annual cap is paid only the headroom',
    forfeit.entitlements[0].constrained_minor === naira(200_000), show(forfeit.entitlements[0].constrained_minor));
  check('...the excess is forfeited, and counted',
    forfeit.forfeited_minor === naira(300_000), show(forfeit.forfeited_minor));
  check('...and somebody nowhere near theirs is untouched',
    forfeit.entitlements[1].constrained_minor === naira(200_000));

  const carry = applyPeriodicCaps(lines, { periodic_cap_minor: naira(1_000_000), periodic_overflow: 'CARRY_FORWARD' }, earned);
  check('CARRY_FORWARD keeps the excess for next period instead of losing it',
    carry.carried_forward[0]?.amount_minor === naira(300_000) && carry.forfeited_minor === 0,
    show(carry.carried_forward[0]?.amount_minor));

  const flagged = applyPeriodicCaps(lines, { periodic_cap_minor: naira(1_000_000), periodic_overflow: 'PAY_ANYWAY_FLAGGED' }, earned);
  check('PAY_ANYWAY_FLAGGED pays in full and raises it for review',
    flagged.entitlements[0].constrained_minor === naira(500_000) && flagged.flagged.length === 1,
    'a cap is often a review threshold rather than a refusal');

  const tiny = [
    { realtor_id: 10, constrained_minor: naira(500_000), trace: {} },
    { realtor_id: 13, constrained_minor: naira(50), trace: {} },
  ];
  const floored = applyFloor(tiny, { participant_floor_minor: naira(1_000) });
  check('A share too small to be worth transferring is dropped',
    floored.entitlements[1].constrained_minor === 0 && floored.dropped.length === 1,
    `dropped ${show(floored.dropped[0].amount_minor)}`);
  check('...and IGNORE keeps it, for a company that would rather pay it',
    applyFloor(tiny, { participant_floor_minor: naira(1_000), floor_policy: 'IGNORE' })
      .entitlements[1].constrained_minor === naira(50));
}

// ── Rank differential ───────────────────────────────────────────────────────
console.log('\n── FR-LVL-009  Rank differential pays only the spread ──────────');
{
  const realtor = (id, rate) => ({
    id,
    level: { id: rate, code: `L${rate}`, position: rate, direct_rate: rate },
    status_history: [{ status: 'active', effective_from: '2020-01-01T00:00:00Z' }],
  });

  const plan = {
    commissionable_base: { mode: CB_MODE.GROSS_PRICE },
    pool: { mode: POOL_MODE.UNCAPPED },
    resolution: RESOLUTION.PRORATE,
    rules: [
      { id: 'direct', type: RULE_TYPE.DIRECT_SALE, value_type: VALUE_TYPE.PERCENTAGE, basis: BASIS.COMMISSIONABLE_BASE },
      { id: 'rank', type: RULE_TYPE.RANK_DIFFERENTIAL },
    ],
  };

  // Seller on 4%, then uplines on 6%, 6% and 8%.
  const result = calculate({
    deal: {
      id: 'RANK', gross_price_minor: naira(10_000_000), discount_minor: 0, unit_count: 1,
      attribution_date: '2026-01-01T00:00:00Z', selling_realtor: realtor(1, 4),
    },
    plan,
    ancestors: [realtor(2, 6), realtor(3, 6), realtor(4, 8)],
  });

  const paid = (id) => result.entitlements
    .filter((e) => e.realtor_id === id)
    .reduce((total, e) => total + e.constrained_minor, 0);

  check('The seller earns their own rate', paid(1) === naira(400_000), show(paid(1)));
  check('Gen 1 on 6% earns the 2% spread over the seller',
    paid(2) === naira(200_000), show(paid(2)));
  check('Gen 2 also on 6% earns NOTHING — the spread is already paid',
    paid(3) === 0, 'this is the point of a differential, not a gap in it');
  check('Gen 3 on 8% earns the 2% spread over the highest paid below',
    paid(4) === naira(200_000), show(paid(4)));
  check('The whole leg costs the most senior rate and no more',
    result.allocated_minor === naira(800_000),
    `${show(result.allocated_minor)} = 8% of the sale, which is what a fixed ladder cannot promise`);
}

// ── Matching bonus ──────────────────────────────────────────────────────────
console.log('\n── FR-GNC-009  A matching bonus pays on EARNINGS ───────────────');
{
  const realtor = (id) => ({
    id,
    level: { id: 1, code: 'L', position: 1, direct_rate: 6 },
    status_history: [{ status: 'active', effective_from: '2020-01-01T00:00:00Z' }],
  });

  const result = calculate({
    deal: {
      id: 'MATCH', gross_price_minor: naira(10_000_000), discount_minor: 0, unit_count: 1,
      attribution_date: '2026-01-01T00:00:00Z', selling_realtor: realtor(1),
    },
    plan: {
      commissionable_base: { mode: CB_MODE.GROSS_PRICE },
      pool: { mode: POOL_MODE.UNCAPPED },
      resolution: RESOLUTION.PRORATE,
      rules: [
        { id: 'direct', type: RULE_TYPE.DIRECT_SALE, value_type: VALUE_TYPE.PERCENTAGE, basis: BASIS.COMMISSIONABLE_BASE },
        { id: 'match', type: RULE_TYPE.MATCHING_BONUS, depth: 1, value_type: VALUE_TYPE.PERCENTAGE, value: 10 },
      ],
    },
    ancestors: [realtor(2), realtor(3)],
  });

  const paid = (id) => result.entitlements
    .filter((e) => e.realtor_id === id).reduce((t, e) => t + e.constrained_minor, 0);

  check('The seller earns 6% of the sale', paid(1) === naira(600_000), show(paid(1)));
  check('Their sponsor earns 10% of what the SELLER earned, not of the sale',
    paid(2) === naira(60_000), `${show(paid(2))} — 10% of ${show(paid(1))}, not of the price`);
  check('...and depth 1 means it stops there',
    paid(3) === 0, 'it rewards developing somebody, not being above them');
}

console.log('\n── Results ─────────────────────────────────────────────────────\n');
console.log(`  ${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass}/${pass + fail} checks passed.\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);

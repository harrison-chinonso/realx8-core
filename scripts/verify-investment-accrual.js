/**
 * The investment accrual engine, checked against arithmetic done by hand.
 *
 * ── Why hand-computed figures ───────────────────────────────────────────────
 *
 * An engine tested against its own output tests nothing: whatever it does
 * becomes the expected answer. Every figure below was worked out independently
 * — ₦1,000,000 at 12% for a year is ₦120,000, and a test that agrees is
 * checking the engine rather than echoing it.
 *
 * ── What actually goes wrong here ───────────────────────────────────────────
 *
 * Not the happy path. The failures that cost money are: a scheduler running
 * twice and paying twice; accrual continuing past maturity; a compounding
 * function that credits a period which has not finished; an early-exit penalty
 * that eats into capital; and float drift, which is silent, one-directional and
 * only visible when an investor checks with a calculator.
 *
 * No database. The engine is pure, so this runs in milliseconds and can be
 * exhaustive where a database-backed test would be slow and shallow.
 */
const {
  termsFrom, describeTerms, FREQUENCY, BASIS, PENALTY,
} = require('../shared/src/investments/terms');
const {
  accruedAt, duePayoutMinor, nextPayoutDate, maturityDate, hasMatured,
} = require('../shared/src/investments/accrual');
const { quoteExit } = require('../shared/src/investments/exit');

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

const naira = (minor) => `₦${(minor / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
const DAY = 24 * 60 * 60 * 1000;
const FUNDED = new Date('2026-01-01T00:00:00Z');
const after = (days) => new Date(FUNDED.getTime() + days * DAY);

const MILLION = 1_000_000_00; // ₦1,000,000 in kobo

console.log('\n── Simple interest, against figures worked out by hand ──────────');
{
  const terms = termsFrom({ return_rate: 12, tenor_days: 365, payout_frequency: FREQUENCY.AT_MATURITY });

  const year = accruedAt(terms, { principalMinor: MILLION, fundedAt: FUNDED, asAt: after(365) });
  check('₦1,000,000 at 12% for a year earns ₦120,000',
    year.earned_minor === 120_000_00, `${naira(year.earned_minor)} over ${year.days} days`);

  const half = accruedAt(terms, { principalMinor: MILLION, fundedAt: FUNDED, asAt: after(182) });
  // 1,000,000 × 12 × 182 / (100 × 365) = 59,835.61…, floored to the kobo
  check('...and ₦59,835.61 after 182 days',
    half.earned_minor === 5_983_561, naira(half.earned_minor));

  const day = accruedAt(terms, { principalMinor: MILLION, fundedAt: FUNDED, asAt: after(1) });
  check('...and one day earns ₦328.76, not nothing',
    day.earned_minor === 32_876, naira(day.earned_minor));
}

console.log('\n── Accrual stops at maturity ────────────────────────────────────');
{
  const terms = termsFrom({ return_rate: 12, tenor_days: 365 });
  const atMaturity = accruedAt(terms, { principalMinor: MILLION, fundedAt: FUNDED, asAt: after(365) });
  const wayPast = accruedAt(terms, { principalMinor: MILLION, fundedAt: FUNDED, asAt: after(900) });

  check('Money left in past its term does not keep earning',
    atMaturity.earned_minor === wayPast.earned_minor,
    `${naira(atMaturity.earned_minor)} at maturity vs ${naira(wayPast.earned_minor)} at 900 days`);
  check('...and the engine says it has matured', hasMatured(terms, FUNDED, after(366)));
  check('...but not a day early', hasMatured(terms, FUNDED, after(364)) === false);
}

console.log('\n── Compounding credits completed periods only ───────────────────');
{
  const terms = termsFrom({
    return_rate: 12, tenor_days: 365, payout_frequency: FREQUENCY.MONTHLY, return_basis: BASIS.COMPOUND,
  });

  const year = accruedAt(terms, { principalMinor: MILLION, fundedAt: FUNDED, asAt: after(365) });
  // (1 + 0.01)^12 = 1.12682…, so ₦126,825 rather than the simple ₦120,000
  check('Monthly compounding beats simple over a year',
    year.earned_minor > 120_000_00 && year.earned_minor < 127_000_00,
    `${naira(year.earned_minor)} compounded vs ₦120,000.00 simple`);
  check('...having completed 12 periods', year.periods === 12, `${year.periods} periods`);

  /*
   * The one that matters. Half way through the first month nothing has
   * compounded, so the figure must be the simple accrual on the principal — not
   * a twelfth of a year's compounding credited early.
   */
  const partial = accruedAt(terms, { principalMinor: MILLION, fundedAt: FUNDED, asAt: after(15) });
  const simpleFifteen = Math.floor((MILLION * 12 * 15) / (100 * 365));
  check('A period that has not finished is not credited as though it had',
    partial.periods === 0 && partial.earned_minor === simpleFifteen,
    `${naira(partial.earned_minor)} after 15 days, ${partial.periods} periods complete`);

  check('...and compounding never pays less than simple over the same span',
    year.earned_minor >= accruedAt(
      termsFrom({ return_rate: 12, tenor_days: 365 }),
      { principalMinor: MILLION, fundedAt: FUNDED, asAt: after(365) },
    ).earned_minor);
}

console.log('\n── The scheduler can run twice without paying twice ─────────────');
{
  const terms = termsFrom({ return_rate: 12, tenor_days: 365 });
  const context = { principalMinor: MILLION, fundedAt: FUNDED, asAt: after(90) };

  const first = duePayoutMinor(terms, context, 0);
  const afterPaying = duePayoutMinor(terms, context, first);
  check('A second run on the same day owes nothing',
    first > 0 && afterPaying === 0, `${naira(first)} then ${naira(afterPaying)}`);

  const laterSameDay = duePayoutMinor(terms, context, first);
  check('...however many times it runs', laterSameDay === 0);

  const nextMonth = duePayoutMinor(terms, { ...context, asAt: after(120) }, first);
  check('...but the next month is owed normally',
    nextMonth > 0, naira(nextMonth));

  /*
   * A correction that reduces the funded amount can leave cumulative earnings
   * below what has been paid. The answer is "nothing further", never a
   * negative payout that would read as money owed BY the investor.
   */
  const overpaid = duePayoutMinor(terms, context, first + 50_000_00);
  check('An overpayment never produces a negative next payout', overpaid === 0, naira(overpaid));
}

console.log('\n── Nothing earns before it is funded ────────────────────────────');
{
  const terms = termsFrom({ return_rate: 12, tenor_days: 365 });
  const unfunded = accruedAt(terms, { principalMinor: 0, fundedAt: FUNDED, asAt: after(100) });
  check('An unfunded subscription earns nothing',
    unfunded.earned_minor === 0 && unfunded.reason === 'not_funded');

  const noDate = accruedAt(terms, { principalMinor: MILLION, fundedAt: null, asAt: after(100) });
  check('...and neither does one with money but no funding date',
    noDate.earned_minor === 0 && noDate.reason === 'not_funded');

  const partFunded = accruedAt(terms, { principalMinor: MILLION / 2, fundedAt: FUNDED, asAt: after(365) });
  check('A part-funded subscription earns on what actually landed',
    partFunded.earned_minor === 60_000_00, naira(partFunded.earned_minor));
}

console.log('\n── Early exit ───────────────────────────────────────────────────');
{
  const locked = termsFrom({ return_rate: 12, tenor_days: 365 });
  const refused = quoteExit(locked, { principalMinor: MILLION, fundedAt: FUNDED, asAt: after(30) });
  check('Exit is refused by default — silence does not grant the right',
    refused.allowed === false && refused.reason === 'not_allowed', refused.message);

  const open = termsFrom({
    return_rate: 12, tenor_days: 365, early_exit_allowed: true,
    lock_in_days: 90, penalty_type: PENALTY.PERCENTAGE_OF_RETURN, penalty_value: 50,
  });

  const tooSoon = quoteExit(open, { principalMinor: MILLION, fundedAt: FUNDED, asAt: after(30) });
  check('...and refused inside the lock-in, saying when it opens',
    tooSoon.allowed === false && /first 90 days/.test(tooSoon.message), tooSoon.message);

  const quote = quoteExit(open, { principalMinor: MILLION, fundedAt: FUNDED, asAt: after(182) });
  // Earned ₦59,835.61; half of it forfeited = ₦29,917.81 (rounded up)
  check('A quote shows capital, return, penalty and net',
    quote.allowed && quote.capital_minor === MILLION
      && quote.earned_minor === 5_983_561 && quote.penalty_minor === 2_991_781,
    `capital ${naira(quote.capital_minor)}, earned ${naira(quote.earned_minor)}, penalty ${naira(quote.penalty_minor)}, net ${naira(quote.net_minor)}`);

  check('...and the net is exactly capital plus return less penalty',
    quote.net_minor === quote.capital_minor + quote.earned_minor - quote.penalty_minor);

  /*
   * The penalty must never reach the capital. A company could otherwise
   * configure a flat fee larger than the return and hand back less than was
   * put in, turning a withdrawal into a loss nobody agreed to.
   */
  const brutal = termsFrom({
    return_rate: 1, tenor_days: 365, early_exit_allowed: true,
    penalty_type: PENALTY.FLAT_FEE, penalty_value: 500_000,
  });
  const capped = quoteExit(brutal, { principalMinor: MILLION, fundedAt: FUNDED, asAt: after(10) });
  check('A penalty larger than the return never eats the capital',
    capped.net_minor >= MILLION && capped.penalty_minor === capped.earned_minor,
    `net ${naira(capped.net_minor)} on capital ${naira(MILLION)}`);

  const forfeit = termsFrom({
    return_rate: 12, tenor_days: 365, early_exit_allowed: true, penalty_type: PENALTY.FORFEIT_ALL_RETURN,
  });
  const all = quoteExit(forfeit, { principalMinor: MILLION, fundedAt: FUNDED, asAt: after(182) });
  check('Forfeiting all return still returns the capital',
    all.net_minor === MILLION, naira(all.net_minor));

  /*
   * At maturity this is not an early exit and no penalty applies, however the
   * plan is configured — charging somebody for waiting the full term would be
   * the cruellest bug available here.
   */
  const matured = quoteExit(open, { principalMinor: MILLION, fundedAt: FUNDED, asAt: after(400) });
  check('At maturity no penalty applies, whatever the plan says',
    matured.allowed && matured.matured && matured.penalty_minor === 0,
    `net ${naira(matured.net_minor)}`);
}

console.log('\n── Dates an investor can predict ────────────────────────────────');
{
  const monthly = termsFrom({ return_rate: 12, tenor_days: 365, payout_frequency: FREQUENCY.MONTHLY });
  const next = nextPayoutDate(monthly, { fundedAt: FUNDED, asAt: after(5) });
  check('The first monthly payout is about a month after funding',
    next > after(29) && next <= after(32), next.toISOString().slice(0, 10));

  const nearEnd = nextPayoutDate(monthly, { fundedAt: FUNDED, asAt: after(360) });
  check('...and the last one never falls past maturity',
    nearEnd.getTime() === maturityDate(monthly, FUNDED).getTime(),
    nearEnd.toISOString().slice(0, 10));

  const atMaturity = termsFrom({ return_rate: 12, tenor_days: 90 });
  check('An at-maturity plan has exactly one payout date, at maturity',
    nextPayoutDate(atMaturity, { fundedAt: FUNDED, asAt: after(10) }).getTime()
      === maturityDate(atMaturity, FUNDED).getTime());
}

console.log('\n── What the investor is told matches what they are paid ─────────');
{
  const terms = termsFrom({
    return_rate: 15, tenor_days: 180, payout_frequency: FREQUENCY.QUARTERLY,
    return_basis: BASIS.COMPOUND, early_exit_allowed: true, lock_in_days: 30,
    penalty_type: PENALTY.PERCENTAGE_OF_RETURN, penalty_value: 25,
  });
  const lines = describeTerms(terms);
  check('The disclosure states rate, basis and frequency',
    /15% a year/.test(lines[0]) && /compounding/.test(lines[0]) && /quarterly/.test(lines[0]), lines[0]);
  check('...the commitment', /180 days/.test(lines[1]), lines[1]);
  check('...and what leaving early costs', lines.some((l) => /25% of the return/.test(l)),
    lines.filter((l) => /25%/.test(l))[0]);

  const silent = describeTerms(termsFrom({ return_rate: 10, tenor_days: 90 }));
  check('A plan with no early exit says so plainly',
    silent.some((l) => /cannot be withdrawn early/.test(l)), silent[2]);
}

console.log('\n── Money stays in integers ──────────────────────────────────────');
{
  /*
   * Sixty months of compounding is where a float would have drifted. Every
   * intermediate value must be a whole number of kobo, not a number that merely
   * prints like one.
   */
  const terms = termsFrom({
    return_rate: 18, tenor_days: 1825, payout_frequency: FREQUENCY.MONTHLY, return_basis: BASIS.COMPOUND,
  });
  let everyStepInteger = true;
  for (let day = 1; day <= 1825; day += 7) {
    const { earned_minor: earned } = accruedAt(terms, {
      principalMinor: 333_333_33, fundedAt: FUNDED, asAt: after(day),
    });
    if (!Number.isInteger(earned)) { everyStepInteger = false; break; }
  }
  check('Five years of weekly readings are all whole kobo', everyStepInteger);

  const odd = accruedAt(termsFrom({ return_rate: 7.35, tenor_days: 100 }), {
    principalMinor: 777_77, fundedAt: FUNDED, asAt: after(37),
  });
  check('...and so is an awkward rate on an awkward principal',
    Number.isInteger(odd.earned_minor), `${odd.earned_minor} kobo`);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

/**
 * Spreading a discount across installments.
 *
 * Pure arithmetic about money, so every case is a literal input and a literal
 * expected answer. The rules being checked:
 *
 *   - the invoice total and every principal are left alone
 *   - only unpaid installments absorb it
 *   - the parts sum to exactly the discount
 *   - more discount than the plan can absorb is reported, not swallowed
 */
const {
  spreadDiscount, discountAlreadyApplied, payableFor,
} = require('../shared/src/invoiceDiscount');

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};
const naira = (amount) => Math.round(amount * 100);
const show = (minor) => (Number(minor) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });

/** Six monthly installments of 1,000,000, the first three already paid. */
const plan = (outstandingEach = 1_000_000, paidCount = 3, count = 6) => Array.from(
  { length: count },
  (unused, index) => ({
    id: index + 1,
    principal_minor: naira(1_000_000),
    principal_outstanding_minor: index < paidCount ? 0 : naira(outstandingEach),
    fee_outstanding_minor: 0,
    discount_minor: 0,
  }),
);

console.log('\n── A discount lands only on what is still owed ─────────────────');
{
  const result = spreadDiscount(naira(300_000), plan());
  check('Only the unpaid installments are touched',
    result.allocations.length === 3
      && result.allocations.every((a) => a.schedule_id >= 4),
    result.allocations.map((a) => `#${a.schedule_id}`).join(', '));

  check('Each drops by an equal share',
    result.allocations.every((a) => a.payable_minor === naira(900_000)),
    result.allocations.map((a) => show(a.payable_minor)).join(' / '));

  check('...and the parts sum to exactly the discount',
    result.allocations.reduce((total, a) => total + a.discount_minor, 0) === naira(300_000));

  /**
   * The principal is what the thing was sold for. A discount changes what is
   * payable; erasing the price would leave nothing to reconcile the sale
   * against, and no way to reverse a discount granted in error.
   */
  const untouched = plan();
  spreadDiscount(naira(300_000), untouched);
  check('The agreed principal is never rewritten',
    untouched.every((s) => s.principal_minor === naira(1_000_000)),
    'the discount sits beside the price, not over it');
}

console.log('\n── Installments that are not all the same size ─────────────────');
{
  const uneven = [
    { id: 1, principal_outstanding_minor: naira(500_000), discount_minor: 0 },
    { id: 2, principal_outstanding_minor: naira(300_000), discount_minor: 0 },
    { id: 3, principal_outstanding_minor: naira(200_000), discount_minor: 0 },
  ];
  const result = spreadDiscount(naira(100_000), uneven);

  /**
   * Proportional, not strictly equal. An equal split would take 33,333 from an
   * installment of 200,000 and from one of 500,000 alike — fine here, but on a
   * final installment smaller than the equal share it would take more than the
   * installment contains, and the excess would have to go somewhere anyway.
   */
  check('Bigger installments absorb proportionally more',
    result.allocations[0].discount_minor === naira(50_000)
      && result.allocations[1].discount_minor === naira(30_000)
      && result.allocations[2].discount_minor === naira(20_000),
    result.allocations.map((a) => show(a.discount_minor)).join(' / '));
  check('...and still sums exactly',
    result.allocations.reduce((t, a) => t + a.discount_minor, 0) === naira(100_000));

  const indivisible = spreadDiscount(100001, [
    { id: 1, principal_outstanding_minor: 33333300, discount_minor: 0 },
    { id: 2, principal_outstanding_minor: 33333300, discount_minor: 0 },
    { id: 3, principal_outstanding_minor: 33333400, discount_minor: 0 },
  ]);
  check('A discount that does not divide still reconciles to the kobo',
    indivisible.allocations.reduce((t, a) => t + a.discount_minor, 0) === 100001,
    'a discount that does not add up is one somebody has to explain');
}

console.log('\n── More discount than the plan can absorb ──────────────────────');
{
  const result = spreadDiscount(naira(5_000_000), plan());
  check('It is applied only up to the outstanding balance',
    result.applied_minor === naira(3_000_000), show(result.applied_minor));
  check('...and the excess is reported rather than swallowed',
    result.unapplied_minor === naira(2_000_000),
    `${show(result.unapplied_minor)} — somebody granted more than the invoice can take`);
  check('No installment is driven below zero',
    result.allocations.every((a) => a.payable_minor === 0));
}

console.log('\n── A plan with nothing left to pay ─────────────────────────────');
{
  const settled = spreadDiscount(naira(100_000), plan(1_000_000, 6));
  check('A fully paid plan absorbs none of it',
    settled.applied_minor === 0 && settled.unapplied_minor === naira(100_000),
    'money already paid is refunded, not discounted — a different decision');
  check('A discount of nothing changes nothing',
    spreadDiscount(0, plan()).allocations.length === 0);
}

console.log('\n── Re-granting, and what a schedule is worth ───────────────────');
{
  const applied = [
    { id: 1, principal_outstanding_minor: naira(900_000), discount_minor: naira(100_000) },
    { id: 2, principal_outstanding_minor: naira(900_000), discount_minor: naira(100_000) },
  ];
  check('What has already been discounted can be read back',
    discountAlreadyApplied(applied) === naira(200_000),
    'so a revised discount applies the difference rather than stacking');

  check('A schedule is worth its balance less its discount, plus fees',
    payableFor({
      principal_outstanding_minor: naira(900_000),
      discount_minor: naira(100_000),
      fee_outstanding_minor: naira(5_000),
    }) === naira(805_000),
    show(payableFor({
      principal_outstanding_minor: naira(900_000),
      discount_minor: naira(100_000),
      fee_outstanding_minor: naira(5_000),
    })));

  check('...and never below zero, whatever the discount says',
    payableFor({ principal_outstanding_minor: naira(100), discount_minor: naira(999), fee_outstanding_minor: 0 }) === 0);
}

console.log('\n── Results ─────────────────────────────────────────────────────\n');
console.log(`  ${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass}/${pass + fail} checks passed.\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BASIS, allocate, weightOf, outstandingRelease,
} = require('../../shared/src/accounting/costAllocation');

/**
 * Turning a project's cost into a cost per unit (ACC-10.3).
 *
 * This is the figure that releases to cost of sales at handover, so it sets
 * the gross margin on every sale a developer makes. It is worth checking at
 * this level — no database, no fixtures, one function — because that is the
 * only form in which an accountant can read the arithmetic rather than read
 * SQL about it.
 */

test('the pool lands entirely on the units, however awkwardly it divides', () => {
  /*
   * 1,000,000,001 kobo across 333/333/334 square metres. Every naive
   * implementation loses money here, and a control account out by a few kobo
   * per project is one nobody can sign.
   */
  const result = allocate(100000000001, [
    { id: 1, size: 333 }, { id: 2, size: 333 }, { id: 3, size: 334 },
  ], BASIS.SALEABLE_AREA);

  const total = result.allocations.reduce((sum, row) => sum + row.allocated_minor, 0);
  assert.equal(total, 100000000001);
  assert.equal(result.unallocated_minor, 0);
});

test('the same pool allocated twice gives the same answer', () => {
  const units = [{ id: 3, size: 334 }, { id: 1, size: 333 }, { id: 2, size: 333 }];
  const byId = (result) => [...result.allocations]
    .sort((a, b) => a.unit_id - b.unit_id)
    .map((row) => row.allocated_minor);

  assert.deepEqual(
    byId(allocate(100000000001, units, BASIS.SALEABLE_AREA)),
    byId(allocate(100000000001, [...units].reverse(), BASIS.SALEABLE_AREA)),
  );
});

test('an even split is 40/40/20 when the areas are', () => {
  const result = allocate(12000000000, [
    { id: 1, size: 400 }, { id: 2, size: 400 }, { id: 3, size: 200 },
  ], BASIS.SALEABLE_AREA);

  assert.deepEqual(
    result.allocations.map((row) => row.allocated_minor),
    [4800000000, 4800000000, 2400000000],
  );
});

test('sales value splits by price where area cannot tell units apart', () => {
  const result = allocate(100000000, [
    { id: 1, size: 100, price_minor: 90000000 },
    { id: 2, size: 100, price_minor: 10000000 },
  ], BASIS.SALES_VALUE);

  assert.deepEqual(result.allocations.map((row) => row.allocated_minor), [90000000, 10000000]);
});

test('quantity multiplies a unit\'s share', () => {
  // Four identical plots sold as one line weigh four times one plot.
  assert.equal(weightOf({ size: 100, quantity: 4 }, BASIS.SALEABLE_AREA), 400);
  assert.equal(weightOf({ price_minor: 500, quantity: 2 }, BASIS.SALES_VALUE), 1000);
});

test('a project with no areas recorded allocates nothing rather than guessing', () => {
  const result = allocate(50000000, [{ id: 1, size: 0 }, { id: 2, size: 0 }], BASIS.SALEABLE_AREA);

  assert.equal(result.allocated_minor, 0);
  assert.equal(result.unallocated_minor, 50000000);
  // An even split would be an invented answer wearing the shape of a real one.
  assert.deepEqual(result.allocations.map((row) => row.allocated_minor), [0, 0]);
});

test('a project with no pool allocates nothing', () => {
  const result = allocate(0, [{ id: 1, size: 100 }], BASIS.SALEABLE_AREA);
  assert.equal(result.allocated_minor, 0);
  assert.equal(result.unallocated_minor, 0);
});

test('a negative area cannot claim a share', () => {
  const result = allocate(1000, [{ id: 1, size: -500 }, { id: 2, size: 100 }], BASIS.SALEABLE_AREA);
  assert.deepEqual(result.allocations.map((row) => row.allocated_minor), [0, 1000]);
});

test('what is left to release is the allocation less what already went', () => {
  assert.equal(outstandingRelease({ allocatedMinor: 6000000000, releasedMinor: 4800000000 }), 1200000000);
});

test('a project whose pool SHRANK gives a negative release, not zero', () => {
  /*
   * A supplier credit note reduces the pool, so a unit already handed over was
   * charged too much. Clamping that to zero would make cost of sales a figure
   * that can only ever go up.
   */
  assert.equal(outstandingRelease({ allocatedMinor: 4000000000, releasedMinor: 4800000000 }), -800000000);
});

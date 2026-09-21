const { asMinor } = require('../money');

/**
 * Turning a project's accumulated cost into a cost per unit (ACC-10.3).
 *
 * ── Why this is arithmetic and not a query ──────────────────────────────────
 *
 * A development's costs arrive as bills against the estate, not against the
 * unit somebody eventually buys: a contractor pours foundations for a block,
 * not for plot 14. So the cost of plot 14 is never observed — it is always
 * apportioned, and the apportionment is a judgement the company makes once
 * and must then apply consistently.
 *
 * Keeping that judgement here, as a pure function, is what lets an accountant
 * check it. The figure it produces is the one that releases to cost of sales
 * at handover and therefore sets the gross margin on every sale, so it is the
 * single number in this module most worth being able to read line by line.
 *
 * ── The two bases, and why not more ─────────────────────────────────────────
 *
 * By saleable area, which is what a developer's own cost plan is built on and
 * is the default; or by sales value, which is right where units differ in
 * finish rather than in size — a penthouse and a ground-floor flat of equal
 * area did not cost the same to build. Both are accepted under IAS 2 as a
 * rational and consistent basis. A third option would mostly be a way of
 * choosing the answer.
 *
 * ── Every naira lands somewhere ─────────────────────────────────────────────
 *
 * Shares do not divide evenly, and a project's pool is in kobo. Rounding each
 * unit independently leaves a remainder that belongs to nobody, and a control
 * account that is out by a few kobo per project is one an accountant cannot
 * sign. Largest remainder distributes the shortfall to the units with the
 * largest fractional claim, so the allocations sum to the pool EXACTLY. That
 * is asserted, not assumed.
 */

/** How a project's pool is split. */
const BASIS = {
  SALEABLE_AREA: 'saleable_area',
  SALES_VALUE: 'sales_value',
};

const DEFAULT_BASIS = BASIS.SALEABLE_AREA;

/** The measure a unit contributes to the split, under a given basis. */
const weightOf = (unit, basis) => {
  const quantity = Math.max(Number(unit.quantity) || 1, 1);
  if (basis === BASIS.SALES_VALUE) {
    return Math.max(Number(unit.price_minor ?? unit.price ?? 0), 0) * quantity;
  }
  return Math.max(Number(unit.area ?? unit.size ?? 0), 0) * quantity;
};

/**
 * Split `poolMinor` across `units` by `basis`.
 *
 * @param   {number} poolMinor  everything capitalised to the project, in kobo
 * @param   {Array}  units      { id, size|area, price_minor, quantity }
 * @param   {string} basis      BASIS.*
 * @returns {{ allocations: Array<{unit_id, weight, allocated_minor}>,
 *            total_weight: number, allocated_minor: number, basis: string,
 *            unallocated_minor: number }}
 *
 * Where every unit weighs nothing — a project whose units have no area
 * recorded, which is common enough early on — nothing is allocated and the
 * whole pool is returned as unallocated rather than being spread evenly. An
 * even split would be an invented answer wearing the same shape as a real
 * one; an unallocated pool is a visible question.
 */
const allocate = (poolMinor, units = [], basis = DEFAULT_BASIS) => {
  const pool = asMinor(poolMinor);
  const weights = units.map((unit) => ({ unit, weight: weightOf(unit, basis) }));
  const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);

  if (!(pool > 0) || !(totalWeight > 0)) {
    return {
      basis,
      total_weight: totalWeight,
      allocated_minor: 0,
      unallocated_minor: pool,
      allocations: weights.map(({ unit, weight }) => ({
        unit_id: unit.id, weight, allocated_minor: 0,
      })),
    };
  }

  /*
   * Floor first, then hand the remainder out by size of fractional claim.
   *
   * Ties break on the larger weight and then on the lower id, so the same
   * project allocated twice gives the same answer — an allocation that moved
   * between two runs with no new cost would make every margin unexplainable.
   */
  const draft = weights.map(({ unit, weight }) => {
    const exact = (pool * weight) / totalWeight;
    const floor = Math.floor(exact);
    return {
      unit_id: unit.id, weight, allocated_minor: floor, remainder: exact - floor,
    };
  });

  let short = pool - draft.reduce((sum, row) => sum + row.allocated_minor, 0);
  const order = [...draft].sort((a, b) => (
    b.remainder - a.remainder
    || b.weight - a.weight
    || Number(a.unit_id) - Number(b.unit_id)
  ));
  for (let i = 0; short > 0 && i < order.length; i += 1, short -= 1) {
    order[i].allocated_minor += 1;
  }

  // The fractional part was only ever scaffolding for the distribution above.
  const allocations = draft.map(({ remainder: _remainder, ...row }) => row);
  const allocated = allocations.reduce((sum, row) => sum + row.allocated_minor, 0);

  /*
   * The invariant this module exists for. If it ever fails the development
   * WIP control account stops reconciling, which poisons the period close
   * checklist — so it fails here, loudly, rather than there, quietly.
   */
  if (allocated !== pool) {
    throw Object.assign(
      new Error(`Cost allocation lost ${pool - allocated} minor units of ${pool}.`),
      { status: 500 },
    );
  }

  return {
    basis,
    total_weight: totalWeight,
    allocated_minor: allocated,
    unallocated_minor: 0,
    allocations,
  };
};

/**
 * What still has to be released for a unit (ACC-10.4, and the catch-up).
 *
 * ── The problem this names ──────────────────────────────────────────────────
 *
 * A unit's allocated cost is its share of the pool AS IT STANDS. Costs keep
 * arriving after a handover — a retention released to the contractor, a
 * snagging bill, an estate road finished the following year — and each one
 * enlarges the pool and therefore enlarges what that unit should have been
 * charged. Its share of the new money cannot sit in WIP, because the unit is
 * gone and there is no future handover to release it; leaving it there would
 * carry inventory the company no longer owns.
 *
 * So the difference between what a handed-over unit is allocated now and what
 * was already released is a real, dated catch-up to cost of sales. Naming it
 * here keeps it visible — the alternative is a WIP balance that grows and
 * that nobody can account for.
 *
 * A negative difference — a project whose pool SHRANK, through a supplier
 * credit note — is a genuine credit back to cost of sales and is returned as
 * such rather than clamped to zero.
 */
const outstandingRelease = ({ allocatedMinor, releasedMinor = 0 }) => (
  asMinor(allocatedMinor) - asMinor(releasedMinor)
);

module.exports = {
  BASIS,
  DEFAULT_BASIS,
  allocate,
  weightOf,
  outstandingRelease,
};

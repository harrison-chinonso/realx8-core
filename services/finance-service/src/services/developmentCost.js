const { QueryTypes } = require('sequelize');
const { ROLE } = require('../../../../shared/src/accounting/chart');
const {
  BASIS, DEFAULT_BASIS, allocate, outstandingRelease,
} = require('../../../../shared/src/accounting/costAllocation');

/**
 * What a project has cost so far, and whose cost it is (ACC-10).
 *
 * ── Read from the journal, never from a running total ───────────────────────
 *
 * Every figure here is a query over journal_lines. There is no
 * `properties.wip_balance` column being incremented as bills are approved, and
 * there must not be: a stored total and the ledger disagree the first time
 * anything is posted by a route that forgot to update it, and then there are
 * two answers to what a project cost with nothing to say which is right.
 *
 * The ledger is the one place the cost is recorded, so it is the one place the
 * cost is read from. That makes the WIP report a reconciliation of the control
 * account rather than a second opinion about it — which is what ACC-10.6 asks
 * for and what period close (ACC-7.2) checks.
 *
 * ── Four movements, and they mean different things ──────────────────────────
 *
 * Work in progress goes up when a capitalisable cost is approved, and down for
 * three quite different reasons: a unit was handed over and took its share
 * with it; a cost landed late on a unit already gone; or the project is worth
 * less than it cost. Netting them into one balance would answer "how much is
 * on the balance sheet" and nothing else. Separating them by the source the
 * journal already carries costs one GROUP BY and answers every question the
 * report is actually asked.
 */

/** Sources whose movement on WIP is cost going IN. */
/*
 * 'manual' and 'import' are what the journal controller calls them — not
 * 'journal' and 'journal_import', which is what this list guessed at first.
 * A source name that does not exist silently lands in `unclassified`, which
 * the report shows but nobody would think to ask about.
 */
const CAPITALISING = ['bill', 'supplier_credit_note', 'manual', 'import', 'opening_balance'];
/** Sources whose movement on WIP is cost coming OUT to the P&L. */
const RELEASING = ['handover', 'cost_catch_up'];
/** Sources whose movement is the carrying amount being cut. */
const WRITING_DOWN = ['write_down'];

/**
 * The movement on development WIP for one project, split by what caused it.
 *
 * Debits less credits within each group, so a reversal — which is a mirrored
 * entry carrying the same source — cancels its original rather than being
 * counted as a release.
 */
const movementsFor = async (sequelize, { companyId, propertyId }) => {
  const rows = await sequelize.query(
    `SELECT e.source AS source,
            COALESCE(SUM(l.debit_minor), 0) AS dr,
            COALESCE(SUM(l.credit_minor), 0) AS cr
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN ledger_accounts a ON a.id = l.account_id
      WHERE a.role = :role
        AND l.property_id = :propertyId
        AND e.company_id ${companyId ? '= :companyId' : 'IS NULL'}
      GROUP BY e.source`,
    {
      replacements: { role: ROLE.DEVELOPMENT_WIP, propertyId, companyId: companyId ?? null },
      type: QueryTypes.SELECT,
    },
  );

  const sum = (sources) => rows
    .filter((row) => sources.includes(row.source))
    .reduce((total, row) => total + (Number(row.dr) - Number(row.cr)), 0);

  const capitalised = sum(CAPITALISING);
  const released = -sum(RELEASING);
  const writtenDown = -sum(WRITING_DOWN);

  /*
   * Anything posted to WIP by a source this module has never heard of.
   *
   * It is counted into the balance — the money is real and the balance sheet
   * must agree with the ledger — but reported separately, because a figure
   * nobody can explain should be visible rather than silently folded into
   * "capitalised". A manual journal correcting a coding error lands here, and
   * so would a bug.
   */
  const known = [...CAPITALISING, ...RELEASING, ...WRITING_DOWN];
  const unclassified = rows
    .filter((row) => !known.includes(row.source))
    .reduce((total, row) => total + (Number(row.dr) - Number(row.cr)), 0);

  return {
    capitalised_minor: capitalised,
    released_minor: released,
    written_down_minor: writtenDown,
    unclassified_minor: unclassified,
    balance_minor: capitalised - released - writtenDown + unclassified,
  };
};

/** The units of a project, as the allocation weighs them. */
const unitsOf = async (sequelize, propertyId) => sequelize.query(
  `SELECT u.id, u.name, u.price, u.size, u.unit, u.quantity, u.status
     FROM property_units u
    WHERE u.property_id = :propertyId
    ORDER BY u.id`,
  { replacements: { propertyId }, type: QueryTypes.SELECT },
);

/**
 * What has already been released against each unit, from the handovers
 * themselves rather than from the journal.
 *
 * The journal knows the property a release was posted against; only the
 * handover row knows the UNIT. That is why the figure is kept on the row
 * (see the model) — without it there is nothing to measure a catch-up
 * against, because the pool it was a share of has since moved.
 */
const releasedByUnit = async (sequelize, { companyId, propertyId }) => {
  const rows = await sequelize.query(
    `SELECT property_unit_id AS unit_id,
            COALESCE(SUM(cost_released_minor), 0) AS released,
            COUNT(*) AS handovers,
            MAX(handover_date) AS last_handover
       FROM handovers
      WHERE status = 'recorded'
        AND property_id = :propertyId
        AND company_id ${companyId ? '= :companyId' : 'IS NULL'}
      GROUP BY property_unit_id`,
    { replacements: { propertyId, companyId: companyId ?? null }, type: QueryTypes.SELECT },
  );
  const byUnit = new Map();
  rows.forEach((row) => {
    if (row.unit_id == null) return;
    byUnit.set(Number(row.unit_id), {
      released_minor: Number(row.released) || 0,
      handovers: Number(row.handovers) || 0,
      last_handover: row.last_handover,
    });
  });
  return byUnit;
};

/**
 * The accounting policy in force for a property (ACC-8.2, ACC-10.3).
 *
 * Narrowest first: the property's own row, then one for every property of its
 * type, then the company's. A row that leaves a field null says nothing about
 * that field and the next tier out answers — so a project can set its
 * allocation basis without also restating a recognition policy it was happy
 * to inherit.
 */
const policyFor = async (sequelize, { companyId, propertyId }) => {
  const rows = await sequelize.query(
    `SELECT p.scope, p.revenue_recognition, p.cost_allocation_basis,
            p.nrv_proceeds_minor, p.nrv_assessed_at, p.nrv_note
       FROM accounting_policies p
       LEFT JOIN properties prop ON prop.id = :propertyId
      WHERE p.company_id ${companyId ? '= :companyId' : 'IS NULL'}
        AND (
          (p.scope = 'property'      AND p.property_id = :propertyId)
       OR (p.scope = 'property_type' AND p.property_type = prop.type)
       OR (p.scope = 'company')
        )`,
    { replacements: { companyId: companyId ?? null, propertyId }, type: QueryTypes.SELECT },
  );

  const rank = { property: 0, property_type: 1, company: 2 };
  const ordered = [...rows].sort((a, b) => rank[a.scope] - rank[b.scope]);
  const firstOf = (field) => ordered.find((row) => row[field] != null)?.[field] ?? null;

  return {
    revenue_recognition: firstOf('revenue_recognition') || 'ON_HANDOVER',
    cost_allocation_basis: firstOf('cost_allocation_basis') || DEFAULT_BASIS,
    // NRV is only ever stated about one project, so only the property row counts.
    nrv_proceeds_minor: ordered.find((row) => row.scope === 'property')?.nrv_proceeds_minor ?? null,
    nrv_assessed_at: ordered.find((row) => row.scope === 'property')?.nrv_assessed_at ?? null,
    nrv_note: ordered.find((row) => row.scope === 'property')?.nrv_note ?? null,
  };
};

/**
 * Everything ACC-10 knows about one project.
 *
 * The allocation is recomputed here every time rather than stored, because it
 * MOVES: a bill approved this morning changes what every unit in the estate is
 * allocated. A stored figure would be right on the day it was written and
 * quietly wrong afterwards, and it is the figure that sets gross margin.
 */
const projectCost = async (sequelize, { companyId, propertyId }) => {
  const [movements, units, released, policy] = await Promise.all([
    movementsFor(sequelize, { companyId, propertyId }),
    unitsOf(sequelize, propertyId),
    releasedByUnit(sequelize, { companyId, propertyId }),
    policyFor(sequelize, { companyId, propertyId }),
  ]);

  /*
   * Allocated on cost less any write-down, not on cost.
   *
   * After a write-down the carrying amount IS the lower figure, and that is
   * what releases to cost of sales as units hand over. Allocating the original
   * cost would release more than the balance sheet holds and drive the control
   * account negative.
   */
  const pool = movements.capitalised_minor - movements.written_down_minor;
  const basis = policy.cost_allocation_basis;
  const split = allocate(pool, units.map((u) => ({
    id: u.id,
    size: Number(u.size) || 0,
    price_minor: Math.round((Number(u.price) || 0) * 100),
    quantity: u.quantity,
  })), basis);

  const byUnit = new Map(split.allocations.map((a) => [Number(a.unit_id), a]));

  const rows = units.map((unit) => {
    const allocation = byUnit.get(Number(unit.id)) || { weight: 0, allocated_minor: 0 };
    const handed = released.get(Number(unit.id)) || null;
    const releasedMinor = handed?.released_minor ?? 0;
    return {
      unit_id: unit.id,
      name: unit.name,
      status: unit.status,
      size: unit.size,
      unit: unit.unit,
      quantity: unit.quantity,
      price_minor: Math.round((Number(unit.price) || 0) * 100),
      weight: allocation.weight,
      allocated_minor: allocation.allocated_minor,
      released_minor: releasedMinor,
      handed_over: Boolean(handed),
      handed_over_on: handed?.last_handover ?? null,
      /*
       * Only a handed-over unit has anything outstanding. For one still held,
       * the difference between its allocation and nothing released is not a
       * debt to the P&L — it is simply inventory, sitting where it belongs
       * until the unit is sold and handed over.
       */
      outstanding_minor: handed
        ? outstandingRelease({ allocatedMinor: allocation.allocated_minor, releasedMinor })
        : 0,
    };
  });

  const catchUpMinor = rows.reduce((total, row) => total + row.outstanding_minor, 0);

  return {
    property_id: Number(propertyId),
    policy,
    basis,
    movements,
    pool_minor: pool,
    total_weight: split.total_weight,
    unallocated_minor: split.unallocated_minor,
    catch_up_minor: catchUpMinor,
    /*
     * What IAS 2 asks: is the carrying amount above what the project will
     * fetch? Null where nobody has said what it will fetch — reported as an
     * unanswered question rather than as a pass.
     */
    nrv_shortfall_minor: policy.nrv_proceeds_minor == null
      ? null
      : Math.max(movements.balance_minor - Number(policy.nrv_proceeds_minor), 0),
    units: rows,
  };
};

/**
 * What one unit's handover should release, right now.
 *
 * Used by ACC-8's handover, which posts the revenue and this cost in a single
 * entry. Returns zero rather than throwing where the project has no pool or
 * the unit has no weight — both are real situations (bare land, an estate
 * whose unit areas have not been entered) and neither is a reason to refuse a
 * handover that genuinely happened. The WIP report is where they show.
 */
const releaseForUnit = async (sequelize, { companyId, propertyId, unitId }) => {
  if (!propertyId || !unitId) return { cost_minor: 0, reason: 'no_unit' };
  const project = await projectCost(sequelize, { companyId, propertyId });
  const unit = project.units.find((row) => Number(row.unit_id) === Number(unitId));
  if (!unit) return { cost_minor: 0, reason: 'unit_not_on_project' };
  const amount = outstandingRelease({
    allocatedMinor: unit.allocated_minor, releasedMinor: unit.released_minor,
  });
  return {
    cost_minor: Math.max(amount, 0),
    basis: project.basis,
    pool_minor: project.pool_minor,
    weight: unit.weight,
    total_weight: project.total_weight,
    reason: amount > 0 ? null : 'nothing_capitalised',
  };
};

module.exports = {
  BASIS,
  movementsFor,
  unitsOf,
  policyFor,
  projectCost,
  releaseForUnit,
};

const { QueryTypes } = require('sequelize');
const { columnsOf } = require('../../../../shared/src/dialect');

/**
 * Gives every company a set of cost types to raise bills against (ACC-10.2).
 *
 * ── Which costs are part of a unit, and which are the cost of a year ────────
 *
 * The split below is IAS 2.10–2.16 applied to a property developer. The cost
 * of inventory is the cost of bringing it to its present location and
 * condition: the land, the materials, the labour and subcontractors that built
 * it, the site overheads incurred in building it, and infrastructure the
 * planning consent made a condition of building at all. Selling and marketing,
 * administration, and general financing are excluded by name — they are the
 * cost of running a business that happens to be building, and IAS 2.16 is
 * explicit that they do not belong in the asset.
 *
 * The one genuine judgement is borrowing cost. IAS 23 requires interest
 * directly attributable to a qualifying asset to be capitalised, and a unit
 * under construction over 24 months is a qualifying asset. It is seeded here
 * as NOT capitalisable, because doing it properly means a capitalisation rate,
 * a commencement date and a suspension rule per project, and a company that
 * capitalises interest by ticking a box on a bill would be doing it wrong in a
 * way that inflates the balance sheet. A company whose accountant wants it can
 * turn the flag on for that type and take the decision knowingly.
 *
 * ── Additive, exactly like the chart seeder ─────────────────────────────────
 *
 * Matched on NAME per company, created only when absent, nothing existing ever
 * touched. A company that has decided site security is not capitalisable has
 * DECIDED something, and a seeder that reasserted the default on the next boot
 * would undo it silently.
 */

/**
 * [name, capitalisable, the chart CODE it codes to, why].
 *
 * Addressed by code rather than by role because most expense accounts have no
 * role — roles name the accounts the posting rules must find, and "marketing"
 * is not one of them. Coding every non-capitalisable type by code is what
 * stops them all falling through to cost of units sold, which is what happened
 * the first time this shipped: a billboard on the Lekki road was reported as
 * part of what a unit cost to build, and the gross margin it produced was
 * wrong in the direction nobody checks.
 */
const DEFAULT_TYPES = [
  ['Land acquisition', true, '1210',
    'The site itself, and the legal cost of acquiring it.'],
  ['Construction materials', true, '1210',
    'Everything that ends up in the building.'],
  ['Subcontractor works', true, '1210',
    'Contractors building on the site — the usual case.'],
  ['Direct labour', true, '1210',
    'Site labour employed on the build itself.'],
  ['Site overheads', true, '1210',
    'Security, power, site office — incurred because the site is being built on.'],
  ['Infrastructure and planning conditions', true, '1210',
    'Roads, drainage and anything consent made a condition of building.'],
  ['Development professional fees', true, '1210',
    'Architects, engineers and surveyors engaged on the project.'],

  ['Selling and marketing', false, '5120',
    'The cost of selling the units, not of building them. IAS 2.16 excludes it.'],
  ['Administration', false, '5200',
    'Running the company. Excluded from inventory however the project is going.'],
  ['Finance and borrowing costs', false, '5300',
    'Interest. Capitalising it properly needs a rate and a project window — turn this on only with your accountant.'],
  ['Statutory and regulatory', false, '5240',
    'Taxes, levies and filings that are not a condition of the planning consent.'],
  ['Repairs and maintenance', false, '5260',
    'Keeping what already exists working, rather than building something new.'],
  ['Other operating cost', false, '5270',
    'Anything else. If it is used often, give it its own type.'],
];

const companiesToSeed = async (sequelize) => {
  // Schema-aware for the reason seedChartOfAccounts is: `companies` does not
  // carry deleted_at everywhere, and a seeder that hides its own failure is
  // worse than one that does not run.
  const columns = (await columnsOf(sequelize, 'companies')) || new Map();
  const filter = columns.has('deleted_at') ? 'WHERE deleted_at IS NULL' : '';
  const rows = await sequelize.query(
    `SELECT id FROM companies ${filter}`,
    { type: QueryTypes.SELECT },
  );
  return [null, ...rows.map((row) => Number(row.id))];
};

/**
 * The account a seeded type codes to, by code in that company's own chart.
 *
 * Null where the company has renumbered and no longer has that code — the
 * bill then falls back to cost of sales, which is visible and correctable,
 * rather than the seeder inventing an account.
 */
const accountIdFor = async (sequelize, companyId, code) => {
  if (!code) return null;
  const [row] = await sequelize.query(
    `SELECT id FROM ledger_accounts
      WHERE company_id ${companyId ? '= :companyId' : 'IS NULL'} AND code = :code
      LIMIT 1`,
    { replacements: { companyId, code }, type: QueryTypes.SELECT },
  );
  return row?.id ?? null;
};

const seedOne = async (sequelize, companyId) => {
  const existing = await sequelize.query(
    `SELECT name FROM expense_types
      WHERE company_id ${companyId ? '= :companyId' : 'IS NULL'}`,
    { replacements: { companyId }, type: QueryTypes.SELECT },
  );
  const have = new Set(existing.map((row) => String(row.name).toLowerCase()));

  const missing = DEFAULT_TYPES.filter(([name]) => !have.has(name.toLowerCase()));
  if (!missing.length) return 0;

  for (let i = 0; i < missing.length; i += 1) {
    const [name, capitalisable, code, note] = missing[i];
    // eslint-disable-next-line no-await-in-loop
    const accountId = await accountIdFor(sequelize, companyId, code);
    // eslint-disable-next-line no-await-in-loop
    await sequelize.query(
      `INSERT INTO expense_types
         (company_id, name, capitalisable, account_id, note, is_active, sort_order, created_at, updated_at)
       VALUES (:companyId, :name, :capitalisable, :accountId, :note, true, :sortOrder, NOW(), NOW())`,
      {
        replacements: {
          companyId,
          name,
          capitalisable,
          accountId,
          note,
          sortOrder: DEFAULT_TYPES.findIndex(([n]) => n === name),
        },
        type: QueryTypes.INSERT,
      },
    ).catch((error) => {
      // A concurrent boot won the race. The unique index refused the loser,
      // which is the right outcome.
      if (!/duplicate|unique/i.test(error.message || '')) throw error;
    });
  }

  return missing.length;
};

module.exports = async function seedExpenseTypes(sequelize) {
  try {
    let seeded = 0;
    let companies = 0;
    for (const companyId of await companiesToSeed(sequelize)) {
      // eslint-disable-next-line no-await-in-loop
      const added = await seedOne(sequelize, companyId);
      if (added) { seeded += added; companies += 1; }
    }
    if (seeded) {
      console.log(`[accounting] seeded ${seeded} cost type(s) across ${companies} company set(s)`);
    }
  } catch (error) {
    // Best effort, like the seeders beside it. Without types a bill simply has
    // no kind and does not capitalise, which is the conservative answer.
    console.error(`[accounting] cost type seed failed: ${error.message}`);
  }
};

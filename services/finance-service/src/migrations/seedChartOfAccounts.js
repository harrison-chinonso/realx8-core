const { QueryTypes } = require('sequelize');
const { columnsOf } = require('../../../../shared/src/dialect');
const { DEFAULT_CHART, parentCodeOf } = require('../../../../shared/src/accounting/chart');
const { forgetChart } = require('../../../../shared/src/accounting/ledger');

/**
 * Gives every company a working chart of accounts (ACC-1.2).
 *
 * ── Additive, and never overwriting ─────────────────────────────────────────
 *
 * The same rule seedRolesAndPermissions follows, for the same reason. A
 * company that has edited its chart has DECIDED something — renamed an
 * account, renumbered it to match their old system, deactivated the ones they
 * do not use — and a seeder that reasserted the defaults on every boot would
 * silently undo all of it on a restart.
 *
 * So: an account is created if no account with that CODE exists for the
 * company. Nothing existing is touched, ever. A company that has renumbered
 * 1110 to 1200 will get a second 1110 seeded on the next boot, which looks
 * wrong until you consider the alternative — matching on role and quietly
 * renaming an account the tenant deliberately changed. The visible extra row
 * is deactivatable in one click; the silent overwrite is not detectable at all.
 *
 * ── Why it runs on every boot rather than once ──────────────────────────────
 *
 * New companies arrive after the first run, and a later epic adds a control
 * account that an existing tenant then needs — ACC-10's development WIP is
 * already in the default chart for exactly this reason. Both cases are the
 * same operation: create what is missing, touch what is there.
 */

/**
 * Companies to seed. Null is the platform's own set, which exists too.
 *
 * The soft-delete filter is applied only if the column is there. `companies`
 * does not carry one in every installation, and the first version of this
 * named it unconditionally: the query threw, the catch below turned that into
 * an empty list, and exactly one chart — the platform's — was seeded while the
 * log said it had succeeded. A best-effort seeder that hides its own failure
 * is worse than one that does not run, so the lookup is now schema-aware and
 * its failure is reported rather than absorbed.
 */
const companiesToSeed = async (sequelize) => {
  const columns = (await columnsOf(sequelize, 'companies')) || new Map();
  const filter = columns.has('deleted_at') ? 'WHERE deleted_at IS NULL' : '';
  const rows = await sequelize.query(
    `SELECT id FROM companies ${filter}`,
    { type: QueryTypes.SELECT },
  );
  return [null, ...rows.map((row) => Number(row.id))];
};

const seedOne = async (sequelize, companyId) => {
  const existing = await sequelize.query(
    `SELECT code FROM ledger_accounts
      WHERE company_id ${companyId ? '= :companyId' : 'IS NULL'}`,
    { replacements: { companyId }, type: QueryTypes.SELECT },
  );
  const have = new Set(existing.map((row) => String(row.code)));

  const missing = DEFAULT_CHART.filter(([code]) => !have.has(String(code)));
  if (!missing.length) return 0;

  for (const [code, name, type, role] of missing) {
    /*
     * One row at a time rather than a bulk insert.
     *
     * A company that already holds an account claiming this ROLE — because
     * they renumbered it — must not have a second one created, which the
     * unique index would refuse and take the whole bulk insert down with it.
     * Checked per row, and a clash means the tenant has already provided it.
     */
    if (role) {
      // eslint-disable-next-line no-await-in-loop
      const [claimed] = await sequelize.query(
        `SELECT id FROM ledger_accounts
          WHERE company_id ${companyId ? '= :companyId' : 'IS NULL'} AND role = :role LIMIT 1`,
        { replacements: { companyId, role }, type: QueryTypes.SELECT },
      );
      if (claimed) continue;
    }

    // eslint-disable-next-line no-await-in-loop
    await sequelize.query(
      `INSERT INTO ledger_accounts
         (company_id, code, name, ${sequelize.getDialect() === 'postgres' ? '"type"' : '`type`'},
          role, parent_code, is_active, is_system, created_at, updated_at)
       VALUES (:companyId, :code, :name, :type, :role, :parent, true, true, NOW(), NOW())`,
      {
        replacements: {
          companyId, code, name, type, role, parent: parentCodeOf(code),
        },
        type: QueryTypes.INSERT,
      },
    ).catch((error) => {
      // A concurrent boot may have won the race between the check and the
      // insert. The index refuses the loser, which is the right outcome.
      if (!/duplicate|unique/i.test(error.message || '')) throw error;
    });
  }

  forgetChart(companyId);
  return missing.length;
};

module.exports = async function seedChartOfAccounts(sequelize) {
  try {
    let seeded = 0;
    let companies = 0;
    for (const companyId of await companiesToSeed(sequelize)) {
      // eslint-disable-next-line no-await-in-loop
      const added = await seedOne(sequelize, companyId);
      if (added) { seeded += added; companies += 1; }
    }
    if (seeded) {
      console.log(`[accounting] seeded ${seeded} account(s) across ${companies} chart(s)`);
    }
  } catch (error) {
    /*
     * Best effort, like the seeders beside it. A chart that fails to seed
     * leaves posting to fall back to suspense and say so — which is loud and
     * recoverable — whereas refusing to boot takes the sales platform down
     * for an accounting feature nobody may be using yet.
     */
    console.error(`[accounting] chart seed failed: ${error.message}`);
  }
};

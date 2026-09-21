/**
 * The seeded defaults, seeded again and again (ACC-1.2, ACC-10.2).
 *
 * ── Why this needs its own check ────────────────────────────────────────────
 *
 * Both seeders run on EVERY boot of every deployment, for ever. They have to
 * be additive — create what is missing, touch what is there — and the failure
 * mode if they are not is quiet: a company ends up with two "Subcontractor
 * works" in the dropdown, or two account 1110s, and nobody notices until
 * somebody picks the wrong one and a cost lands in an account nothing reads.
 *
 * So the test is simply: run them three times and demand nothing changes after
 * the first.
 *
 * ── The gap worth being explicit about ──────────────────────────────────────
 *
 * The unique indexes are on (company_id, name) and (company_id, code), and
 * BOTH MySQL and Postgres treat NULL as distinct in a unique index. The
 * platform-level set — company_id NULL — is therefore not protected by the
 * index at all; it is protected only by the SELECT the seeder does first.
 *
 * That is fine for the ordinary case, which is one process booting. It is not
 * fine for two processes booting at the same instant, which a rolling deploy
 * does routinely. This file asserts the ordinary case works and states the
 * racing one plainly rather than leaving it to be discovered.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { QueryTypes } = require('sequelize');
const mysql = require('mysql2/promise');
const { isDuplicateError } = require('../shared/src/dialect');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_seeds`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifyseeds';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

(async () => {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  const models = require('../services/finance-service/src/models');
  const { sequelize } = models;
  const userModels = require('../services/user-service/src/models');

  await userModels.Company.sync({ force: true });
  await userModels.RealtorLevel.sync({ force: true });
  await userModels.User.sync({ force: true });
  await userModels.Setting.sync({ force: true });
  await models.LedgerAccount.sync({ force: true });
  await models.ExpenseType.sync({ force: true });

  await userModels.Company.bulkCreate([
    { id: 1, name: 'One', slug: 'one', email: 'one@test' },
    { id: 2, name: 'Two', slug: 'two', email: 'two@test' },
  ]);

  const seedChart = require('../services/finance-service/src/migrations/seedChartOfAccounts');
  const seedTypes = require('../services/finance-service/src/migrations/seedExpenseTypes');

  /** Rows, and rows that are actually distinct, per scope. */
  const census = async (table, column) => sequelize.query(
    `SELECT COALESCE(company_id, -1) AS scope,
            COUNT(*) AS rows_here,
            COUNT(DISTINCT ${column}) AS distinct_here
       FROM ${table}
      GROUP BY company_id
      ORDER BY COALESCE(company_id, -1)`,
    { type: QueryTypes.SELECT },
  );

  const tidy = (rows) => rows.map((row) => (
    `${row.scope === -1 ? 'platform' : `company ${row.scope}`}: ${row.rows_here}`
  )).join(', ');

  // ── First run ─────────────────────────────────────────────────────────────
  console.log('\n── The first boot ──────────────────────────────────────────────');
  await seedChart(sequelize);
  await seedTypes(sequelize);

  const chartFirst = await census('ledger_accounts', 'code');
  const typesFirst = await census('expense_types', 'name');

  check('Every company gets its own chart, and the platform one exists too',
    chartFirst.length === 3, tidy(chartFirst));
  check('...and its own set of cost types',
    typesFirst.length === 3, tidy(typesFirst));
  check('No scope has two accounts with the same code',
    chartFirst.every((row) => Number(row.rows_here) === Number(row.distinct_here)),
    chartFirst.map((r) => `${r.rows_here}/${r.distinct_here}`).join(' · '));
  check('No scope has two cost types with the same name',
    typesFirst.every((row) => Number(row.rows_here) === Number(row.distinct_here)),
    typesFirst.map((r) => `${r.rows_here}/${r.distinct_here}`).join(' · '));

  // ── And again. And again. ─────────────────────────────────────────────────
  console.log('\n── Two more boots, which must change nothing ───────────────────');
  await seedChart(sequelize);
  await seedTypes(sequelize);
  await seedChart(sequelize);
  await seedTypes(sequelize);

  const chartAfter = await census('ledger_accounts', 'code');
  const typesAfter = await census('expense_types', 'name');

  check('The chart is identical after three boots',
    JSON.stringify(chartFirst) === JSON.stringify(chartAfter),
    `${tidy(chartFirst)}  →  ${tidy(chartAfter)}`);
  check('The cost types are identical after three boots',
    JSON.stringify(typesFirst) === JSON.stringify(typesAfter),
    `${tidy(typesFirst)}  →  ${tidy(typesAfter)}`);

  // ── A company that arrives later ──────────────────────────────────────────
  console.log('\n── A company created after the first boot ──────────────────────');
  await userModels.Company.create({ id: 3, name: 'Three', slug: 'three', email: 'three@test' });
  await seedChart(sequelize);
  await seedTypes(sequelize);

  const chartLater = await census('ledger_accounts', 'code');
  const typesLater = await census('expense_types', 'name');
  check('...gets a chart and cost types of its own',
    chartLater.length === 4 && typesLater.length === 4, tidy(chartLater));
  check('...and the companies already seeded are untouched',
    JSON.stringify(chartLater.slice(0, 3)) === JSON.stringify(chartAfter)
    && JSON.stringify(typesLater.slice(0, 3)) === JSON.stringify(typesAfter), '');

  // ── What a company has CHANGED is never reasserted ────────────────────────
  console.log('\n── A company that has edited its own defaults ──────────────────');
  {
    await sequelize.query(
      "UPDATE expense_types SET capitalisable = true WHERE company_id = 1 AND name = 'Finance and borrowing costs'",
      { type: QueryTypes.UPDATE },
    );
    await sequelize.query(
      "UPDATE ledger_accounts SET name = 'Our own name for it' WHERE company_id = 1 AND code = '5120'",
      { type: QueryTypes.UPDATE },
    );

    await seedChart(sequelize);
    await seedTypes(sequelize);

    const [type] = await sequelize.query(
      "SELECT capitalisable FROM expense_types WHERE company_id = 1 AND name = 'Finance and borrowing costs'",
      { type: QueryTypes.SELECT },
    );
    const [account] = await sequelize.query(
      "SELECT name FROM ledger_accounts WHERE company_id = 1 AND code = '5120'",
      { type: QueryTypes.SELECT },
    );

    /*
     * A company that turned borrowing costs on, or renamed an account, has
     * DECIDED something. A seeder that reasserted the default on the next boot
     * would undo it silently — which is worse than never having seeded at all,
     * because nobody would think to check.
     */
    check('A capitalisation decision the company changed survives a boot',
      Boolean(Number(type?.capitalisable)) === true, `capitalisable = ${type?.capitalisable}`);
    check('...and so does an account they renamed',
      account?.name === 'Our own name for it', account?.name);
  }

  // ── The index, and where it does not reach ────────────────────────────────
  console.log('\n── What the unique indexes actually protect ────────────────────');
  {
    /*
     * Asked through the codebase's own helper rather than by matching on the
     * message. Sequelize wraps a unique violation as "Validation error", which
     * no sensible regex for "duplicate" catches — and a check that reports a
     * refusal as an unexpected error is a check that lies about the thing it
     * was written to prove.
     */
    const duplicate = async (sql) => sequelize.query(sql, { type: QueryTypes.INSERT })
      .then(() => 'allowed')
      .catch((error) => (isDuplicateError(error) ? 'refused' : `error: ${error.message}`));

    const companyScoped = await duplicate(
      `INSERT INTO expense_types (company_id, name, capitalisable, is_active, sort_order, created_at, updated_at)
       VALUES (1, 'Subcontractor works', false, true, 0, NOW(), NOW())`,
    );
    check('A company cannot end up with the same cost type twice',
      companyScoped === 'refused', `the index ${companyScoped} it`);

    const companyAccount = await duplicate(
      `INSERT INTO ledger_accounts (company_id, code, name, ${sequelize.getDialect() === 'postgres' ? '"type"' : '`type`'}, is_active, is_system, created_at, updated_at)
       VALUES (1, '1110', 'Another receivables', 'asset', true, false, NOW(), NOW())`,
    );
    check('...nor the same account code twice',
      companyAccount === 'refused', `the index ${companyAccount} it`);

    /*
     * The platform scope is the exception, and it is worth stating rather than
     * discovering: company_id is NULL there, and a unique index treats NULLs
     * as distinct on both engines. So this row IS accepted by the database —
     * what stops it in practice is the SELECT the seeder runs first, which the
     * three boots above already proved works.
     *
     * It is left this way rather than fixed with a sentinel company_id,
     * because changing the column to a magic 0 would mean rewriting every
     * company-scoped query in the module to know about it. The exposure is one
     * process racing another at the same instant on a deployment that has
     * never been seeded — and the result would be a duplicate the seeder then
     * skips for ever, visible in the platform chart, deletable in one click.
     */
    const platformScoped = await duplicate(
      `INSERT INTO expense_types (company_id, name, capitalisable, is_active, sort_order, created_at, updated_at)
       VALUES (NULL, 'Subcontractor works', false, true, 0, NOW(), NOW())`,
    );
    check('The PLATFORM set is guarded by the seeder, not by the index',
      platformScoped === 'allowed',
      'a unique index treats NULLs as distinct on both engines — so repeated boots '
      + 'are safe (proved above) but two processes racing on a fresh database are not');

    // Leave the database as the seeders would have it.
    await sequelize.query(
      "DELETE FROM expense_types WHERE company_id IS NULL AND name = 'Subcontractor works' AND capitalisable = false",
      { type: QueryTypes.DELETE },
    );
  }

  console.log(`\n  ${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass}/${pass + fail} checks passed.\x1b[0m\n`);

  await sequelize.close();
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  console.log(`  Scratch database ${DB} dropped.\n`);
  await admin.end();
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error('\x1b[31mThe verification itself failed:\x1b[0m', error);
  process.exit(1);
});

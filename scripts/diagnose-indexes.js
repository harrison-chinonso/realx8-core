/**
 * Why does a boot say "<index> already exists" when the migration checked first?
 *
 * The migrations that add the per-company unique indexes all guard themselves:
 * `if (await indexExists(...)) return;`. So "already exists" can only mean the
 * check said NO and the create said YES — the two disagreed about the same
 * index.
 *
 * On Postgres the check is:
 *
 *     SELECT 1 FROM pg_indexes
 *      WHERE schemaname = CURRENT_SCHEMA() AND tablename = ... AND indexname = ...
 *
 * and `CREATE UNIQUE INDEX` resolves the name against the whole `search_path`.
 * Those are not the same question. If the tables live in a schema that is on
 * the search_path but is not CURRENT_SCHEMA() — which happens with a restored
 * dump, a non-default `search_path` on the role, or a schema-qualified
 * connection — the check looks in the wrong place, finds nothing, and the
 * create then collides with the index that was there all along.
 *
 * The consequences are worse than the noise: the guard that was supposed to be
 * added is skipped, and the OLD global unique index it was meant to replace is
 * never dropped, so document numbering stays globally unique instead of
 * per-company.
 *
 * This reports what each side actually sees, so the answer is one command
 * rather than an afternoon.
 *
 *   npm run diagnose:indexes
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { Sequelize, QueryTypes } = require('sequelize');
const { isPostgres, indexExists, tableExists } = require('../shared/src/dialect');

/** The indexes the boot migrations try to add, and where. */
const EXPECTED = [
  ['invoices', 'ux_invoices_company_reference'],
  ['credit_notes', 'ux_credit_notes_company_reference'],
  ['debit_notes', 'ux_debit_notes_company_reference'],
  ['receipts', 'ux_receipts_company_reference'],
  ['transactions', 'ux_transactions_company_reference'],
  ['invoice_payments', 'ux_invoice_payments_company_reference'],
  ['referral_links', 'ux_referral_links_company_realtor_property'],
  ['audit_logs', 'ix_audit_logs_company_created'],
];

const GREEN = '\x1b[32m'; const RED = '\x1b[31m'; const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m'; const RESET = '\x1b[0m';

(async () => {
  const dialect = (process.env.DB_DIALECT || 'mysql').toLowerCase();
  const sequelize = new Sequelize(
    process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD,
    {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || (dialect === 'postgres' ? 5432 : 3306),
      dialect,
      logging: false,
      dialectOptions: /^true$/i.test(process.env.DB_SSL || '')
        ? { ssl: { require: true, rejectUnauthorized: false } }
        : {},
    },
  );

  await sequelize.authenticate();
  const pg = isPostgres(sequelize);
  console.log(`\nConnected to ${process.env.DB_NAME} on ${dialect}.\n`);

  if (pg) {
    const [{ current_schema, search_path, current_user: user }] = await sequelize.query(
      "SELECT CURRENT_SCHEMA() AS current_schema, current_setting('search_path') AS search_path, CURRENT_USER AS current_user",
      { type: QueryTypes.SELECT },
    );
    console.log(`  CURRENT_SCHEMA() : ${current_schema}`);
    console.log(`  search_path      : ${search_path}`);
    console.log(`  current_user     : ${user}\n`);

    if (String(search_path).split(',').map((s) => s.trim().replace(/"/g, '')).filter((s) => s && s !== '$user')[0] !== current_schema) {
      console.log(`${YELLOW}  The first schema on the search_path is not CURRENT_SCHEMA(). `
        + `That alone can make the migrations' index check look in the wrong place.${RESET}\n`);
    }
  }

  let mismatches = 0;

  for (const [table, index] of EXPECTED) {
    /**
     * "Absent" and "invisible" are different, and telling them apart is the
     * whole point.
     *
     * tableExists filters on CURRENT_SCHEMA(); a plain query resolves through
     * the whole search_path. A table reachable by the second and not the first
     * is exactly the disease: every migration believes it is missing, so the
     * ones that create things collide and the ones that alter things silently
     * do nothing.
     */
    // eslint-disable-next-line no-await-in-loop
    const visible = await tableExists(sequelize, table);
    // eslint-disable-next-line no-await-in-loop
    const reachable = pg
      ? (await sequelize.query('SELECT to_regclass(:table) AS oid', {
        replacements: { table }, type: QueryTypes.SELECT,
      }))[0]?.oid != null
      : visible;

    if (!visible && reachable) {
      mismatches += 1;
      console.log(`  ${table.padEnd(18)} ${index.padEnd(44)} ${RED}MISMATCH${RESET}`);
      console.log(`    ${RED}the table is reachable by queries but invisible to CURRENT_SCHEMA().${RESET}`);
      // eslint-disable-next-line no-await-in-loop
      const [where] = await sequelize.query(
        `SELECT n.nspname AS in_schema FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.oid = to_regclass(:table)`,
        { replacements: { table }, type: QueryTypes.SELECT },
      );
      console.log(`    ${DIM}it is in schema "${where?.in_schema}"; CURRENT_SCHEMA() is different${RESET}`);
      console.log(`    ${YELLOW}Every migration guard on this table is answering the wrong `
        + `question — this is the cause, not a symptom.${RESET}`);
      continue;
    }

    if (!visible) {
      console.log(`  ${DIM}${table.padEnd(18)} ${index.padEnd(44)} table absent — skipped${RESET}`);
      continue;
    }

    // What the migration asks.
    // eslint-disable-next-line no-await-in-loop
    const checkSays = await indexExists(sequelize, table, index);

    // What the database actually holds, without the schema filter.
    // eslint-disable-next-line no-await-in-loop
    const rows = await sequelize.query(
      pg
        // `schema` is a reserved word in MySQL, so the alias is not that.
        ? `SELECT schemaname AS in_schema, tablename AS on_table FROM pg_indexes WHERE indexname = :index`
        : `SELECT table_schema AS in_schema, table_name AS on_table FROM information_schema.statistics
            WHERE index_name = :index AND table_schema = DATABASE()
            GROUP BY table_schema, table_name`,
      { replacements: { index }, type: QueryTypes.SELECT },
    );

    const reallyExists = rows.length > 0;
    const agree = checkSays === reallyExists;
    if (!agree) mismatches += 1;

    const mark = agree ? (reallyExists ? `${GREEN}ok${RESET}` : `${DIM}absent${RESET}`) : `${RED}MISMATCH${RESET}`;
    console.log(`  ${table.padEnd(18)} ${index.padEnd(44)} ${mark}`);
    if (!agree) {
      console.log(`    ${RED}the migration's check says ${checkSays}, the database says ${reallyExists}${RESET}`);
      rows.forEach((row) => console.log(`    ${DIM}found in schema "${row.in_schema}" on table "${row.on_table}"${RESET}`));
      console.log(`    ${YELLOW}This is the "already exists" you are seeing: the guard skips, `
        + `the create collides.${RESET}`);
    } else if (reallyExists && pg && rows.length > 1) {
      console.log(`    ${YELLOW}declared in ${rows.length} schemas — Postgres index names are `
        + `schema-wide, unlike MySQL's, which are per table.${RESET}`);
    }
  }

  console.log('');
  if (mismatches) {
    console.log(`${RED}${mismatches} index/indexes are present but invisible to the migration's check.${RESET}`);
    console.log(`${DIM}Fix by making the connection's CURRENT_SCHEMA() the schema the tables are in — `
      + `e.g. set search_path on the database role, or add ?options=-csearch_path%3D<schema> to the `
      + `connection. The migrations are idempotent once the two agree.${RESET}\n`);
  } else {
    console.log(`${GREEN}The migration's index check agrees with the database on every index.${RESET}\n`);
  }

  await sequelize.close();
  process.exit(mismatches ? 1 : 0);
})().catch((error) => {
  console.error('\nCould not run the diagnosis:', error.message);
  process.exit(1);
});

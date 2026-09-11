/**
 * The same assertions, run against BOTH engines.
 *
 * This application is developed on MySQL and deployed on Postgres, which is the
 * arrangement that produced `invalid input value for enum
 * enum_commision_status: "pending"` in production and nothing at all in
 * development.
 *
 * Testing on one engine cannot catch that. Every check below therefore runs
 * twice, against a real MySQL and a real Postgres, and a difference between
 * them is a failure rather than something to be discovered on deploy.
 *
 * MySQL comes from cred.env. Postgres comes from PG_* (defaults suit
 *   docker run -d -p 5433:5432 -e POSTGRES_PASSWORD=postgres postgres:16-alpine
 * ). If Postgres is not reachable the run SKIPS it loudly rather than passing.
 *
 *   npm run verify:dialect
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { Sequelize, QueryTypes } = require('sequelize');
const mysql = require('mysql2/promise');
const { Client } = require('pg');

const D = require('../shared/src/dialect');

const MYSQL_DB = `${process.env.DB_NAME || 'realto'}_verify_dialect`;
const PG = {
  host: process.env.PG_HOST || 'localhost',
  port: Number(process.env.PG_PORT || 5433),
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
  database: process.env.PG_DATABASE || 'realx8test',
};

let pass = 0; let fail = 0;
const results = [];
const check = (engine, label, ok, detail = '') => {
  results.push({ engine, label, ok, detail });
  if (ok) pass += 1; else fail += 1;
};

/** Builds the throwaway schema both engines are tested against. */
const buildSchema = async (sequelize) => {
  const pg = D.isPostgres(sequelize);
  await sequelize.query('DROP TABLE IF EXISTS commissions');
  await sequelize.query('DROP TABLE IF EXISTS document_sequences');
  await sequelize.query('DROP TABLE IF EXISTS settings');
  if (pg) await sequelize.query('DROP TYPE IF EXISTS enum_commissions_status');

  if (pg) {
    await sequelize.query("CREATE TYPE enum_commissions_status AS ENUM ('created','approved')");
    await sequelize.query(`
      CREATE TABLE commissions (
        id SERIAL PRIMARY KEY,
        status enum_commissions_status DEFAULT 'created',
        company_id INT NULL,
        reference VARCHAR(64) NULL
      )`);
    await sequelize.query(`
      CREATE TABLE document_sequences (
        company_scope INT NOT NULL,
        doc_type VARCHAR(32) NOT NULL,
        next_value INT NOT NULL DEFAULT 1,
        PRIMARY KEY (company_scope, doc_type)
      )`);
    // Reserved words, which is why quoting has to be right.
    await sequelize.query('CREATE TABLE settings ("key" VARCHAR(64), "value" TEXT, "group" VARCHAR(64))');
  } else {
    await sequelize.query(`
      CREATE TABLE commissions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        status ENUM('created','approved') DEFAULT 'created',
        company_id INT NULL,
        reference VARCHAR(64) NULL
      )`);
    await sequelize.query(`
      CREATE TABLE document_sequences (
        company_scope INT NOT NULL,
        doc_type VARCHAR(32) NOT NULL,
        next_value INT NOT NULL DEFAULT 1,
        PRIMARY KEY (company_scope, doc_type)
      )`);
    await sequelize.query('CREATE TABLE settings (`key` VARCHAR(64), `value` TEXT, `group` VARCHAR(64))');
  }
};

/** Every assertion, engine-agnostic. Anything that differs is the bug. */
const runChecks = async (sequelize, engine) => {
  await buildSchema(sequelize);

  // ── Identifier quoting ────────────────────────────────────────────────────
  {
    await sequelize.query(
      `INSERT INTO settings (${D.q(sequelize, 'key')}, ${D.q(sequelize, 'value')}, ${D.q(sequelize, 'group')})
       VALUES ('currency', 'NGN', 'appearance')`,
    );
    const rows = await sequelize.query(
      `SELECT ${D.q(sequelize, 'value')} AS v FROM settings WHERE ${D.q(sequelize, 'group')} = 'appearance'`,
      { type: QueryTypes.SELECT },
    );
    check(engine, 'Reserved-word columns (key/value/group) can be read', rows[0]?.v === 'NGN',
      'backticks are a syntax error in Postgres and double quotes are one in MySQL');
  }

  // ── Column introspection ──────────────────────────────────────────────────
  {
    const cols = await D.columnsOf(sequelize, 'commissions');
    check(engine, 'columnsOf lists a real table', Boolean(cols) && cols.has('status'),
      cols ? [...cols.keys()].join(', ') : 'null');
    const missing = await D.columnsOf(sequelize, 'no_such_table_here');
    check(engine, 'columnsOf returns null for a table that does not exist', missing === null,
      'SHOW COLUMNS threw on Postgres and the catch read it as "fresh database"');
  }

  // ── The reported production failure ───────────────────────────────────────
  {
    const before = await D.enumValues(sequelize, 'commissions', 'status');
    check(engine, 'enumValues reads the accepted values', JSON.stringify(before) === '["created","approved"]',
      before.join(', '));

    let refusedBefore = false;
    try {
      await sequelize.query("INSERT INTO commissions (status) VALUES ('pending')");
    } catch { refusedBefore = true; }
    check(engine, "Writing 'pending' is refused before the enum is widened", refusedBefore,
      'this is the production error, reproduced');

    const added = await D.widenEnum(sequelize, 'commissions', 'status',
      ['pending', 'created', 'payment_requested', 'approved', 'paid', 'cancelled'],
      { defaultValue: 'created' });
    check(engine, 'widenEnum adds the missing values', added.length === 4, `added ${added.join(', ')}`);

    let accepted = true;
    try {
      await sequelize.query("INSERT INTO commissions (status) VALUES ('pending')");
    } catch { accepted = false; }
    check(engine, "...and now 'pending' is accepted", accepted, 'the fix for the reported error');

    const again = await D.widenEnum(sequelize, 'commissions', 'status',
      ['pending', 'created', 'payment_requested', 'approved', 'paid', 'cancelled']);
    check(engine, 'widenEnum is idempotent, so it is safe on every boot', again.length === 0);
  }

  // ── Retiring a value, once the rows have moved ────────────────────────────
  {
    await sequelize.query("UPDATE commissions SET status = 'created' WHERE status = 'pending'");
    const dropped = await D.narrowEnum(sequelize, 'commissions', 'status',
      ['created', 'payment_requested', 'approved', 'paid', 'cancelled'],
      { defaultValue: 'created' });
    check(engine, 'narrowEnum retires the old value', dropped.includes('pending'), `dropped ${dropped.join(', ')}`);

    const after = await D.enumValues(sequelize, 'commissions', 'status');
    check(engine, '...and the value set is now the new vocabulary',
      JSON.stringify(after) === '["created","payment_requested","approved","paid","cancelled"]',
      after.join(', '));

    let refusedAfter = false;
    try { await sequelize.query("INSERT INTO commissions (status) VALUES ('pending')"); } catch { refusedAfter = true; }
    check(engine, "...so 'pending' is refused again, deliberately this time", refusedAfter);

    const [{ n }] = await sequelize.query(
      "SELECT COUNT(*) AS n FROM commissions WHERE status = 'created'", { type: QueryTypes.SELECT },
    );
    check(engine, 'The migrated rows survived the narrowing', Number(n) >= 1, `${n} row(s)`);
  }

  // ── Indexes ───────────────────────────────────────────────────────────────
  {
    check(engine, 'indexExists is false before the index is made',
      (await D.indexExists(sequelize, 'commissions', 'ux_test_ref')) === false,
      'information_schema.statistics does not exist in Postgres, so this used to throw');

    await D.addUniqueIndex(sequelize, 'commissions', ['company_id', 'reference'], 'ux_test_ref');
    check(engine, 'addUniqueIndex creates it', await D.indexExists(sequelize, 'commissions', 'ux_test_ref'));

    await sequelize.query("INSERT INTO commissions (company_id, reference) VALUES (1, 'R-1')");
    let dupError = null;
    try {
      await sequelize.query("INSERT INTO commissions (company_id, reference) VALUES (1, 'R-1')");
    } catch (error) { dupError = error; }
    check(engine, 'A duplicate is refused', Boolean(dupError));
    check(engine, 'isDuplicateError recognises it on this engine', D.isDuplicateError(dupError),
      `code=${dupError?.original?.code ?? dupError?.parent?.code} — MySQL says ER_DUP_ENTRY, Postgres says 23505`);

    await D.dropIndex(sequelize, 'commissions', 'ux_test_ref');
    check(engine, 'dropIndex removes it', (await D.indexExists(sequelize, 'commissions', 'ux_test_ref')) === false);
  }

  // ── Insert-and-get-id ─────────────────────────────────────────────────────
  {
    const id = await D.insertReturningId(
      sequelize,
      "INSERT INTO commissions (company_id, reference) VALUES (:company, :reference)",
      { replacements: { company: 9, reference: 'RET-1' } },
    );
    check(engine, 'insertReturningId returns the new row id', Number.isInteger(id) && id > 0, `id=${id}`);
    const rows = await sequelize.query('SELECT reference FROM commissions WHERE id = :id',
      { replacements: { id }, type: QueryTypes.SELECT });
    check(engine, '...and it is the id of the row just written', rows[0]?.reference === 'RET-1',
      'LAST_INSERT_ID() does not exist in Postgres — every payment path used it');
  }

  // ── The atomic counter behind document numbering ──────────────────────────
  {
    /**
     * The REAL allocator, not a copy of it.
     *
     * An earlier version of this check re-implemented the counter here and
     * passed on Postgres while producing duplicates and gaps on MySQL — because
     * LAST_INSERT_ID() is per-connection state and the copy did not pin the two
     * statements to one connection. documentSequence.js already gets that
     * right, so testing it directly is both the honest check and the reason not
     * to keep a second implementation around.
     */
    const { nextNumber } = require('../services/finance-service/src/utils/documentSequence');
    const claim = () => nextNumber(sequelize, {
      docType: 'invoices', table: 'commissions', field: 'reference', prefix: 'INV-', companyId: 1,
    });

    const first = await claim();
    check(engine, 'The first document number is INV-0001', first === 'INV-0001', `got ${first}`);
    const second = await claim();
    check(engine, 'The next is INV-0002', second === 'INV-0002', `got ${second}`);

    const burst = await Promise.all(Array.from({ length: 12 }, () => claim()));
    const unique = new Set(burst);
    check(engine, 'Twelve concurrent claims are all distinct', unique.size === 12,
      `${unique.size} distinct of 12 — ON DUPLICATE KEY and ON CONFLICT must both be atomic`);
    const numbers = [...unique].map((r) => Number(r.slice(4))).sort((a, b) => a - b);
    check(engine, '...and contiguous, with nothing skipped',
      numbers[numbers.length - 1] - numbers[0] === 11,
      `${numbers[0]}..${numbers[numbers.length - 1]}`);
  }
};

/**
 * The REAL migrations, against a database shaped the way production is.
 *
 * Everything above tests the helpers. This tests the two migrations that were
 * being skipped on Postgres, on a schema carrying the old vocabulary and the
 * old index layout — which is what copying the MySQL data across produced.
 */
const runMigrationChecks = async (sequelize, engine) => {
  const pg = D.isPostgres(sequelize);
  const drop = async (t) => sequelize.query(`DROP TABLE IF EXISTS ${t}`);
  await Promise.all(['commissions', 'transactions', 'invoices', 'credit_notes', 'debit_notes', 'invoice_payments', 'document_sequences'].map(drop));
  if (pg) {
    await sequelize.query('DROP TYPE IF EXISTS enum_commision_status');
    await sequelize.query('DROP TYPE IF EXISTS enum_transactions_entry_type');
  }

  // ── The legacy shape ──────────────────────────────────────────────────────
  if (pg) {
    // Deliberately the MISSPELLED type name from the production error, to prove
    // the type is looked up rather than constructed from table and column.
    await sequelize.query("CREATE TYPE enum_commision_status AS ENUM ('pending','approved','paid')");
    await sequelize.query('CREATE TABLE commissions (id SERIAL PRIMARY KEY, status enum_commision_status DEFAULT \'pending\', company_id INT)');
    await sequelize.query('CREATE TABLE transactions (id SERIAL PRIMARY KEY, type VARCHAR(64), reference VARCHAR(255), company_id INT)');
    await sequelize.query('CREATE TABLE invoices (id SERIAL PRIMARY KEY, invoice_id VARCHAR(64), company_id INT, CONSTRAINT invoice_id UNIQUE (invoice_id))');
    await sequelize.query('CREATE TABLE credit_notes (id SERIAL PRIMARY KEY, credit_note_id VARCHAR(64), company_id INT)');
    await sequelize.query('CREATE TABLE debit_notes (id SERIAL PRIMARY KEY, debit_note_id VARCHAR(64), company_id INT)');
    await sequelize.query('CREATE TABLE invoice_payments (id SERIAL PRIMARY KEY, transaction_id VARCHAR(255), company_id INT)');
  } else {
    await sequelize.query("CREATE TABLE commissions (id INT AUTO_INCREMENT PRIMARY KEY, status ENUM('pending','approved','paid') DEFAULT 'pending', company_id INT)");
    await sequelize.query('CREATE TABLE transactions (id INT AUTO_INCREMENT PRIMARY KEY, type VARCHAR(64), reference VARCHAR(255), company_id INT)');
    await sequelize.query('CREATE TABLE invoices (id INT AUTO_INCREMENT PRIMARY KEY, invoice_id VARCHAR(64), company_id INT, UNIQUE KEY invoice_id (invoice_id))');
    await sequelize.query('CREATE TABLE credit_notes (id INT AUTO_INCREMENT PRIMARY KEY, credit_note_id VARCHAR(64), company_id INT)');
    await sequelize.query('CREATE TABLE debit_notes (id INT AUTO_INCREMENT PRIMARY KEY, debit_note_id VARCHAR(64), company_id INT)');
    await sequelize.query('CREATE TABLE invoice_payments (id INT AUTO_INCREMENT PRIMARY KEY, transaction_id VARCHAR(255), company_id INT)');
  }

  await sequelize.query("INSERT INTO commissions (status, company_id) VALUES ('pending', 1), ('pending', 1), ('approved', 1)");
  await sequelize.query("INSERT INTO transactions (type, company_id) VALUES ('invoice_payment', 1), ('commission_payout', 1)");
  await sequelize.query("INSERT INTO invoice_payments (transaction_id, company_id) VALUES ('', 1), ('  ', 1)");

  // ── Run them, exactly as boot does ────────────────────────────────────────
  delete require.cache[require.resolve('../services/finance-service/src/migrations/migrateCommissionLifecycle')];
  delete require.cache[require.resolve('../services/finance-service/src/migrations/enforceReferenceUniqueness')];
  const commissionLifecycle = require('../services/finance-service/src/migrations/migrateCommissionLifecycle');
  const referenceUniqueness = require('../services/finance-service/src/migrations/enforceReferenceUniqueness');

  let threw = null;
  try { await commissionLifecycle(sequelize); } catch (error) { threw = error; }
  check(engine, 'migrateCommissionLifecycle runs', threw === null, threw?.message || '');

  const [{ n: stillPending }] = await sequelize.query(
    "SELECT COUNT(*) AS n FROM commissions WHERE status::text = 'pending'".replace('::text', pg ? '::text' : ''),
    { type: QueryTypes.SELECT },
  );
  check(engine, "...no commission is left on 'pending'", Number(stillPending) === 0, `${stillPending} left`);

  const [{ n: created }] = await sequelize.query(
    "SELECT COUNT(*) AS n FROM commissions WHERE status::text = 'created'".replace('::text', pg ? '::text' : ''),
    { type: QueryTypes.SELECT },
  );
  check(engine, "...both were moved to 'created'", Number(created) === 2, `${created} row(s)`);

  const nowAccepts = await D.enumValues(sequelize, 'commissions', 'status');
  check(engine, '...and the column accepts the new vocabulary',
    nowAccepts.includes('created') && nowAccepts.includes('payment_requested'),
    nowAccepts.join(', '));

  const txCols = await D.columnsOf(sequelize, 'transactions');
  check(engine, 'transactions.entry_type is added', Boolean(txCols?.has('entry_type')));
  if (txCols?.has('entry_type')) {
    const [{ n: debits }] = await sequelize.query(
      "SELECT COUNT(*) AS n FROM transactions WHERE entry_type::text = 'debit'".replace('::text', pg ? '::text' : ''),
      { type: QueryTypes.SELECT },
    );
    check(engine, '...and a commission payout is backfilled as a debit', Number(debits) === 1, `${debits}`);
  }

  let threw2 = null;
  try { await referenceUniqueness(sequelize); } catch (error) { threw2 = error; }
  check(engine, 'enforceReferenceUniqueness runs', threw2 === null, threw2?.message || '');

  for (const [table, name] of [
    ['invoices', 'ux_invoices_company_reference'],
    ['credit_notes', 'ux_credit_notes_company_reference'],
    ['debit_notes', 'ux_debit_notes_company_reference'],
    ['invoice_payments', 'ux_invoice_payments_company_reference'],
    ['transactions', 'ux_transactions_company_reference'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const present = await D.indexExists(sequelize, table, name);
    check(engine, `${table} gains its per-company unique index`, present,
      present ? '' : 'this is what was missing in production, so the guarantee did not exist there');
  }

  // The old GLOBAL index must actually be gone, or every company keeps drawing
  // from one sequence — on Postgres it is a CONSTRAINT, which DROP INDEX cannot
  // remove.
  check(engine, 'The old global unique index on invoices is really dropped',
    (await D.indexExists(sequelize, 'invoices', 'invoice_id')) === false,
    'left in place, company numbering keeps skipping');

  const [{ n: nulled }] = await sequelize.query(
    'SELECT COUNT(*) AS n FROM invoice_payments WHERE transaction_id IS NULL', { type: QueryTypes.SELECT },
  );
  check(engine, 'Blank payment references become NULL so they stop colliding',
    Number(nulled) === 2, `${nulled} of 2`);

  let rerun = null;
  try {
    await commissionLifecycle(sequelize);
    await referenceUniqueness(sequelize);
  } catch (error) { rerun = error; }
  check(engine, 'Both are idempotent, so every boot is safe', rerun === null, rerun?.message || '');

  // ── A client or realtor must belong to a company ──────────────────────────
  await sequelize.query('DROP TABLE IF EXISTS users');
  if (pg) {
    await sequelize.query('DROP TYPE IF EXISTS enum_users_type');
    await sequelize.query("CREATE TYPE enum_users_type AS ENUM ('client','realtor','admin','superior_admin')");
    await sequelize.query(`CREATE TABLE users (
      id SERIAL PRIMARY KEY, email VARCHAR(120), type enum_users_type,
      company_id INT NULL, deleted_at TIMESTAMP NULL)`);
  } else {
    await sequelize.query(`CREATE TABLE users (
      id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(120),
      type ENUM('client','realtor','admin','superior_admin'),
      company_id INT NULL, deleted_at DATETIME NULL)`);
  }

  delete require.cache[require.resolve('../services/user-service/src/migrations/requireCompanyForClients')];
  const requireCompany = require('../services/user-service/src/migrations/requireCompanyForClients');

  check(engine, 'CHECK constraints are enforced on this engine',
    await D.checksAreEnforced(sequelize),
    'MySQL below 8.0.16 parses them and ignores them, which is worse than refusing them');

  {
    // An offending row present: the constraint must be SKIPPED, not crash boot.
    await sequelize.query("INSERT INTO users (email, type, company_id) VALUES ('orphan@example.com', 'client', NULL)");
    let threw = null;
    try { await requireCompany(sequelize); } catch (error) { threw = error; }
    check(engine, 'An existing orphan does not crash the boot', threw === null, threw?.message || '');
    check(engine, '...and the constraint is NOT added, so nothing is auto-attached',
      (await D.constraintExists(sequelize, 'users', 'ck_users_company_required')) === false,
      'which company an orphan belongs to is a question only a person can answer');
    await sequelize.query("DELETE FROM users WHERE email = 'orphan@example.com'");
  }

  {
    let threw = null;
    try { await requireCompany(sequelize); } catch (error) { threw = error; }
    check(engine, 'With the data clean, the constraint is added', threw === null
      && await D.constraintExists(sequelize, 'users', 'ck_users_company_required'),
      threw?.message || '');
  }

  {
    let refused = false;
    try {
      await sequelize.query("INSERT INTO users (email, type, company_id) VALUES ('new@example.com', 'client', NULL)");
    } catch { refused = true; }
    check(engine, 'A client with no company is now REFUSED by the database', refused,
      'the invariant survives a direct INSERT, an import, or a restored backup');
  }
  {
    let refused = false;
    try {
      await sequelize.query("INSERT INTO users (email, type, company_id) VALUES ('r@example.com', 'realtor', NULL)");
    } catch { refused = true; }
    check(engine, '...and so is a realtor', refused);
  }
  {
    let allowed = true;
    try {
      await sequelize.query("INSERT INTO users (email, type, company_id) VALUES ('platform@example.com', 'superior_admin', NULL)");
    } catch { allowed = false; }
    check(engine, 'A platform admin may still have no company', allowed,
      'they operate across every company, which is why this is a CHECK and not NOT NULL');
  }
  {
    let allowed = true;
    try {
      await sequelize.query("INSERT INTO users (email, type, company_id) VALUES ('ok@example.com', 'client', 1)");
    } catch { allowed = false; }
    check(engine, 'A client WITH a company is accepted, as before', allowed);
  }
  {
    let rerunThrew = null;
    try { await requireCompany(sequelize); } catch (error) { rerunThrew = error; }
    check(engine, 'Re-running it is a no-op, so every boot is safe', rerunThrew === null,
      rerunThrew?.message || '');
  }
};

(async () => {
  // ── MySQL ─────────────────────────────────────────────────────────────────
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
  await admin.query(`CREATE DATABASE \`${MYSQL_DB}\``);
  const my = new Sequelize(MYSQL_DB, process.env.DB_USER, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306, dialect: 'mysql', logging: false,
  });
  await runChecks(my, 'mysql');
  await runMigrationChecks(my, 'mysql');
  await my.close();
  await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
  await admin.end();

  // ── Postgres ──────────────────────────────────────────────────────────────
  let pgReachable = true;
  try {
    const probe = new Client({ ...PG, connectionTimeoutMillis: 4000 });
    await probe.connect();
    await probe.end();
  } catch (error) {
    pgReachable = false;
    console.log(`\n\x1b[33m  Postgres not reachable at ${PG.host}:${PG.port} — ${error.message}\x1b[0m`);
    console.log('  Start one with:');
    console.log('    docker run -d --name realx8-pg -e POSTGRES_PASSWORD=postgres \\');
    console.log('      -e POSTGRES_DB=realx8test -p 5433:5432 postgres:16-alpine');
    console.log('  Skipping the Postgres half — NOT counting it as passing.\n');
  }

  if (pgReachable) {
    const pg = new Sequelize(PG.database, PG.user, PG.password, {
      host: PG.host, port: PG.port, dialect: 'postgres', logging: false,
    });
    await runChecks(pg, 'postgres');
    await runMigrationChecks(pg, 'postgres');
    await pg.close();
  }

  // ── Report, engine beside engine ──────────────────────────────────────────
  const labels = [...new Set(results.map((r) => r.label))];
  const width = Math.max(...labels.map((l) => l.length));
  console.log(`\n  ${' '.repeat(width)}   mysql   postgres`);
  console.log(`  ${'─'.repeat(width + 20)}`);
  let divergences = 0;
  labels.forEach((label) => {
    const my = results.find((r) => r.label === label && r.engine === 'mysql');
    const pg = results.find((r) => r.label === label && r.engine === 'postgres');
    const mark = (r) => (r ? (r.ok ? '\x1b[32m  ✓   \x1b[0m' : '\x1b[31m  ✗   \x1b[0m') : '\x1b[33m  –   \x1b[0m');
    if (my && pg && my.ok !== pg.ok) divergences += 1;
    console.log(`  ${label.padEnd(width)}  ${mark(my)}  ${mark(pg)}`);
    const detail = (pg && !pg.ok ? pg.detail : null) || (my && !my.ok ? my.detail : null);
    if (detail) console.log(`  ${' '.repeat(width)}     ${detail}`);
  });

  console.log(`\n  ${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass}/${pass + fail} checks passed\x1b[0m`
    + (pgReachable ? '' : ' \x1b[33m(postgres skipped)\x1b[0m'));
  if (divergences) {
    console.log(`  \x1b[31m${divergences} check(s) behave DIFFERENTLY on the two engines — that is the bug class this exists to catch.\x1b[0m`);
  } else if (pgReachable) {
    console.log('  \x1b[32mNo divergence between the engines.\x1b[0m');
  }
  console.log('');
  process.exit(fail === 0 && pgReachable ? 0 : 1);
})().catch((error) => {
  console.error('\n\x1b[31mThe verification itself failed:\x1b[0m', error);
  process.exit(1);
});

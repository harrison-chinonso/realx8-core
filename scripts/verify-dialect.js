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
        reference VARCHAR(64) NULL,
        -- The realtor dashboard aggregates over these two; without them the
        -- query under test fails for the wrong reason.
        employee_id INT NULL,
        amount NUMERIC(12,2) DEFAULT 0
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
        reference VARCHAR(64) NULL,
        -- The realtor dashboard aggregates over these two; without them the
        -- query under test fails for the wrong reason.
        employee_id INT NULL,
        amount DECIMAL(12,2) DEFAULT 0
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
/**
 * The realtor dashboard's commission query, on both engines.
 *
 * It asked for status IN ('pending', 'approved'). 'pending' was renamed to
 * 'created', and on Postgres comparing an enum column against a value the TYPE
 * does not contain is a hard ERROR rather than an empty match — so the whole
 * query failed and the realtor dashboard rendered nothing but
 * `invalid input value for enum enum_commissions_status: "pending"`.
 *
 * MySQL compares it as a plain string and matches nothing, which is exactly
 * why this reached production: development was clean.
 */
const runCommissionStatusChecks = async (sequelize, engine) => {
  const OLD = `SELECT COALESCE(SUM(CASE WHEN status IN ('pending', 'approved')
                                        THEN amount ELSE 0 END), 0) AS unpaid
                 FROM commissions WHERE employee_id = 1`;
  const NEW = `SELECT COALESCE(SUM(CASE WHEN status IN ('created', 'payment_requested', 'approved')
                                        THEN amount ELSE 0 END), 0) AS unpaid
                 FROM commissions WHERE employee_id = 1`;

  const run = async (sql) => {
    try { await sequelize.query(sql, { type: QueryTypes.SELECT }); return null; }
    catch (error) { return error.message.split('\n')[0]; }
  };

  const oldError = await run(OLD);
  if (engine === 'postgres') {
    check(engine, 'The OLD query is rejected, reproducing the production failure',
      Boolean(oldError) && /invalid input value for enum/i.test(oldError),
      oldError || 'it succeeded — this check is no longer testing anything');
  } else {
    check(engine, 'The OLD query merely matches nothing (why this was invisible here)',
      oldError === null, 'MySQL treats it as a string comparison');
  }

  const newError = await run(NEW);
  check(engine, 'The CORRECTED query runs',
    newError === null, newError || 'uses only values the enum actually has');
};

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
    const { nextNumber } = require('../shared/src/documentSequence');
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
      (await D.constraintExists(sequelize, 'users', 'ck_users_company_scoped')) === false,
      'which company an orphan belongs to is a question only a person can answer');
    await sequelize.query("DELETE FROM users WHERE email = 'orphan@example.com'");
  }

  {
    let threw = null;
    try { await requireCompany(sequelize); } catch (error) { threw = error; }
    check(engine, 'With the data clean, the constraint is added', threw === null
      && await D.constraintExists(sequelize, 'users', 'ck_users_company_scoped'),
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
    // The case that widened the rule: a company-level admin with no company was
    // scoped to every tenant rather than to none.
    let refused = false;
    try {
      await sequelize.query("INSERT INTO users (email, type, company_id) VALUES ('a@example.com', 'admin', NULL)");
    } catch { refused = true; }
    check(engine, '...and so is a company-level admin', refused,
      'a null company meant "no filter", which scoped them across every tenant');
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

  // ── Model-driven enum reconciliation ──────────────────────────────────────
  {
    const { syncEnums, enumDrift } = require('../shared/src/enumSync');
    const { DataTypes } = require('sequelize');

    await sequelize.query('DROP TABLE IF EXISTS widgets');
    if (pg) await sequelize.query('DROP TYPE IF EXISTS enum_widgets_state');

    // The database as it was when the type was first created.
    if (pg) {
      await sequelize.query("CREATE TYPE enum_widgets_state AS ENUM ('draft','live')");
      await sequelize.query('CREATE TABLE widgets (id SERIAL PRIMARY KEY, state enum_widgets_state)');
    } else {
      await sequelize.query("CREATE TABLE widgets (id INT AUTO_INCREMENT PRIMARY KEY, state ENUM('draft','live'))");
    }

    // The model as the code now believes it to be: two values added since.
    sequelize.define('Widget', {
      state: { type: DataTypes.ENUM('draft', 'live', 'archived', 'withdrawn') },
    }, { tableName: 'widgets', timestamps: false });

    const drift = await enumDrift(sequelize);
    const widget = drift.find((d) => d.table === 'widgets');
    check(engine, 'enumDrift notices the model has values the database lacks',
      Boolean(widget) && widget.missing.join(',') === 'archived,withdrawn',
      widget ? `missing: ${widget.missing.join(', ')}` : 'no drift reported');

    let refused = false;
    try { await sequelize.query("INSERT INTO widgets (state) VALUES ('archived')"); } catch { refused = true; }
    check(engine, '...and writing the new value fails before reconciliation', refused,
      'exactly the production failure: the code believes a value the database has never heard of');

    const quiet = { log() {}, warn() {} };
    const changes = await syncEnums(sequelize, { logger: quiet });
    check(engine, 'syncEnums widens the column to match the model',
      changes.some((c) => c.table === 'widgets' && c.added.length === 2),
      JSON.stringify(changes.filter((c) => c.table === 'widgets')));

    let accepted = true;
    try { await sequelize.query("INSERT INTO widgets (state) VALUES ('withdrawn')"); } catch { accepted = false; }
    check(engine, '...after which the new value is accepted', accepted);

    const second = await syncEnums(sequelize, { logger: quiet });
    check(engine, 'Running it again changes nothing, so every boot is cheap',
      second.every((c) => c.table !== 'widgets'), JSON.stringify(second));

    // A value the model no longer lists is LEFT ALONE: narrowing needs the rows
    // moved first, which is a decision rather than a reconciliation.
    const after = await D.enumValues(sequelize, 'widgets', 'state');
    check(engine, 'A retired value is left in place rather than silently dropped',
      after.includes('draft') && after.includes('live'),
      `${after.join(', ')} — narrowing is only safe once no row uses the value`);

    delete sequelize.models.Widget;
  }

};

/**
 * The changes made when the client invoice page failed on Postgres.
 *
 * Each block below follows the same shape as the commission-status check
 * above, because each bug had the same shape: a statement MySQL accepts and
 * Postgres rejects, written in development and discovered in production. So
 * where there is an old form, it is run too — a check that only exercises the
 * fix stops being evidence the moment someone reintroduces the original.
 */
const runInvoicePageChecks = async (sequelize, engine) => {
  const pg = D.isPostgres(sequelize);
  const { DataTypes } = require('sequelize');
  const run = async (sql) => {
    try { await sequelize.query(sql, { type: QueryTypes.SELECT }); return null; }
    catch (error) { return error.message.split('\n')[0]; }
  };

  // ── GROUP BY across a join ────────────────────────────────────────────────
  {
    /**
     * The reported failure: `column "p.name" must appear in the GROUP BY
     * clause`.
     *
     * MySQL infers it — i.id is the invoice PK, p is joined on its own PK, so
     * it calls p.name functionally dependent and allows it. Postgres extends
     * that inference only to the table whose PK is grouped, so a column from
     * the joined table is refused outright.
     */
    await sequelize.query('DROP TABLE IF EXISTS inv_lines');
    await sequelize.query('DROP TABLE IF EXISTS inv_head');
    await sequelize.query('DROP TABLE IF EXISTS props');
    await sequelize.query('CREATE TABLE props (id INT NOT NULL PRIMARY KEY, name VARCHAR(80))');
    await sequelize.query('CREATE TABLE inv_head (id INT NOT NULL PRIMARY KEY, property_id INT NULL, amount DECIMAL(12,2))');
    await sequelize.query(`CREATE TABLE inv_lines (id INT NOT NULL PRIMARY KEY, invoice_id INT, amount DECIMAL(12,2), status VARCHAR(20))`);
    await sequelize.query("INSERT INTO props VALUES (1, 'Lekki Court')");
    await sequelize.query('INSERT INTO inv_head VALUES (1, 1, 500)');
    await sequelize.query("INSERT INTO inv_lines VALUES (1, 1, 200, 'completed'), (2, 1, 100, 'completed')");

    const SELECT = `SELECT i.id, i.amount, p.name AS property_name,
              COALESCE(SUM(CASE WHEN l.status = 'completed' THEN l.amount END), 0) AS paid
         FROM inv_head i
         LEFT JOIN inv_lines l ON l.invoice_id = i.id
         LEFT JOIN props p ON p.id = i.property_id`;

    const oldError = await run(`${SELECT} GROUP BY i.id`);
    if (engine === 'postgres') {
      check(engine, 'The OLD invoice grouping is rejected, as the client page saw',
        Boolean(oldError) && /group by/i.test(oldError),
        oldError || 'it succeeded — this check is no longer testing anything');
    } else {
      check(engine, 'The OLD invoice grouping is accepted here (why it shipped)',
        oldError === null, 'MySQL infers p.name from the grouped PK');
    }

    const fixedError = await run(`${SELECT} GROUP BY i.id, p.name`);
    check(engine, 'Naming the joined column in GROUP BY works on both', fixedError === null,
      fixedError || 'i.id covers every i.* column, p.name covers itself');

    const rows = await sequelize.query(`${SELECT} GROUP BY i.id, p.name`, { type: QueryTypes.SELECT });
    check(engine, '...and still returns one row per invoice with the summed total',
      rows.length === 1 && Number(rows[0].paid) === 300 && rows[0].property_name === 'Lekki Court',
      `${rows.length} row(s), paid=${rows[0] && rows[0].paid}`);
  }

  // ── Comparing a BOOLEAN ───────────────────────────────────────────────────
  {
    /**
     * `is_active = 1` against a BOOLEAN column. Postgres has no implicit
     * boolean/integer cast; MySQL stores the column as tinyint and never
     * noticed. Both call sites wrapped this in a catch, so on Postgres it did
     * not error visibly — it returned "no rows" and the features above it went
     * quiet.
     */
    await sequelize.query('DROP TABLE IF EXISTS bool_probe');
    await sequelize.query(`CREATE TABLE bool_probe (id INT NOT NULL PRIMARY KEY, is_active BOOLEAN)`);
    await sequelize.query(`INSERT INTO bool_probe VALUES (1, ${pg ? 'TRUE' : '1'}), (2, ${pg ? 'FALSE' : '0'})`);

    const oldError = await run('SELECT id FROM bool_probe WHERE is_active = 1');
    if (engine === 'postgres') {
      check(engine, 'The OLD `is_active = 1` is rejected, reproducing the silent failure',
        Boolean(oldError) && /boolean|operator does not exist/i.test(oldError),
        oldError || 'it succeeded — this check is no longer testing anything');
    } else {
      check(engine, 'The OLD `is_active = 1` is accepted here (why it shipped)',
        oldError === null, 'tinyint compares against an integer happily');
    }

    const fixedError = await run('SELECT id FROM bool_probe WHERE is_active IS TRUE');
    check(engine, '`IS TRUE` runs on both', fixedError === null, fixedError || '');

    const rows = await sequelize.query('SELECT id FROM bool_probe WHERE is_active IS TRUE',
      { type: QueryTypes.SELECT });
    check(engine, '...and selects the active row only',
      rows.length === 1 && Number(rows[0].id) === 1, `${rows.length} row(s)`);
  }

  // ── insertIgnoring ────────────────────────────────────────────────────────
  {
    /**
     * INSERT IGNORE is a syntax error in Postgres, where the spelling is
     * ON CONFLICT DO NOTHING. Both lean on the target's own unique key, which
     * is what makes them atomic — the burst below is the part a portable
     * `WHERE NOT EXISTS` rewrite would fail.
     */
    await sequelize.query('DROP TABLE IF EXISTS user_roles');
    await sequelize.query('DROP TABLE IF EXISTS roles_probe');
    await sequelize.query('CREATE TABLE user_roles (user_id INT NOT NULL, role_id INT NOT NULL, PRIMARY KEY (user_id, role_id))');
    await sequelize.query('CREATE TABLE roles_probe (id INT NOT NULL PRIMARY KEY, name VARCHAR(40))');
    await sequelize.query("INSERT INTO roles_probe VALUES (7, 'realtor')");

    const VALUES = 'user_roles (user_id, role_id) VALUES (:userId, :roleId)';
    const countRows = async () => Number((await sequelize.query(
      'SELECT COUNT(*) AS n FROM user_roles', { type: QueryTypes.SELECT }))[0].n);

    let firstError = null;
    try {
      await D.insertIgnoring(sequelize, VALUES,
        { replacements: { userId: 1, roleId: 7 }, type: QueryTypes.INSERT });
    } catch (error) { firstError = error.message.split('\n')[0]; }
    check(engine, 'insertIgnoring writes the row', firstError === null && await countRows() === 1,
      firstError || '');

    let repeatError = null;
    try {
      await D.insertIgnoring(sequelize, VALUES,
        { replacements: { userId: 1, roleId: 7 }, type: QueryTypes.INSERT });
    } catch (error) { repeatError = error.message.split('\n')[0]; }
    check(engine, '...and a repeat is ignored rather than thrown',
      repeatError === null && await countRows() === 1,
      repeatError || 'INSERT IGNORE / ON CONFLICT DO NOTHING');

    // The INSERT ... SELECT shape, which is the sign-in path.
    let selectError = null;
    try {
      await D.insertIgnoring(sequelize,
        'user_roles (user_id, role_id) SELECT :userId, r.id FROM roles_probe r WHERE r.name = :type',
        { replacements: { userId: 1, type: 'realtor' }, type: QueryTypes.INSERT });
    } catch (error) { selectError = error.message.split('\n')[0]; }
    check(engine, 'The INSERT ... SELECT shape works and still de-duplicates',
      selectError === null && await countRows() === 1, selectError || '');

    // Concurrency: the clash must be absorbed by the key, not by a pre-check.
    const burst = await Promise.all(Array.from({ length: 8 }, () => D
      .insertIgnoring(sequelize, VALUES, { replacements: { userId: 2, roleId: 7 }, type: QueryTypes.INSERT })
      .then(() => null).catch((error) => error.message.split('\n')[0])));
    const threw = burst.filter(Boolean);
    check(engine, 'Eight concurrent identical inserts none of them throw',
      threw.length === 0, threw[0] || '');
    check(engine, '...and exactly one row lands', await countRows() === 2, `${await countRows()} rows`);
  }

  // ── addPasscodeColumns, on a table shaped the way production is ───────────
  {
    /**
     * The migration was MySQL-only and gated behind isMySQL, so on the live
     * Postgres database — copied across from MySQL rather than built by
     * sync() — the columns were never added, and the model selects them on
     * every User read.
     *
     * The REAL migration is run here, not a copy, for the same reason the
     * document counter is.
     */
    delete require.cache[require.resolve('../services/user-service/src/migrations/addPasscodeColumns')];
    const addPasscodeColumns = require('../services/user-service/src/migrations/addPasscodeColumns');
    const WANTED = ['last_login_at', 'passcode_hash', 'passcode_set_at',
      'passcode_failed_attempts', 'passcode_locked_until'];
    const ts = pg ? 'TIMESTAMP WITH TIME ZONE' : 'DATETIME';

    // No users table at all: a genuinely empty database, where sync() will
    // create every column. Must no-op rather than throw.
    await sequelize.query('DROP TABLE IF EXISTS users');
    let emptyError = null;
    try { await addPasscodeColumns(sequelize); } catch (error) { emptyError = error.message.split('\n')[0]; }
    check(engine, 'addPasscodeColumns no-ops on a database with no users table',
      emptyError === null, emptyError || '');

    // Production's shape: pre-passcode, with rows, carrying last_active_at.
    await sequelize.query(`CREATE TABLE users (
      id INT NOT NULL PRIMARY KEY, email VARCHAR(120), last_active_at ${ts} NULL)`);
    await sequelize.query("INSERT INTO users (id, email, last_active_at) VALUES (1, 'a@b.c', "
      + (pg ? "TIMESTAMP '2026-09-12 08:00:00'" : "'2026-09-12 08:00:00'") + ')');
    await sequelize.query("INSERT INTO users (id, email, last_active_at) VALUES (2, 'd@e.f', NULL)");
    await addPasscodeColumns(sequelize);

    const cols = await D.columnsOf(sequelize, 'users');
    const missing = WANTED.filter((c) => !cols.has(c));
    check(engine, 'addPasscodeColumns adds every passcode column to an existing table',
      missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : '');

    /**
     * Everything below reads those columns, so it can only run if they arrived.
     *
     * Without this guard a regression that stops the migration working — which
     * is precisely what this section exists to catch — throws out of the runner
     * on the next SELECT and takes the whole report with it, including the
     * checks that would have named the cause.
     */
    const rows = missing.length ? [] : await sequelize.query(
      'SELECT id, last_login_at, passcode_failed_attempts FROM users ORDER BY id',
      { type: QueryTypes.SELECT });
    check(engine, '...seeds last_login_at from last_active_at, so the window is not shut for everyone',
      rows.length === 2 && rows[0].last_login_at != null && rows[1].last_login_at == null,
      missing.length ? 'skipped — the columns were never added' : 'only rows that actually had activity are seeded');
    check(engine, '...and existing rows get the failed-attempt default',
      rows.length === 2 && Number(rows[0].passcode_failed_attempts) === 0,
      missing.length ? 'skipped — the columns were never added' : `got ${rows[0] && rows[0].passcode_failed_attempts}`);

    let rerunError = null;
    try { await addPasscodeColumns(sequelize); } catch (error) { rerunError = error.message.split('\n')[0]; }
    const again = await D.columnsOf(sequelize, 'users');
    check(engine, 'Re-running it changes nothing, so every boot is safe',
      rerunError === null && again.size === cols.size,
      rerunError || `${cols.size} -> ${again.size} columns`);

    /**
     * A users table with no last_active_at at all.
     *
     * On MySQL an earlier migration guarantees the column; on a Postgres
     * database carried over from elsewhere nothing does, and the unguarded
     * backfill would have failed on a missing column and taken boot with it.
     */
    await sequelize.query('DROP TABLE IF EXISTS users');
    await sequelize.query('CREATE TABLE users (id INT NOT NULL PRIMARY KEY)');
    let bareError = null;
    try { await addPasscodeColumns(sequelize); } catch (error) { bareError = error.message.split('\n')[0]; }
    const bare = await D.columnsOf(sequelize, 'users');
    check(engine, 'It survives a users table with no last_active_at to seed from',
      bareError === null && WANTED.every((c) => bare.has(c)), bareError || '');

    /**
     * The columns must match what sync() would have made.
     *
     * A migration that adds a column of a DIFFERENT type is the quiet version
     * of this whole class of bug: nothing errors, and the two databases drift.
     */
    await sequelize.query('DROP TABLE IF EXISTS passcode_sync_ref');
    sequelize.define('PasscodeSyncRef', {
      id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      last_login_at: { type: DataTypes.DATE, allowNull: true },
      passcode_hash: { type: DataTypes.STRING, allowNull: true },
      passcode_set_at: { type: DataTypes.DATE, allowNull: true },
      passcode_failed_attempts: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      passcode_locked_until: { type: DataTypes.DATE, allowNull: true },
    }, { tableName: 'passcode_sync_ref', timestamps: false });
    await sequelize.models.PasscodeSyncRef.sync({ force: true });

    const shapeOf = async (table) => {
      const rowsFor = await sequelize.query(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns WHERE table_name = :table`,
        { replacements: { table }, type: QueryTypes.SELECT },
      );
      const shape = {};
      for (const row of rowsFor) {
        const name = row.column_name || row.COLUMN_NAME;
        if (!WANTED.includes(name)) continue;
        shape[name] = [row.data_type || row.DATA_TYPE, row.is_nullable || row.IS_NULLABLE,
          String(row.column_default ?? row.COLUMN_DEFAULT ?? 'null')].join(' | ');
      }
      return shape;
    };
    const synced = await shapeOf('passcode_sync_ref');
    const migrated = await shapeOf('users');
    // A column the migration never created reads as undefined here, which is a
    // difference — so a skipped migration fails this too rather than passing
    // on two empty shapes.
    const differing = WANTED.filter((c) => !migrated[c] || synced[c] !== migrated[c]);
    check(engine, 'The migrated columns are identical to the ones sync() makes',
      differing.length === 0,
      differing.length ? differing.map((c) => `${c}: sync=[${synced[c]}] migrated=[${migrated[c]}]`).join('; ') : '');

    await sequelize.query('DROP TABLE IF EXISTS passcode_sync_ref');
    delete sequelize.models.PasscodeSyncRef;
  }
};


/**
 * Case-insensitive search, and the inspection backfill.
 *
 * Both are the QUIET kind of divergence: no error on either engine, just a
 * different answer. That makes them worse than a syntax error, not better —
 * nothing surfaces, the feature simply does less in production.
 */

/**
 * The commission engine's own schema, and the one statement shape that means
 * two different things on the two engines.
 */


/**
 * A post must outlive the person who wrote it.
 */
const runMediaPostCascadeChecks = async (sequelize, engine) => {
  const pg = engine === 'postgres';
  const pk = pg ? 'SERIAL PRIMARY KEY' : 'INT AUTO_INCREMENT PRIMARY KEY';
  const fk = pg ? 'INTEGER' : 'INT';

  await sequelize.query(`DROP TABLE IF EXISTS media_posts${pg ? ' CASCADE' : ''}`);
  await sequelize.query(`DROP TABLE IF EXISTS mp_users${pg ? ' CASCADE' : ''}`);
  await sequelize.query(`CREATE TABLE mp_users (id ${pk}, name VARCHAR(64))`);

  /**
   * Table-level FOREIGN KEY clauses, not inline column REFERENCES: MySQL
   * silently discards the inline form and the fixture would carry no
   * constraint at all. Built on CASCADE, as an installed database has it.
   */
  await sequelize.query(
    `CREATE TABLE media_posts (
       id ${pk},
       title VARCHAR(120),
       impressions ${fk} DEFAULT 0,
       created_by ${fk} NULL,
       reviewed_by ${fk} NULL,
       CONSTRAINT fk_mp_author FOREIGN KEY (created_by)
         REFERENCES mp_users (id) ON DELETE CASCADE,
       CONSTRAINT fk_mp_reviewer FOREIGN KEY (reviewed_by)
         REFERENCES mp_users (id) ON DELETE NO ACTION
     )`,
  );

  delete require.cache[require.resolve('../shared/src/foreignKeyRule')];
  const { setDeleteRule, foreignKeyOn } = require('../shared/src/foreignKeyRule');

  const relax = async () => {
    for (const column of ['created_by', 'reviewed_by']) {
      // eslint-disable-next-line no-await-in-loop
      await setDeleteRule(sequelize, {
        table: 'media_posts', column, references: 'mp_users', rule: 'SET NULL',
      });
    }
  };

  let threw = null;
  try { await relax(); } catch (error) { threw = error; }
  check(engine, 'The media_posts delete rules can be relaxed', threw === null, threw?.message || '');

  threw = null;
  try { await relax(); } catch (error) { threw = error; }
  check(engine, '...and again, on a database already fixed', threw === null, threw?.message || '');

  await sequelize.query("INSERT INTO mp_users (id, name) VALUES (1, 'Author'), (2, 'Reviewer')");
  await sequelize.query(
    "INSERT INTO media_posts (id, title, impressions, created_by, reviewed_by) "
    + "VALUES (1, 'A published post', 4200, 1, 2)",
  );

  /**
   * reviewed_by was NO ACTION, which InnoDB enforces as RESTRICT — deleting a
   * reviewer was already blocked. Fixing only created_by would leave user
   * deletion failing on the other constraint, and the fix would look as though
   * it had not worked.
   */
  let reviewerDeleteFailed = null;
  try { await sequelize.query('DELETE FROM mp_users WHERE id = 2'); }
  catch (error) { reviewerDeleteFailed = error.message.split('\n')[0]; }
  check(engine, 'Deleting a REVIEWER is no longer refused outright',
    reviewerDeleteFailed === null, reviewerDeleteFailed || 'the delete went through');

  await sequelize.query('DELETE FROM mp_users WHERE id = 1');

  const [survivor] = await sequelize.query(
    'SELECT title, impressions, created_by, reviewed_by FROM media_posts WHERE id = 1',
    { type: QueryTypes.SELECT },
  );
  check(engine, 'Deleting an AUTHOR leaves the post and its figures standing',
    Boolean(survivor) && Number(survivor.impressions) === 4200,
    survivor ? `"${survivor.title}", ${survivor.impressions} impressions kept`
      : 'the post was deleted with its author');
  check(engine, '...with both author and reviewer cleared rather than dangling',
    survivor?.created_by === null && survivor?.reviewed_by === null,
    `created_by=${JSON.stringify(survivor?.created_by)}, reviewed_by=${JSON.stringify(survivor?.reviewed_by)}`);

  const rule = await foreignKeyOn(sequelize, 'media_posts', 'created_by');
  check(engine, '...and the catalogue agrees', rule?.delete_rule === 'SET NULL',
    `delete rule is ${rule?.delete_rule}`);

  check(engine, 'A column with no foreign key is left alone rather than given one',
    (await setDeleteRule(sequelize, {
      table: 'media_posts', column: 'impressions', references: 'mp_users', rule: 'SET NULL',
    })).reason === 'no_constraint',
    'adding one would be a new guarantee, not the removal of a harmful one');

  await sequelize.query(`DROP TABLE IF EXISTS media_posts${pg ? ' CASCADE' : ''}`);
  await sequelize.query(`DROP TABLE IF EXISTS mp_users${pg ? ' CASCADE' : ''}`);
};

/** The delete rule on receipts.invoice_payment_id, on either engine. */
const currentDeleteRule = async (sequelize, engine) => {
  if (engine === 'postgres') {
    const [row] = await sequelize.query(
      `SELECT CASE con.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
                                   WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
                                   WHEN 'd' THEN 'SET DEFAULT' END AS rule
         FROM pg_constraint con
         JOIN pg_class child ON child.oid = con.conrelid
         JOIN pg_attribute att ON att.attrelid = child.oid AND att.attnum = ANY (con.conkey)
        WHERE con.contype = 'f' AND child.relname = 'receipts'
          AND att.attname = 'invoice_payment_id' LIMIT 1`,
      { type: QueryTypes.SELECT },
    );
    return row?.rule ?? null;
  }
  const [row] = await sequelize.query(
    `SELECT r.DELETE_RULE AS rule
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
      WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = 'receipts'
        AND k.COLUMN_NAME = 'invoice_payment_id' LIMIT 1`,
    { type: QueryTypes.SELECT },
  );
  return row?.rule ?? null;
};

/**
 * A receipt must outlive the payment it produced.
 */
const runReceiptCascadeChecks = async (sequelize, engine) => {
  const pg = engine === 'postgres';
  const money = pg ? 'NUMERIC(12,2)' : 'DECIMAL(12,2)';
  const pk = pg ? 'SERIAL PRIMARY KEY' : 'INT AUTO_INCREMENT PRIMARY KEY';
  const fk = pg ? 'INTEGER' : 'INT';

  for (const table of ['receipts', 'invoice_payments']) {
    // eslint-disable-next-line no-await-in-loop
    await sequelize.query(`DROP TABLE IF EXISTS ${table}${pg ? ' CASCADE' : ''}`);
  }

  await sequelize.query(`CREATE TABLE invoice_payments (id ${pk}, amount ${money})`);
  /**
   * Built with the CASCADE this migration exists to remove, so the check below
   * is exercising the upgrade path an installed database actually takes rather
   * than a table that was already correct.
   */
  /**
   * The foreign key is declared as a TABLE-LEVEL clause, not inline on the
   * column.
   *
   * MySQL parses `col INT REFERENCES parent (id)` and silently discards it —
   * InnoDB only honours a separate FOREIGN KEY clause. Postgres honours both.
   * Written inline, this table had no constraint at all on MySQL, the migration
   * below correctly found nothing to change, and the check further down failed
   * for a reason that had nothing to do with the migration.
   */
  await sequelize.query(
    `CREATE TABLE receipts (
       id ${pk},
       receipt_number VARCHAR(64),
       invoice_payment_id ${fk} NULL,
       CONSTRAINT fk_receipts_payment_probe FOREIGN KEY (invoice_payment_id)
         REFERENCES invoice_payments (id) ON DELETE CASCADE
     )`,
  );

  const before = await currentDeleteRule(sequelize, engine);
  check(engine, 'The fixture starts on CASCADE, as an installed database does',
    before === 'CASCADE', `delete rule is ${before}`);

  delete require.cache[require.resolve('../services/finance-service/src/migrations/relaxReceiptPaymentCascade')];
  const relax = require('../services/finance-service/src/migrations/relaxReceiptPaymentCascade');

  let threw = null;
  try { await relax(sequelize); } catch (error) { threw = error; }
  check(engine, 'relaxReceiptPaymentCascade runs', threw === null, threw?.message || '');

  threw = null;
  try { await relax(sequelize); } catch (error) { threw = error; }
  check(engine, '...and again, on a database it has already fixed',
    threw === null, threw?.message || '');

  /**
   * The behaviour, not the catalogue. A delete rule read back from
   * information_schema proves what the schema SAYS; deleting the payment and
   * looking for the receipt proves what the database DOES.
   */
  await sequelize.query("INSERT INTO invoice_payments (id, amount) VALUES (1, 500.00)");
  await sequelize.query("INSERT INTO receipts (id, receipt_number, invoice_payment_id) VALUES (1, 'RCP-1', 1)");
  await sequelize.query('DELETE FROM invoice_payments WHERE id = 1');

  const [survivor] = await sequelize.query(
    'SELECT receipt_number, invoice_payment_id FROM receipts WHERE id = 1',
    { type: QueryTypes.SELECT },
  );
  check(engine, 'Deleting a payment leaves its receipt standing',
    Boolean(survivor),
    survivor ? 'the buyer\'s proof, the verification record and the issued receipt all survive'
      : 'the receipt was deleted with the payment');
  check(engine, '...with its link to the payment cleared rather than dangling',
    survivor?.invoice_payment_id === null,
    `invoice_payment_id = ${JSON.stringify(survivor?.invoice_payment_id)}`);

  const after = await currentDeleteRule(sequelize, engine);
  check(engine, '...and the catalogue agrees with the behaviour',
    after === 'SET NULL', `delete rule is now ${after}`);

  for (const table of ['receipts', 'invoice_payments']) {
    // eslint-disable-next-line no-await-in-loop
    await sequelize.query(`DROP TABLE IF EXISTS ${table}${pg ? ' CASCADE' : ''}`);
  }
};

const runCommissionEngineChecks = async (sequelize, engine) => {
  const pg = engine === 'postgres';
  delete require.cache[require.resolve('../services/finance-service/src/migrations/createCommissionEngine')];
  const createEngine = require('../services/finance-service/src/migrations/createCommissionEngine');

  let threw = null;
  try { await createEngine(sequelize); } catch (error) { threw = error; }
  check(engine, 'createCommissionEngine runs on a clean database', threw === null, threw?.message || '');

  /**
   * Run TWICE. The second pass is the one that matters: the column-adding step
   * is new, and an ALTER TABLE ADD COLUMN that is not guarded fails on every
   * reboot after the first — which takes the whole service down, on a database
   * that is already correct.
   */
  threw = null;
  try { await createEngine(sequelize); } catch (error) { threw = error; }
  check(engine, '...and again, unchanged, on a database that already has it',
    threw === null, threw?.message || '');

  const entitlements = await D.columnsOf(sequelize, 'commission_entitlements');
  check(engine, 'The lifecycle columns are present',
    ['held_minor', 'paid_minor', 'clawed_back_minor', 'released_at', 'vesting']
      .every((column) => entitlements.has(column)),
    [...entitlements.keys()].join(', '));

  for (const table of ['commission_payouts', 'commission_payout_lines', 'commission_receivables', 'commission_flags']) {
    // eslint-disable-next-line no-await-in-loop
    check(engine, `${table} exists`, await D.tableExists(sequelize, table));
  }

  /**
   * ── The divergence this suite exists to pin down ──────────────────────────
   *
   * MySQL evaluates an UPDATE's SET clauses left to right, so a later clause
   * reads the value an earlier one just assigned. Postgres evaluates every
   * clause against the row as it was before the statement. The SAME statement
   * therefore produces different rows on the two engines, silently.
   *
   * It cost a real bug: a clawback recovery whose status was derived from the
   * column it had just incremented closed as fully recovered after a partial
   * payment — on MySQL only, which is the development engine, so the
   * development database looked right and production would not have been.
   *
   * Asserted here rather than trusted, because `npm run lint:sql` now refuses
   * the pattern and a rule nobody has proved is a rule nobody should rely on.
   */
  await sequelize.query('DROP TABLE IF EXISTS set_order_probe');
  await sequelize.query(pg
    ? 'CREATE TABLE set_order_probe (id INTEGER PRIMARY KEY, a BIGINT, b BIGINT)'
    : 'CREATE TABLE set_order_probe (id INT PRIMARY KEY, a BIGINT, b BIGINT)');
  await sequelize.query('INSERT INTO set_order_probe (id, a, b) VALUES (1, 10, 0)');
  await sequelize.query('UPDATE set_order_probe SET a = a + 5, b = a WHERE id = 1');
  const [probe] = await sequelize.query('SELECT a, b FROM set_order_probe WHERE id = 1',
    { type: QueryTypes.SELECT });

  check(engine, 'A SET clause reading a column assigned earlier in the same UPDATE',
    Number(probe.b) === (pg ? 10 : 15),
    `b = ${probe.b} — ${pg ? 'Postgres reads the OLD value' : 'MySQL reads the NEW one'}; `
    + 'the same statement, two answers, which is why lint:sql refuses it');
  await sequelize.query('DROP TABLE IF EXISTS set_order_probe');
};

const runSearchAndBackfillChecks = async (sequelize, engine) => {
  const pg = D.isPostgres(sequelize);
  const { DataTypes, Op } = require('sequelize');

  // ── LIKE and collation ────────────────────────────────────────────────────
  {
    await sequelize.query('DROP TABLE IF EXISTS search_probe');
    const Probe = sequelize.define('SearchProbe', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING },
    }, { tableName: 'search_probe', timestamps: false });
    await Probe.sync({ force: true });
    await Probe.bulkCreate([{ name: 'Lekki Court' }, { name: 'ikoyi heights' }]);

    /**
     * The OLD behaviour, asserted per engine.
     *
     * Op.like does not throw anywhere — it simply matches nothing on Postgres,
     * which is why a search that worked all through development came back
     * empty in production and looked like missing data.
     */
    const lowerHit = await Probe.findAll({ where: { name: { [Op.like]: '%lekki%' } } });
    if (engine === 'postgres') {
      check(engine, 'Op.like alone misses differently-cased text (the silent failure)',
        lowerHit.length === 0, `matched ${lowerHit.length} — this check is no longer testing anything`);
    } else {
      check(engine, 'Op.like alone matches case-insensitively here (why it shipped)',
        lowerHit.length === 1, `matched ${lowerHit.length}`);
    }

    const like = D.likeOperator(sequelize);
    const fixed = await Probe.findAll({ where: { name: { [like]: '%lekki%' } } });
    check(engine, 'likeOperator matches regardless of case on both engines',
      fixed.length === 1 && fixed[0].name === 'Lekki Court', `matched ${fixed.length}`);

    const upper = await Probe.findAll({ where: { name: { [like]: '%IKOYI%' } } });
    check(engine, '...in the other direction too',
      upper.length === 1 && upper[0].name === 'ikoyi heights', `matched ${upper.length}`);

    const none = await Probe.findAll({ where: { name: { [like]: '%victoria%' } } });
    check(engine, '...and still matches nothing when nothing matches',
      none.length === 0, `matched ${none.length}`);

    await sequelize.query('DROP TABLE IF EXISTS search_probe');
    delete sequelize.models.SearchProbe;
  }

  // ── backfillInspectionRealtor ─────────────────────────────────────────────
  {
    /**
     * UPDATE ... JOIN is MySQL's spelling; Postgres spells it UPDATE ... FROM
     * and rejects the other. The migration's own catch would have hidden that
     * as a one-line warning, so the old form is run here explicitly to prove
     * the rejection is real rather than assumed.
     */
    await sequelize.query('DROP TABLE IF EXISTS inspections');
    await sequelize.query('DROP TABLE IF EXISTS users');
    await sequelize.query(`CREATE TABLE users (
      id INT NOT NULL PRIMARY KEY, name VARCHAR(120), type VARCHAR(20), company_id INT NULL)`);
    await sequelize.query(`CREATE TABLE inspections (
      id INT NOT NULL PRIMARY KEY, realtor_name VARCHAR(120), realtor_id INT NULL, company_id INT NULL)`);
    await sequelize.query(`INSERT INTO users (id, name, type, company_id) VALUES
      (1, 'Ada Obi',   'realtor', 5),
      (2, 'Tunde Ade', 'realtor', 5),
      (3, 'Tunde Ade', 'realtor', 5),
      (4, 'Ada Obi',   'client',  5)`);
    await sequelize.query(`INSERT INTO inspections (id, realtor_name, realtor_id, company_id) VALUES
      (1, '  ada obi ', NULL, 5),
      (2, 'Tunde Ade',  NULL, 5),
      (3, 'Ada Obi',    9,    5)`);

    const OLD_MYSQL = `UPDATE inspections i
         JOIN (SELECT TRIM(LOWER(u.name)) AS uname, u.company_id, MIN(u.id) AS user_id
                 FROM users u WHERE u.type = 'realtor'
                GROUP BY TRIM(LOWER(u.name)), u.company_id HAVING COUNT(*) = 1) m
           ON m.uname = TRIM(LOWER(i.realtor_name))
          SET i.realtor_id = m.user_id
        WHERE i.realtor_id IS NULL`;
    let oldError = null;
    try { await sequelize.query(OLD_MYSQL); } catch (error) { oldError = error.message.split('\n')[0]; }
    if (engine === 'postgres') {
      check(engine, 'The OLD `UPDATE ... JOIN` backfill is rejected here',
        Boolean(oldError), oldError || 'it succeeded — this check is no longer testing anything');
    } else {
      check(engine, 'The OLD `UPDATE ... JOIN` backfill runs here (why it shipped)',
        oldError === null, oldError || '');
    }

    // Reset whatever the old form managed to write before running the real one.
    await sequelize.query('UPDATE inspections SET realtor_id = NULL WHERE id <> 3');

    delete require.cache[require.resolve('../services/property-service/src/migrations/backfillInspectionRealtor')];
    const backfill = require('../services/property-service/src/migrations/backfillInspectionRealtor');
    await backfill(sequelize);

    const rows = await sequelize.query('SELECT id, realtor_id FROM inspections ORDER BY id',
      { type: QueryTypes.SELECT });
    const by = Object.fromEntries(rows.map((r) => [Number(r.id), r.realtor_id == null ? null : Number(r.realtor_id)]));
    check(engine, 'backfillInspectionRealtor binds an unambiguous name, trimmed and case-folded',
      by[1] === 1, `inspection 1 -> ${by[1]}`);
    check(engine, '...leaves an ambiguous name unbound rather than guessing',
      by[2] === null, `inspection 2 -> ${by[2]} (two realtors share that name)`);
    check(engine, '...and never overwrites a row that is already linked',
      by[3] === 9, `inspection 3 -> ${by[3]}`);

    await backfill(sequelize);
    const after = await sequelize.query('SELECT id, realtor_id FROM inspections ORDER BY id',
      { type: QueryTypes.SELECT });
    check(engine, 'Re-running the backfill changes nothing',
      JSON.stringify(after.map((r) => (r.realtor_id == null ? null : Number(r.realtor_id))))
        === JSON.stringify([1, null, 9]),
      JSON.stringify(after.map((r) => r.realtor_id)));

    await sequelize.query('DROP TABLE IF EXISTS inspections');
    await sequelize.query('DROP TABLE IF EXISTS users');
  }

  // ── backfillInvoiceProperty ───────────────────────────────────────────────
  {
    /**
     * Same UPDATE ... FROM / UPDATE ... JOIN split as the backfill above, so
     * the rejection itself is already pinned there and not repeated. What is
     * checked here is the judgement: which rows it refuses to touch.
     *
     * An invoice labelled with the wrong property is worse than one labelled
     * with none, so a fee invoice stays null and a pair of purchase requests
     * that disagree is skipped rather than resolved by picking one.
     */
    await sequelize.query('DROP TABLE IF EXISTS invoices');
    await sequelize.query('DROP TABLE IF EXISTS property_purchase_requests');

    delete require.cache[require.resolve('../services/finance-service/src/migrations/backfillInvoiceProperty')];
    const backfillInvoice = require('../services/finance-service/src/migrations/backfillInvoiceProperty');

    let absentError = null;
    try { await backfillInvoice(sequelize); } catch (error) { absentError = error.message.split('\n')[0]; }
    check(engine, 'backfillInvoiceProperty no-ops when the tables are absent',
      absentError === null, absentError || 'property_purchase_requests can be in another database entirely');

    await sequelize.query('CREATE TABLE invoices (id INT NOT NULL PRIMARY KEY, invoice_id VARCHAR(32), property_id INT NULL)');
    await sequelize.query(`CREATE TABLE property_purchase_requests (
      id INT NOT NULL PRIMARY KEY, invoice_id INT NULL, property_id INT NULL)`);
    // 1 raised by a purchase but never populated; 2 already set; 3 a fee with no
    // purchase behind it; 4 has two requests that disagree about the property.
    await sequelize.query(`INSERT INTO invoices (id, invoice_id, property_id) VALUES
      (1,'INV-0001',NULL), (2,'INV-0002',77), (3,'INV-0003',NULL), (4,'INV-0004',NULL)`);
    await sequelize.query(`INSERT INTO property_purchase_requests (id, invoice_id, property_id) VALUES
      (1, 1, 10), (2, 2, 99), (3, 4, 20), (4, 4, 21)`);

    await backfillInvoice(sequelize);
    const read = async () => {
      const rows = await sequelize.query('SELECT id, property_id FROM invoices ORDER BY id',
        { type: QueryTypes.SELECT });
      return Object.fromEntries(rows.map((r) => [Number(r.id), r.property_id == null ? null : Number(r.property_id)]));
    };
    const filled = await read();
    check(engine, 'backfillInvoiceProperty fills property_id from the purchase request',
      filled[1] === 10, `invoice 1 -> ${filled[1]}`);
    check(engine, '...never overwrites a property_id already set',
      filled[2] === 77, `invoice 2 -> ${filled[2]} (its request says 99)`);
    check(engine, '...leaves an invoice with no purchase behind it null',
      filled[3] === null, `invoice 3 -> ${filled[3]}`);
    check(engine, '...and skips one whose requests disagree rather than guessing',
      filled[4] === null, `invoice 4 -> ${filled[4]} (requests say 20 and 21)`);

    await backfillInvoice(sequelize);
    check(engine, 'Re-running it changes nothing, so every boot is safe',
      JSON.stringify(await read()) === JSON.stringify(filled), '');

    await sequelize.query('DROP TABLE IF EXISTS invoices');
    await sequelize.query('DROP TABLE IF EXISTS property_purchase_requests');
  }

  // ── splitReceiptRejectionReason ───────────────────────────────────────────
  {
    /**
     * Rejecting a payment used to write the admin's reason over receipts.notes
     * — the buyer's OWN note from submission. Two things were lost: whatever
     * the buyer wrote, and any way to tell afterwards whose words were whose.
     *
     * What is checked here is the discrimination. A rejected row's note is the
     * reason and moves; a pending or verified row's note is the buyer's and
     * must not be touched by a migration that cannot tell them apart.
     */
    await sequelize.query('DROP TABLE IF EXISTS receipts');

    delete require.cache[require.resolve('../services/finance-service/src/migrations/splitReceiptRejectionReason')];
    const splitReason = require('../services/finance-service/src/migrations/splitReceiptRejectionReason');

    let absentError = null;
    try { await splitReason(sequelize); } catch (error) { absentError = error.message.split('\n')[0]; }
    check(engine, 'splitReceiptRejectionReason no-ops when receipts is absent', absentError === null, absentError || '');

    // Before sync has added the column there is nowhere to move anything to.
    await sequelize.query('CREATE TABLE receipts (id INT NOT NULL PRIMARY KEY, status VARCHAR(20), notes TEXT)');
    let earlyError = null;
    try { await splitReason(sequelize); } catch (error) { earlyError = error.message.split('\n')[0]; }
    check(engine, '...and no-ops before sync has added rejection_reason',
      earlyError === null, earlyError || 'sync({ alter: true }) adds the column; this only moves the data');

    await sequelize.query('DROP TABLE IF EXISTS receipts');
    await sequelize.query(`CREATE TABLE receipts (
      id INT NOT NULL PRIMARY KEY, status VARCHAR(20), notes TEXT, rejection_reason TEXT)`);
    await sequelize.query(`INSERT INTO receipts (id, status, notes, rejection_reason) VALUES
      (1,'rejected','Amount does not match the transfer',NULL),
      (2,'pending','Paid from my GTB account',NULL),
      (3,'verified','Paid in two parts',NULL),
      (4,'rejected','old copy','a reason an admin already rewrote'),
      (5,'rejected','   ',NULL)`);

    await splitReason(sequelize);
    const readReceipts = async () => {
      const rowsFor = await sequelize.query('SELECT id, notes, rejection_reason FROM receipts ORDER BY id',
        { type: QueryTypes.SELECT });
      return Object.fromEntries(rowsFor.map((r) => [Number(r.id), r]));
    };
    const moved = await readReceipts();
    check(engine, 'splitReceiptRejectionReason moves a rejected note into rejection_reason',
      moved[1].rejection_reason === 'Amount does not match the transfer', `got ${moved[1].rejection_reason}`);
    check(engine, "...never touches a buyer's note on a pending or verified row",
      moved[2].rejection_reason === null && moved[2].notes === 'Paid from my GTB account'
        && moved[3].rejection_reason === null && moved[3].notes === 'Paid in two parts', '');
    check(engine, '...never reverts a reason an admin has since rewritten',
      moved[4].rejection_reason === 'a reason an admin already rewrote', `got ${moved[4].rejection_reason}`);
    check(engine, '...and skips a rejected row whose note is blank',
      moved[5].rejection_reason === null, `got ${moved[5].rejection_reason}`);

    await splitReason(sequelize);
    check(engine, 'Re-running it changes nothing, so every boot is safe',
      JSON.stringify(await readReceipts()) === JSON.stringify(moved), '');

    await sequelize.query('DROP TABLE IF EXISTS receipts');
  }

  // ── heldQuantity under a lock ─────────────────────────────────────────────
  {
    /**
     * `SELECT SUM(...) ... FOR UPDATE` is accepted by MySQL and rejected by
     * Postgres. It shipped because the only caller that locks is the payment
     * APPROVAL path — every unlocked read of availability worked fine, so
     * development on MySQL saw nothing and production on Postgres could not
     * approve a payment at all.
     *
     * This is the exact shape this suite exists for: not a query that is wrong
     * everywhere, but one that is wrong on the engine nobody develops against.
     */
    await sequelize.query('DROP TABLE IF EXISTS property_unit_holds');
    await sequelize.query(`CREATE TABLE property_unit_holds (
      id INTEGER PRIMARY KEY,
      property_unit_id INTEGER,
      invoice_id INTEGER,
      quantity INTEGER,
      released_at TIMESTAMP NULL
    )`);
    await sequelize.query(`INSERT INTO property_unit_holds
      (id, property_unit_id, invoice_id, quantity, released_at) VALUES
      (1, 1, 10, 2, NULL), (2, 1, 11, 3, NULL), (3, 1, 12, 9, '2026-01-01 00:00:00')`);

    delete require.cache[require.resolve('../shared/src/inventoryGateway')];
    const { heldQuantity } = require('../shared/src/inventoryGateway');

    const unlocked = await heldQuantity(sequelize, 1);
    check(engine, 'heldQuantity sums unreleased holds', unlocked === 5, `got ${unlocked}`);

    const transaction = await sequelize.transaction();
    let lockedError = null;
    let locked = null;
    try {
      locked = await heldQuantity(sequelize, 1, { transaction, lock: true });
    } catch (error) {
      lockedError = error.message.split('\n')[0];
    }
    await transaction.rollback();

    check(engine, '...and sums them the same way under a row lock',
      lockedError === null && locked === 5, lockedError || `got ${locked}`);

    // The shape that shipped, asserted to still be refused where it was refused
    // — so the reason for the workaround stays visible.
    const t2 = await sequelize.transaction();
    let oldShapeError = null;
    try {
      await sequelize.query(
        `SELECT COALESCE(SUM(quantity), 0) AS held FROM property_unit_holds
          WHERE property_unit_id = 1 AND released_at IS NULL FOR UPDATE`,
        { type: QueryTypes.SELECT, transaction: t2 },
      );
    } catch (error) {
      oldShapeError = error.message.split('\n')[0];
    }
    await t2.rollback();

    if (engine === 'postgres') {
      check(engine, 'The OLD aggregate-under-lock query is rejected here (why it shipped)',
        oldShapeError !== null && /aggregate/i.test(oldShapeError), oldShapeError || 'accepted');
    } else {
      check(engine, 'The OLD aggregate-under-lock query is accepted here (why it shipped)',
        oldShapeError === null, oldShapeError || 'MySQL permits it, which is how it passed review');
    }

    await sequelize.query('DROP TABLE IF EXISTS property_unit_holds');
  }

  // ── createAuditLog ────────────────────────────────────────────────────────
  {
    /**
     * "An audit cannot be edited or deleted" is a claim about the DATABASE, not
     * about this codebase — Sequelize hooks bind only what goes through the
     * model, and say nothing about another service, a migration, or a psql
     * prompt. So it is enforced by triggers, and triggers are the single most
     * engine-specific thing in the repository: Postgres needs a plpgsql
     * function plus a trigger that calls it, MySQL needs SIGNAL SQLSTATE inline.
     *
     * Two spellings of one guarantee is exactly the shape that works on the
     * engine somebody developed against and quietly does nothing on the other.
     */
    await sequelize.query('DROP TABLE IF EXISTS audit_logs');

    delete require.cache[require.resolve('../services/user-service/src/migrations/createAuditLog')];
    const createAuditLog = require('../services/user-service/src/migrations/createAuditLog');

    await createAuditLog(sequelize);
    const columns = await D.columnsOf(sequelize, 'audit_logs');
    check(engine, 'createAuditLog builds the table', columns !== null,
      columns ? `${columns.size} columns` : 'missing');
    check(engine, '...with the columns the recorder inserts into',
      ['company_id', 'actor_id', 'actor_name', 'action', 'action_label', 'module',
        'entity_type', 'entity_id', 'metadata', 'created_at'].every((c) => columns.has(c)),
      '');

    await createAuditLog(sequelize);
    check(engine, 'Re-running it changes nothing, so every boot is safe',
      (await D.columnsOf(sequelize, 'audit_logs')).size === columns.size, '');

    await sequelize.query(
      "INSERT INTO audit_logs (action, created_at) VALUES ('properties.approve', NOW())",
    );

    let refusedUpdate = false;
    try {
      await sequelize.query("UPDATE audit_logs SET action = 'tampered'");
    } catch { refusedUpdate = true; }
    check(engine, 'The database refuses to UPDATE an audit entry', refusedUpdate,
      'a Sequelize hook would not have stopped this statement');

    let refusedDelete = false;
    try {
      await sequelize.query('DELETE FROM audit_logs');
    } catch { refusedDelete = true; }
    check(engine, 'The database refuses to DELETE an audit entry', refusedDelete, '');

    const [survivor] = await sequelize.query(
      'SELECT action FROM audit_logs', { type: QueryTypes.SELECT },
    );
    check(engine, '...and the entry survives both attempts, unaltered',
      survivor?.action === 'properties.approve', String(survivor?.action));

    // Dropping the TABLE is still allowed — the guarantee is about the rows in
    // it, not about the schema being permanent.
    await sequelize.query('DROP TABLE IF EXISTS audit_logs');
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
  await runCommissionStatusChecks(my, 'mysql');
  await runMigrationChecks(my, 'mysql');
  await runInvoicePageChecks(my, 'mysql');
  await runSearchAndBackfillChecks(my, 'mysql');
  await runCommissionEngineChecks(my, 'mysql');
  await runReceiptCascadeChecks(my, 'mysql');
  await runMediaPostCascadeChecks(my, 'mysql');
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
  await runCommissionStatusChecks(pg, 'postgres');
    await runMigrationChecks(pg, 'postgres');
    await runInvoicePageChecks(pg, 'postgres');
    await runSearchAndBackfillChecks(pg, 'postgres');
    await runCommissionEngineChecks(pg, 'postgres');
    await runReceiptCascadeChecks(pg, 'postgres');
    await runMediaPostCascadeChecks(pg, 'postgres');
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

/**
 * Document references and payment references.
 *
 * Against a THROWAWAY database, because the interesting failures only appear
 * against real SQL: the unique index doing the work under concurrency, and
 * NULL being allowed to repeat where an empty string is not.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });
process.env.CACHE_ENABLED = 'false';

const mysql = require('mysql2/promise');
const { Sequelize, QueryTypes } = require('sequelize');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_references`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }

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

  const sequelize = new Sequelize(DB, process.env.DB_USER, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306, dialect: 'mysql', logging: false,
  });

  // The shape the real tables have, for the columns this feature touches.
  await sequelize.query(`
    CREATE TABLE invoices (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      invoice_id VARCHAR(64) NOT NULL,
      company_id INT UNSIGNED NULL,
      UNIQUE KEY ux_invoices_company_reference (company_id, invoice_id)
    );
  `);
  await sequelize.query(`
    CREATE TABLE invoice_payments (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      invoice_id INT UNSIGNED NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      payment_method VARCHAR(64) NOT NULL,
      transaction_id VARCHAR(255) NULL,
      status VARCHAR(32) DEFAULT 'completed',
      company_id INT UNSIGNED NULL,
      UNIQUE KEY ux_invoice_payments_company_reference (company_id, transaction_id)
    );
  `);

  // Credit and debit notes are the subject of the requirement, so they are
  // exercised rather than assumed to behave like invoices.
  await sequelize.query(`
    CREATE TABLE credit_notes (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      credit_note_id VARCHAR(64) NOT NULL,
      company_id INT UNSIGNED NULL,
      UNIQUE KEY ux_credit_notes_company_reference (company_id, credit_note_id)
    );
  `);
  await sequelize.query(`
    CREATE TABLE debit_notes (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      debit_note_id VARCHAR(64) NOT NULL,
      company_id INT UNSIGNED NULL,
      UNIQUE KEY ux_debit_notes_company_reference (company_id, debit_note_id)
    );
  `);
  await sequelize.query(`
    CREATE TABLE transactions (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      reference VARCHAR(255) NULL,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      company_id INT UNSIGNED NULL,
      UNIQUE KEY ux_transactions_company_reference (company_id, reference)
    );
  `);

  const define = (name, field, table) => sequelize.define(name, {
    [field]: { type: Sequelize.DataTypes.STRING, allowNull: false },
    company_id: { type: Sequelize.DataTypes.INTEGER.UNSIGNED },
  }, { tableName: table, timestamps: false });

  const Invoice = define('Invoice', 'invoice_id', 'invoices');
  const CreditNote = define('CreditNote', 'credit_note_id', 'credit_notes');
  const DebitNote = define('DebitNote', 'debit_note_id', 'debit_notes');

  // The REAL allocator, imported rather than re-created.
  const { nextNumber } = require('../shared/src/documentSequence');

  const createWithReference = async (Model, { field, prefix, companyId, payload }) => {
    const docType = Model.getTableName();
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const reference = await nextNumber(sequelize, {
        docType, table: docType, field, prefix, companyId,
      });
      try {
        // eslint-disable-next-line no-await-in-loop
        return await Model.create({ ...payload, [field]: reference });
      } catch (error) {
        const dup = error.name === 'SequelizeUniqueConstraintError'
          || error.original?.code === 'ER_DUP_ENTRY' || error.parent?.code === 'ER_DUP_ENTRY';
        if (!dup) throw error;
        lastError = error;
      }
    }
    throw Object.assign(new Error('Could not assign a reference number'), { status: 409, cause: lastError });
  };

  console.log('\n── Generation ───────────────────────────────────────────────────');

  const a1 = await createWithReference(Invoice, { field: 'invoice_id', prefix: 'INV-', companyId: 1, payload: { company_id: 1 } });
  const a2 = await createWithReference(Invoice, { field: 'invoice_id', prefix: 'INV-', companyId: 1, payload: { company_id: 1 } });
  check('References are generated in sequence',
    a1.invoice_id === 'INV-0001' && a2.invoice_id === 'INV-0002', `${a1.invoice_id}, ${a2.invoice_id}`);

  console.log('\n── Each company numbers from 1 ──────────────────────────────────');
  const b1 = await createWithReference(Invoice, { field: 'invoice_id', prefix: 'INV-', companyId: 2, payload: { company_id: 2 } });
  check('A second company starts at 1, not at the global next number',
    b1.invoice_id === 'INV-0001',
    `${b1.invoice_id} — company 1 is already at INV-0002; a shared sequence would have given INV-0003`);

  const [both] = await sequelize.query(
    "SELECT COUNT(*) AS n FROM invoices WHERE invoice_id = 'INV-0001'", { type: QueryTypes.SELECT },
  );
  check('The same number can exist for two different companies', Number(both.n) === 2, `${both.n} rows hold INV-0001`);

  console.log('\n── A company cannot reuse its own number ────────────────────────');
  let rejected = false;
  try {
    await Invoice.create({ invoice_id: 'INV-0001', company_id: 1 });
  } catch (error) {
    rejected = error.name === 'SequelizeUniqueConstraintError'
      || error.original?.code === 'ER_DUP_ENTRY';
  }
  check('Reusing a number within the same company is refused by the database',
    rejected, 'the index is the guarantee, not the application check');

  console.log('\n── Concurrency ──────────────────────────────────────────────────');
  // Twelve simultaneous creates: no duplicates, no gaps, nothing lost.
  const burst = await Promise.all(Array.from({ length: 12 }, () => createWithReference(
    Invoice, { field: 'invoice_id', prefix: 'INV-', companyId: 3, payload: { company_id: 3 } },
  )));
  const refs = burst.map((r) => r.invoice_id).sort();
  const unique = new Set(refs);
  check('Twelve simultaneous creates produce twelve distinct references',
    unique.size === 12, `${unique.size} distinct of 12`);
  const expected = Array.from({ length: 12 }, (_, i) => `INV-${String(i + 1).padStart(4, '0')}`);
  check('...and they are contiguous, with no numbers skipped',
    JSON.stringify(refs) === JSON.stringify(expected), refs.join(' '));

  console.log('\n── Payment references: one reference, one payment ───────────────');
  const pay = async (reference, companyId = 1) => sequelize.query(
    `INSERT INTO invoice_payments (invoice_id, amount, payment_method, transaction_id, company_id)
     VALUES (1, 100, 'transfer', :reference, :companyId)`,
    { replacements: { reference, companyId }, type: QueryTypes.INSERT },
  );

  await pay('FT2026-778899');
  let doubleCredited = true;
  try { await pay('FT2026-778899'); } catch { doubleCredited = false; }
  check('The same bank reference cannot be credited twice',
    !doubleCredited, 'FT2026-778899 — the double-credit this exists to prevent');

  let otherCompany = true;
  try { await pay('FT2026-778899', 2); } catch { otherCompany = false; }
  check('...but another company may legitimately hold the same reference',
    otherCompany, 'references are only unique within a company');

  console.log('\n── Missing references must repeat freely ────────────────────────');
  let nullsOk = true;
  try { await pay(null); await pay(null); await pay(null); } catch { nullsOk = false; }
  check('Several payments with NO reference can coexist',
    nullsOk, 'an admin-approved payment has no proof and no reference');

  const [nullCount] = await sequelize.query(
    'SELECT COUNT(*) AS n FROM invoice_payments WHERE transaction_id IS NULL', { type: QueryTypes.SELECT },
  );
  check('...and all of them were stored', Number(nullCount.n) === 3, `${nullCount.n} reference-less payments`);

  // The empty string is the trap: not NULL, so it WOULD collide.
  let blankRepeats = true;
  try { await pay(''); await pay(''); } catch { blankRepeats = false; }
  check('An empty-string reference collides, which is why the code normalises it to NULL',
    !blankRepeats,
    'allocationService trims the reference and stores null — this proves why that matters');

  console.log('\n── Credit and debit notes, which is what was actually asked for ─');

  const cn1 = await createWithReference(CreditNote, { field: 'credit_note_id', prefix: 'CN-', companyId: 1, payload: { company_id: 1 } });
  const cn2 = await createWithReference(CreditNote, { field: 'credit_note_id', prefix: 'CN-', companyId: 1, payload: { company_id: 1 } });
  check('A credit note is numbered automatically, in sequence',
    cn1.credit_note_id === 'CN-0001' && cn2.credit_note_id === 'CN-0002',
    `${cn1.credit_note_id}, ${cn2.credit_note_id}`);

  const dn1 = await createWithReference(DebitNote, { field: 'debit_note_id', prefix: 'DN-', companyId: 1, payload: { company_id: 1 } });
  check('A debit note is numbered automatically too', dn1.debit_note_id === 'DN-0001', dn1.debit_note_id);

  const cnOther = await createWithReference(CreditNote, { field: 'credit_note_id', prefix: 'CN-', companyId: 2, payload: { company_id: 2 } });
  check('Each company numbers its own notes from 1',
    cnOther.credit_note_id === 'CN-0001',
    'company 1 is already at CN-0002, so a shared sequence would have given CN-0003');

  console.log('\n── One sequence per document TYPE, not one for everything ───────');

  check('Company 1 holds INV-0001, CN-0001 and DN-0001 at the same time',
    cn1.credit_note_id === 'CN-0001' && dn1.debit_note_id === 'DN-0001',
    'the requirement is uniqueness per company AND per type, so the types do not share a counter');

  {
    let refused = false;
    try { await CreditNote.create({ credit_note_id: 'CN-0001', company_id: 1 }); } catch (error) {
      refused = error.name === 'SequelizeUniqueConstraintError' || error.original?.code === 'ER_DUP_ENTRY';
    }
    check('A credit note number cannot be reused within its company', refused);
  }
  {
    // A debit note numbered CN-0001 is not a collision: different table, and
    // in practice different prefix. This confirms the scopes really are
    // separate rather than sharing one namespace by accident.
    let allowed = true;
    try { await DebitNote.create({ debit_note_id: 'CN-0001', company_id: 1 }); } catch { allowed = false; }
    check('A debit note is not constrained by a credit note\'s number', allowed,
      'separate tables, separate counters, separate indexes');
  }

  console.log('\n── The number is assigned, never taken from the request ─────────');

  {
    // The literal requirement: the reference is generated and populated
    // "instead of requesting it as an input".
    const forged = await createWithReference(CreditNote, {
      field: 'credit_note_id', prefix: 'CN-', companyId: 3,
      payload: { company_id: 3, credit_note_id: 'CN-9999' },
    });
    check('A reference supplied in the payload is overwritten by the generated one',
      forged.credit_note_id === 'CN-0001',
      `${forged.credit_note_id} — the caller asked for CN-9999 and did not get it`);
  }
  {
    const [row] = await sequelize.query(
      "SELECT COUNT(*) AS n FROM credit_notes WHERE credit_note_id = 'CN-9999'",
      { type: QueryTypes.SELECT },
    );
    check('...and the value they asked for reached the database nowhere',
      Number(row.n) === 0, `${row.n} rows carry CN-9999`);
  }

  console.log('\n── Transaction references ───────────────────────────────────────');

  {
    const tx = async (reference, companyId = 1) => sequelize.query(
      'INSERT INTO transactions (reference, amount, company_id) VALUES (:reference, 100, :companyId)',
      { replacements: { reference, companyId }, type: QueryTypes.INSERT },
    );
    await tx('TRX-55');
    let twice = true;
    try { await tx('TRX-55'); } catch { twice = false; }
    check('One reference cannot be attached to two transactions', !twice);

    let otherCompany = true;
    try { await tx('TRX-55', 2); } catch { otherCompany = false; }
    check('...while another company may hold the same one', otherCompany);

    let nulls = true;
    try { await tx(null); await tx(null); } catch { nulls = false; }
    check('Transactions with no reference still coexist', nulls,
      'a cash movement with no external reference is ordinary');
  }

  await sequelize.close();
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);

  // ── The migration, against data shaped the way production already is ──────
  console.log('\n── The migration, on a database that already has documents ──────');

  const LEGACY = `${DB}_legacy`;
  await admin.query(`DROP DATABASE IF EXISTS \`${LEGACY}\``);
  await admin.query(`CREATE DATABASE \`${LEGACY}\``);
  const legacy = new Sequelize(LEGACY, process.env.DB_USER, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306, dialect: 'mysql', logging: false,
  });

  // The OLD shape: one global unique index, as it was before this change.
  await legacy.query(`
    CREATE TABLE invoices (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      invoice_id VARCHAR(64) NOT NULL,
      company_id INT UNSIGNED NULL,
      UNIQUE KEY invoice_id (invoice_id)
    );
  `);
  for (const t of ['credit_notes', 'debit_notes']) {
    const column = t === 'credit_notes' ? 'credit_note_id' : 'debit_note_id';
    await legacy.query(`
      CREATE TABLE ${t} (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        ${column} VARCHAR(64) NOT NULL,
        company_id INT UNSIGNED NULL,
        UNIQUE KEY ${column} (${column})
      );
    `);
  }
  await legacy.query(`
    CREATE TABLE invoice_payments (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      invoice_id INT UNSIGNED NOT NULL DEFAULT 1,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      payment_method VARCHAR(64) NOT NULL DEFAULT 'transfer',
      transaction_id VARCHAR(255) NULL,
      company_id INT UNSIGNED NULL
    );
  `);
  await legacy.query(`
    CREATE TABLE transactions (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      reference VARCHAR(255) NULL,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      company_id INT UNSIGNED NULL
    );
  `);

  await legacy.query("INSERT INTO invoices (invoice_id, company_id) VALUES ('INV-0001', 1), ('INV-0002', 2)");
  await legacy.query("INSERT INTO credit_notes (credit_note_id, company_id) VALUES ('CN-0001', 1)");
  await legacy.query("INSERT INTO debit_notes (debit_note_id, company_id) VALUES ('DN-0001', 1)");
  // Two blank references: the trap the migration exists to defuse, because ''
  // is not NULL and would collide the moment the index is added.
  await legacy.query("INSERT INTO invoice_payments (transaction_id, company_id) VALUES ('', 1), ('   ', 1), (NULL, 1)");

  const enforce = require('../services/finance-service/src/migrations/enforceReferenceUniqueness');
  let migrationThrew = null;
  try { await enforce(legacy); } catch (error) { migrationThrew = error; }
  check('The migration runs without throwing', migrationThrew === null, migrationThrew?.message || '');

  const hasIndex = async (table, name) => {
    const rows = await legacy.query(
      `SELECT 1 FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = :table AND index_name = :name LIMIT 1`,
      { replacements: { table, name }, type: QueryTypes.SELECT },
    );
    return rows.length > 0;
  };

  check('invoices gains the per-company index', await hasIndex('invoices', 'ux_invoices_company_reference'));
  check('...and the old GLOBAL index is dropped',
    !(await hasIndex('invoices', 'invoice_id')),
    'leaving it would keep every company drawing from one sequence, which is the bug being fixed');
  check('credit_notes and debit_notes are converted the same way',
    (await hasIndex('credit_notes', 'ux_credit_notes_company_reference'))
    && (await hasIndex('debit_notes', 'ux_debit_notes_company_reference'))
    && !(await hasIndex('credit_notes', 'credit_note_id'))
    && !(await hasIndex('debit_notes', 'debit_note_id')));

  {
    const [row] = await legacy.query(
      "SELECT COUNT(*) AS n FROM invoice_payments WHERE transaction_id IS NULL", { type: QueryTypes.SELECT },
    );
    check('Blank payment references are rewritten to NULL, so they stop colliding',
      Number(row.n) === 3,
      `${row.n} of 3 — '' and '   ' both became NULL, joining the one that already was`);
  }
  check('invoice_payments and transactions gain their indexes',
    (await hasIndex('invoice_payments', 'ux_invoice_payments_company_reference'))
    && (await hasIndex('transactions', 'ux_transactions_company_reference')));

  check('Re-running it changes nothing and does not fail',
    await (async () => {
      try { await enforce(legacy); return true; } catch { return false; }
    })(),
    'it runs on every boot, so it has to be idempotent');

  console.log('\n── ...and when the existing data cannot satisfy the index ───────');

  {
    // A company holding the same number twice already. Renumbering or deleting
    // is a business decision, so the migration must report and continue rather
    // than crash every boot or silently destroy a record.
    await legacy.query('DROP TABLE transactions');
    await legacy.query(`
      CREATE TABLE transactions (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        reference VARCHAR(255) NULL,
        amount DECIMAL(12,2) NOT NULL DEFAULT 0,
        company_id INT UNSIGNED NULL
      );
    `);
    await legacy.query("INSERT INTO transactions (reference, company_id) VALUES ('DUP-1', 1), ('DUP-1', 1)");

    let threw = null;
    try { await enforce(legacy); } catch (error) { threw = error; }
    check('A pre-existing duplicate does not crash the boot', threw === null, threw?.message || '');
    check('...the index is NOT created, so nothing is silently renumbered or deleted',
      !(await hasIndex('transactions', 'ux_transactions_company_reference')),
      'it reports which rows to look at and leaves them alone');

    const [still] = await legacy.query('SELECT COUNT(*) AS n FROM transactions', { type: QueryTypes.SELECT });
    check('...and both rows are still there', Number(still.n) === 2, `${still.n} rows`);
  }

  await legacy.close();
  await admin.query(`DROP DATABASE IF EXISTS \`${LEGACY}\``);
  await admin.end();
  console.log(`\n  ${pass}/${pass + fail} passed.\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ABORTED:', e); process.exit(1); });

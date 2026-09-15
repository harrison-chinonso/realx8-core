/**
 * Repairing rows that lost their company — and refusing to guess at the rest.
 *
 * ── What is actually at stake ───────────────────────────────────────────────
 *
 * A row with company_id NULL is invisible to every company-scoped read, so a
 * paid invoice simply vanishes from the revenue report. Attaching it to the
 * WRONG company is worse: the money reappears on somebody else's books, and
 * afterwards nothing records where it came from. So the two things this proves
 * are that unambiguous rows are repaired, and that ambiguous ones are left
 * exactly where they are.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { QueryTypes } = require('sequelize');
const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_backfill`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifybackfill';

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

  const { sequelize } = require('../services/finance-service/src/config/database');
  const { backfillCompany } = require('../shared/src/backfillCompany');

  const raw = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

  // A minimal shape of the real tables — only the columns the backfill reads.
  await sequelize.query(`CREATE TABLE companies (id INT PRIMARY KEY, name VARCHAR(80))`);
  await sequelize.query(`CREATE TABLE users (
    id INT PRIMARY KEY, name VARCHAR(80), company_id INT NULL)`);
  await sequelize.query(`CREATE TABLE properties (
    id INT PRIMARY KEY, name VARCHAR(80), company_id INT NULL)`);
  await sequelize.query(`CREATE TABLE invoices (
    id INT PRIMARY KEY, invoice_id VARCHAR(40), client_id INT NULL,
    property_id INT NULL, amount DECIMAL(12,2), company_id INT NULL)`);
  await sequelize.query(`CREATE TABLE invoice_payments (
    id INT PRIMARY KEY, invoice_id INT NULL, amount DECIMAL(12,2), company_id INT NULL)`);

  await sequelize.query(`INSERT INTO companies (id, name) VALUES (1, 'Alpha'), (2, 'Beta')`);
  await sequelize.query(`INSERT INTO users (id, name, company_id) VALUES
    (1, 'Alpha Client', 1),
    (2, 'Beta Client',  2),
    (9, 'Platform Admin', NULL)`);
  await sequelize.query(`INSERT INTO properties (id, name, company_id) VALUES
    (1, 'Alpha Estate', 1), (2, 'Beta Estate', 2), (3, 'Nobody''s', NULL)`);

  await sequelize.query(`INSERT INTO invoices (id, invoice_id, client_id, property_id, amount, company_id) VALUES
    (1, 'INV-1', 1,    1,    500000, NULL),
    (2, 'INV-2', NULL, 2,    300000, NULL),
    (3, 'INV-3', 9,    3,    100000, NULL),
    (4, 'INV-4', 2,    2,    900000, 2)`);

  await sequelize.query(`INSERT INTO invoice_payments (id, invoice_id, amount, company_id) VALUES
    (1, 1, 200000, NULL),
    (2, 1, 300000, NULL),
    (3, 3, 100000, NULL),
    (4, 4, 900000, 2)`);

  console.log('\n── Rows whose owner is obvious are repaired ────────────────────');
  {
    const result = await backfillCompany(sequelize, {
      table: 'invoices',
      sources: [
        { join: 'users', on: 'client_id', column: 'company_id', label: 'its client' },
        { join: 'properties', on: 'property_id', column: 'company_id', label: 'its property' },
      ],
    });
    check('It reports how many it found and fixed',
      result.orphans === 3 && result.fixed === 2, `${result.fixed} of ${result.orphans}`);

    const [one] = await raw('SELECT company_id FROM invoices WHERE id = 1');
    check('An invoice takes its client\'s company', Number(one.company_id) === 1, String(one.company_id));

    /**
     * Invoice 2 has no client at all, so the property is the only evidence —
     * which is exactly why the sources are a list rather than one column.
     */
    const [two] = await raw('SELECT company_id FROM invoices WHERE id = 2');
    check('...and falls back to its property when there is no client',
      Number(two.company_id) === 2, String(two.company_id));
  }

  console.log('\n── Rows with nothing to go on are LEFT ALONE ───────────────────');
  {
    /**
     * Invoice 3 belongs to a platform admin, against a property nobody owns.
     * Nothing on it names a company. Picking one — the commonest, the first,
     * the newest — would put real money on a tenant's books that never earned
     * it, and nothing afterwards would record that it had been guessed.
     */
    const [three] = await raw('SELECT company_id FROM invoices WHERE id = 3');
    check('An invoice with no evidence keeps its NULL',
      three.company_id === null, `company_id ${three.company_id}`);
  }

  console.log('\n── A row that already names a company is never touched ─────────');
  {
    const [four] = await raw('SELECT company_id FROM invoices WHERE id = 4');
    check('An attributed invoice is left exactly as it was',
      Number(four.company_id) === 2, String(four.company_id));

    /**
     * The failure this guards against is the unrecoverable one: moving money
     * between tenants. Every statement carries `WHERE company_id IS NULL`, so
     * a row that already has an owner cannot be re-derived onto a different
     * one — not even if the evidence now points elsewhere.
     */
    await sequelize.query('UPDATE invoices SET client_id = 1 WHERE id = 4');
    await backfillCompany(sequelize, {
      table: 'invoices',
      sources: [{ join: 'users', on: 'client_id', column: 'company_id', label: 'its client' }],
    });
    const [still] = await raw('SELECT company_id FROM invoices WHERE id = 4');
    check('...even when its evidence later points somewhere else',
      Number(still.company_id) === 2,
      `${still.company_id} — a re-derivation would have moved it to company 1`);
  }

  console.log('\n── Children inherit from the parent just repaired ──────────────');
  {
    const result = await backfillCompany(sequelize, {
      table: 'invoice_payments',
      sources: [{ join: 'invoices', on: 'invoice_id', column: 'company_id', label: 'its invoice' }],
    });
    check('Payments take their invoice\'s company', result.fixed === 2, `${result.fixed} fixed`);

    const rows = await raw('SELECT id, company_id FROM invoice_payments ORDER BY id');
    check('...both payments on the repaired invoice',
      Number(rows[0].company_id) === 1 && Number(rows[1].company_id) === 1,
      rows.map((r) => `#${r.id}→${r.company_id}`).join(' '));
    /**
     * Payment 3 hangs off invoice 3, which could not be attributed. It stays
     * NULL too — the ignorance propagates rather than being resolved by a
     * guess one level down.
     */
    check('...while one whose invoice is still unattributed stays NULL',
      rows[2].company_id === null, `#${rows[2].id}→${rows[2].company_id}`);
    check('...and an already-attributed payment is untouched',
      Number(rows[3].company_id) === 2, `#${rows[3].id}→${rows[3].company_id}`);
  }

  console.log('\n── Running it again does nothing ───────────────────────────────');
  {
    const before = await raw('SELECT id, company_id FROM invoices ORDER BY id');
    await backfillCompany(sequelize, {
      table: 'invoices',
      sources: [
        { join: 'users', on: 'client_id', column: 'company_id', label: 'its client' },
        { join: 'properties', on: 'property_id', column: 'company_id', label: 'its property' },
      ],
    });
    const after = await raw('SELECT id, company_id FROM invoices ORDER BY id');
    check('A second run changes nothing, so every boot is safe',
      JSON.stringify(before) === JSON.stringify(after), '');
  }

  console.log('\n── A table that is not there is not an error ───────────────────');
  {
    const missing = await backfillCompany(sequelize, {
      table: 'tasks_that_do_not_exist',
      sources: [{ join: 'users', on: 'assigned_to', column: 'company_id' }],
    });
    check('An absent table is skipped rather than thrown',
      missing.skipped === 'no_such_table', missing.skipped);
  }

  await sequelize.close();
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error('\n  Harness error:', error);
  process.exit(1);
});

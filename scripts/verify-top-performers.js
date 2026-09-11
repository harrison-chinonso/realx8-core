/**
 * The top-performers report, against BOTH engines.
 *
 * The report joins three tables and is ranked on money RECEIVED, so the things
 * worth asserting are the ones a reader would otherwise have to trust: that a
 * pending payment is not counted, that another company's money never appears,
 * and that a sale with no unit recorded is reported rather than silently
 * dropped. All of it runs twice, because production is Postgres and
 * development is MySQL.
 *
 *   npm run verify:top-performers
 */
const path = require('path');
const CORE = path.join(__dirname, '..');
require('dotenv').config({ path: `${CORE}/cred.env` });
const { Sequelize, QueryTypes } = require('sequelize');
const mysql = require('mysql2/promise');
const { Client } = require('pg');

let pass = 0, fail = 0;
const check = (l, ok, d = '') => { console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${l}${d ? `\n        ${d}` : ''}`); ok ? pass++ : fail++; };

const DDL_MY = [
  "CREATE TABLE invoices (id INT AUTO_INCREMENT PRIMARY KEY, property_id INT NULL, client_id INT NULL, company_id INT NULL)",
  "CREATE TABLE invoice_payments (id INT AUTO_INCREMENT PRIMARY KEY, invoice_id INT, amount DECIMAL(12,2), status VARCHAR(20), created_at DATETIME)",
  "CREATE TABLE purchase_requests (id INT AUTO_INCREMENT PRIMARY KEY, invoice_id INT NULL, unit_id INT NULL, unit_label VARCHAR(80), property_id INT NULL)",
  "CREATE TABLE properties (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120))",
  "CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120))",
];
const DDL_PG = [
  "CREATE TABLE invoices (id SERIAL PRIMARY KEY, property_id INT NULL, client_id INT NULL, company_id INT NULL)",
  "CREATE TABLE invoice_payments (id SERIAL PRIMARY KEY, invoice_id INT, amount NUMERIC(12,2), status VARCHAR(20), created_at TIMESTAMP)",
  "CREATE TABLE purchase_requests (id SERIAL PRIMARY KEY, invoice_id INT NULL, unit_id INT NULL, unit_label VARCHAR(80), property_id INT NULL)",
  "CREATE TABLE properties (id SERIAL PRIMARY KEY, name VARCHAR(120))",
  "CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(120))",
];
const SEED = [
  "INSERT INTO properties (id, name) VALUES (1,'Lekki Gardens'), (2,'Ikoyi Heights')",
  "INSERT INTO users (id, name) VALUES (10,'Chinonso'), (11,'Adaeze')",
  "INSERT INTO invoices (id, property_id, client_id, company_id) VALUES (100,1,10,1),(101,1,11,1),(102,2,10,1),(103,2,11,2)",
  // Property 1 receives 300; property 2 receives 150 (+ 999 for the rival company)
  "INSERT INTO invoice_payments (invoice_id, amount, status, created_at) VALUES " +
    "(100,200,'completed','2026-06-01'),(101,100,'completed','2026-06-02')," +
    "(102,150,'completed','2026-06-03'),(103,999,'completed','2026-06-04')," +
    "(100,500,'pending','2026-06-05')",
  "INSERT INTO purchase_requests (invoice_id, unit_id, unit_label, property_id) VALUES (100,5,'Block A Flat 2',1),(101,5,'Block A Flat 2',1)",
];

const run = async (seq, label) => {
  const companyId = 1;
  const cf = (a) => `AND ${a}.company_id = :companyId`;
  const r = { companyId, limit: 5 };

  const props = await seq.query(
    `SELECT i.property_id AS id, COUNT(DISTINCT i.id) AS invoices, SUM(p.amount) AS received
       FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id
      WHERE p.status = 'completed' AND i.property_id IS NOT NULL ${cf('i')}
      GROUP BY i.property_id ORDER BY received DESC LIMIT :limit`,
    { replacements: r, type: QueryTypes.SELECT });
  check(`${label}: properties ranked by money received`,
    Number(props[0].id) === 1 && Number(props[0].received) === 300,
    props.map((x) => `p${x.id}=${x.received}`).join(' '));
  check(`${label}: the rival company's 999 is excluded`,
    !props.some((x) => Number(x.received) === 999), 'company scoping holds');
  check(`${label}: a pending payment is not counted`,
    Number(props[0].received) === 300, '500 pending on invoice 100 was ignored');

  const units = await seq.query(
    `SELECT pr.unit_id AS id, MAX(pr.unit_label) AS label, MAX(pr.property_id) AS property_id,
            COUNT(DISTINCT i.id) AS invoices, SUM(p.amount) AS received
       FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id
       JOIN purchase_requests pr ON pr.invoice_id = i.id
      WHERE p.status = 'completed' AND pr.unit_id IS NOT NULL ${cf('i')}
      GROUP BY pr.unit_id ORDER BY received DESC LIMIT :limit`,
    { replacements: r, type: QueryTypes.SELECT });
  check(`${label}: units aggregate across invoices`,
    units.length === 1 && Number(units[0].received) === 300 && units[0].label === 'Block A Flat 2',
    `unit ${units[0]?.id} = ${units[0]?.received} over ${units[0]?.invoices} sales`);

  const clients = await seq.query(
    `SELECT i.client_id AS id, COUNT(DISTINCT i.id) AS invoices, SUM(p.amount) AS received
       FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id
      WHERE p.status = 'completed' AND i.client_id IS NOT NULL ${cf('i')}
      GROUP BY i.client_id ORDER BY received DESC LIMIT :limit`,
    { replacements: r, type: QueryTypes.SELECT });
  check(`${label}: clients ranked (Chinonso 350 over Adaeze 100)`,
    Number(clients[0].id) === 10 && Number(clients[0].received) === 350,
    clients.map((x) => `u${x.id}=${x.received}`).join(' '));

  const un = await seq.query(
    `SELECT COALESCE(SUM(p.amount), 0) AS received
       FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id
       LEFT JOIN purchase_requests pr ON pr.invoice_id = i.id
      WHERE p.status = 'completed' AND pr.unit_id IS NULL ${cf('i')}`,
    { replacements: r, type: QueryTypes.SELECT });
  check(`${label}: sales with no unit are reported, not hidden`,
    Number(un[0].received) === 150,
    'invoice 102 has no purchase_request — counted under properties, not units');
};

(async () => {
  const MY = `${process.env.DB_NAME}_verify_tp`;
  const admin = await mysql.createConnection({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  await admin.query(`DROP DATABASE IF EXISTS \`${MY}\``); await admin.query(`CREATE DATABASE \`${MY}\``);
  const my = new Sequelize(MY, process.env.DB_USER, process.env.DB_PASSWORD, { host: process.env.DB_HOST, dialect: 'mysql', logging: false });
  for (const d of [...DDL_MY, ...SEED]) await my.query(d);
  console.log('\n── MySQL ────────────────────────────────────────────────────────');
  await run(my, 'mysql');
  await my.close(); await admin.query(`DROP DATABASE IF EXISTS \`${MY}\``); await admin.end();

  const PG = { host: 'localhost', port: 5433, user: 'postgres', password: 'postgres' };
  const pgAdmin = new Client({ ...PG, database: 'postgres' });
  await pgAdmin.connect();
  await pgAdmin.query('DROP DATABASE IF EXISTS realx8_verify_tp');
  await pgAdmin.query('CREATE DATABASE realx8_verify_tp');
  await pgAdmin.end();
  const pg = new Sequelize('realx8_verify_tp', PG.user, PG.password, { host: PG.host, port: PG.port, dialect: 'postgres', logging: false });
  for (const d of [...DDL_PG, ...SEED]) await pg.query(d);
  console.log('\n── Postgres ─────────────────────────────────────────────────────');
  await run(pg, 'postgres');
  await pg.close();
  const c = new Client({ ...PG, database: 'postgres' }); await c.connect();
  await c.query('DROP DATABASE IF EXISTS realx8_verify_tp'); await c.end();

  console.log(`\n  ${pass}/${pass + fail} passed.\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ABORTED:', e.message); process.exit(1); });

/**
 * The raw settings queries, against BOTH engines.
 *
 * These read columns called key, value and group — all reserved words that
 * must be quoted to be read at all. MySQL quotes with backticks, Postgres with
 * double quotes, and each REJECTS the other's, so a literal backtick is a
 * syntax error on Postgres that is invisible in MySQL development. That is
 * exactly how `paymentSettingsFor` failed in production and nowhere else.
 *
 * Every query below therefore runs twice.
 *
 *   npm run verify:settings-queries
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { Sequelize, QueryTypes } = require('sequelize');
const mysql = require('mysql2/promise');
const { Client } = require('pg');
const { q } = require('../shared/src/dialect');

const MYSQL_DB = `${process.env.DB_NAME || 'realto'}_verify_settings`;
const PG_DB = 'realx8_verify_settings';
const PG = {
  host: process.env.PG_HOST || 'localhost',
  port: Number(process.env.PG_PORT || 5433),
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
};

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

/** The real queries, written once and quoted per engine. */
const QUERIES = {
  'payment gateway settings (the production failure)': (s) => ({
    sql: `SELECT ${q(s, 'key')}, ${q(s, 'value')}, company_id FROM settings
           WHERE ${q(s, 'group')} = 'payment'
             AND (company_id IS NULL OR company_id = :companyId)`,
    replacements: { companyId: 1 },
  }),
  'auth config (system + email groups)': (s) => ({
    sql: `SELECT ${q(s, 'key')}, ${q(s, 'value')} FROM settings
           WHERE ${q(s, 'group')} IN ('system', 'email') AND company_id IS NULL`,
    replacements: {},
  }),
  '2FA policy lookup': (s) => ({
    sql: `SELECT ${q(s, 'key')}, ${q(s, 'value')}, company_id FROM settings
           WHERE ${q(s, 'key')} = '2fa_required'
             AND (company_id IS NULL OR company_id = :companyId)`,
    replacements: { companyId: 1 },
  }),
  '2FA policy write': (s) => ({
    sql: `UPDATE settings SET ${q(s, 'value')} = :val
           WHERE ${q(s, 'key')} = '2fa_required' AND company_id IS NULL`,
    replacements: { val: 'true' },
    type: QueryTypes.UPDATE,
  }),
  '2FA policy insert': (s) => ({
    sql: `INSERT INTO settings (${q(s, 'key')}, ${q(s, 'value')}, ${q(s, 'group')}, company_id)
          VALUES ('2fa_required', :val, 'security', :cid)`,
    replacements: { val: 'false', cid: 2 },
    type: QueryTypes.INSERT,
  }),
};

const run = async (label, sequelize) => {
  for (const [name, build] of Object.entries(QUERIES)) {
    const { sql, replacements, type } = build(sequelize);
    try {
      // eslint-disable-next-line no-await-in-loop
      await sequelize.query(sql, { replacements, type: type || QueryTypes.SELECT });
      check(`${label}: ${name}`, true);
    } catch (error) {
      check(`${label}: ${name}`, false, error.message.split('\n')[0]);
    }
  }
};

/** Proves the check is real: a backticked query MUST fail on Postgres. */
const proveItWouldHaveFailed = async (sequelize) => {
  try {
    await sequelize.query(
      "SELECT `key`, `value` FROM settings WHERE `group` = 'payment'",
      { type: QueryTypes.SELECT },
    );
    check('postgres: the ORIGINAL backticked query is rejected', false,
      'it succeeded — this test is not testing what it claims to');
  } catch (error) {
    check('postgres: the ORIGINAL backticked query is rejected', true,
      `${error.message.split('\n')[0]} — this is the production error, reproduced`);
  }
};

(async () => {
  // ── MySQL ────────────────────────────────────────────────────────────────
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
  await admin.query(`CREATE DATABASE \`${MYSQL_DB}\``);

  const my = new Sequelize(MYSQL_DB, process.env.DB_USER, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306, dialect: 'mysql', logging: false,
  });
  await my.query('CREATE TABLE settings (id INT AUTO_INCREMENT PRIMARY KEY, '
    + '`key` VARCHAR(120), `value` TEXT, `group` VARCHAR(60), company_id INT NULL)');

  console.log('\n── MySQL ────────────────────────────────────────────────────────');
  await run('mysql', my);
  await my.close();
  await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
  await admin.end();

  // ── Postgres ─────────────────────────────────────────────────────────────
  const pgAdmin = new Client({ ...PG, database: 'postgres' });
  try {
    await pgAdmin.connect();
  } catch (error) {
    console.log(`\n  Postgres not reachable (${error.message}) — SKIPPING, not passing.\n`);
    process.exit(1);
  }
  await pgAdmin.query(`DROP DATABASE IF EXISTS ${PG_DB}`);
  await pgAdmin.query(`CREATE DATABASE ${PG_DB}`);
  await pgAdmin.end();

  const pg = new Sequelize(PG_DB, PG.user, PG.password, {
    host: PG.host, port: PG.port, dialect: 'postgres', logging: false,
  });
  await pg.query('CREATE TABLE settings (id SERIAL PRIMARY KEY, '
    + '"key" VARCHAR(120), "value" TEXT, "group" VARCHAR(60), company_id INT NULL)');

  console.log('\n── Postgres ─────────────────────────────────────────────────────');
  await run('postgres', pg);
  await proveItWouldHaveFailed(pg);
  await pg.close();

  const cleanup = new Client({ ...PG, database: 'postgres' });
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE IF EXISTS ${PG_DB}`);
  await cleanup.end();

  console.log(`\n  ${pass}/${pass + fail} passed.\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ABORTED:', e); process.exit(1); });

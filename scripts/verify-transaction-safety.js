/**
 * Errors tolerated inside a transaction, proved against BOTH engines.
 *
 * The static half of this guarantee is `npm run lint:tx`, which refuses code
 * that catches a failure inside an open transaction without a savepoint. This
 * is the runtime half: it shows, on a real MySQL and a real Postgres, that
 *
 *   1. the hazard is real — after a caught failure, Postgres refuses every
 *      later statement in the transaction while MySQL carries on;
 *   2. withSavepoint() closes it on both engines;
 *   3. recording payment for two commission payouts built the same day (one
 *      shared batch reference) works on both — the production failure
 *      "current transaction is aborted" — and a replay, or a cash-book row
 *      that already exists, is a no-op rather than an error.
 *
 * MySQL comes from cred.env; Postgres from PG_* (defaults suit
 *   docker run -d -p 5433:5432 -e POSTGRES_PASSWORD=postgres postgres:16-alpine
 * ). Each engine gets its own scratch database, created and dropped here. If
 * Postgres is not reachable the run SKIPS it loudly and exits non-zero.
 *
 *   npm run verify:tx-safety
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });
const { Sequelize, QueryTypes } = require('sequelize');
const mysql = require('mysql2/promise');
const { Client } = require('pg');
const { withSavepoint, isDuplicateError } = require('../shared/src/dialect');
const store = require('../shared/src/commissionStore');

const MYSQL_DB = `${process.env.DB_NAME || 'realto'}_verify_tx`;
const PG = {
  host: process.env.PG_HOST || 'localhost',
  port: Number(process.env.PG_PORT || 5433),
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
};
const PG_DB = 'realx8_verify_tx';

const results = [];
const check = (engine, label, ok, detail = '') => results.push({ engine, label, ok: Boolean(ok), detail });

const ddl = (pg) => {
  const id = pg ? 'SERIAL PRIMARY KEY' : 'INT AUTO_INCREMENT PRIMARY KEY';
  const ts = pg ? 'TIMESTAMP NULL' : 'DATETIME NULL';
  return [
    `CREATE TABLE probe (id ${id}, ref VARCHAR(64) NOT NULL UNIQUE)`,
    `CREATE TABLE commission_entitlements (id ${id}, company_id INT, deal_ref VARCHAR(64), realtor_id INT,
       released_minor BIGINT NOT NULL DEFAULT 0, paid_minor BIGINT NOT NULL DEFAULT 0,
       status VARCHAR(32), updated_at ${ts})`,
    `CREATE TABLE commission_payouts (id ${id}, company_id INT, batch_ref VARCHAR(64), realtor_id INT,
       gross_minor BIGINT, deductions_minor BIGINT DEFAULT 0, recovered_minor BIGINT DEFAULT 0, net_minor BIGINT,
       status VARCHAR(32), paid_at ${ts}, payment_reference VARCHAR(191), updated_at ${ts})`,
    `CREATE TABLE commission_payout_lines (id ${id}, payout_id INT, entitlement_id INT, realtor_id INT,
       deal_ref VARCHAR(64), amount_minor BIGINT)`,
    `CREATE TABLE commission_ledger_entries (id ${id}, company_id INT, entitlement_id INT, realtor_id INT,
       deal_ref VARCHAR(64), entry_type VARCHAR(32), amount_minor BIGINT, description VARCHAR(255),
       idempotency_key VARCHAR(191) NOT NULL UNIQUE, metadata TEXT, created_by INT, created_at ${ts})`,
    `CREATE TABLE transactions (id ${id}, user_id INT, ${pg ? '"type"' : '`type`'} VARCHAR(64), entry_type VARCHAR(16),
       amount DECIMAL(14,2), description VARCHAR(255), payment_method VARCHAR(32), status VARCHAR(32),
       reference VARCHAR(191), company_id INT, created_at ${ts},
       CONSTRAINT ux_tx_company_reference UNIQUE (company_id, reference))`,
  ];
};

const run = async (sequelize, engine) => {
  const pg = engine === 'postgres';
  for (const sql of ddl(pg)) await sequelize.query(sql); // eslint-disable-line no-await-in-loop
  const count = async (table, where = '1 = 1') => Number((await sequelize.query(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, { type: QueryTypes.SELECT },
  ))[0].n);

  // 1. The hazard, with no savepoint. Postgres must refuse the next
  //    statement; MySQL must carry on. Asserted per engine so a change in
  //    either engine's behaviour is noticed.
  let afterwards = null;
  try {
    await sequelize.transaction(async (transaction) => {
      await sequelize.query("INSERT INTO probe (ref) VALUES ('a')", { transaction });
      await sequelize.query("INSERT INTO probe (ref) VALUES ('a')", { transaction })
        .catch((error) => { if (!isDuplicateError(error)) throw error; });
      await sequelize.query("INSERT INTO probe (ref) VALUES ('b')", { transaction });
      afterwards = 'continued';
      throw new Error('rollback-on-purpose');
    });
  } catch (error) {
    if (afterwards !== 'continued') afterwards = error.message;
  }
  check(engine, 'without a savepoint: a caught duplicate poisons Postgres only',
    pg ? /aborted/i.test(String(afterwards)) : afterwards === 'continued', String(afterwards));

  // 2. The same with withSavepoint: both engines carry on and commit both rows.
  await sequelize.query('DELETE FROM probe');
  await sequelize.transaction(async (transaction) => {
    await sequelize.query("INSERT INTO probe (ref) VALUES ('a')", { transaction });
    await withSavepoint(sequelize, transaction, (sp) => sequelize.query(
      "INSERT INTO probe (ref) VALUES ('a')", { transaction: sp },
    )).catch((error) => { if (!isDuplicateError(error)) throw error; });
    await sequelize.query("INSERT INTO probe (ref) VALUES ('b')", { transaction });
  });
  check(engine, 'withSavepoint: the transaction carries on and commits', await count('probe') === 2);

  // 3. Two payouts built the same day, one shared batch reference.
  const batch = 'PAYOUT-2026-10-01';
  for (const [realtor, amount] of [[12, 100000000], [13, 460000000]]) {
    // eslint-disable-next-line no-await-in-loop
    await sequelize.query(`INSERT INTO commission_entitlements (company_id, deal_ref, realtor_id, released_minor, paid_minor, status)
      VALUES (1, :deal, :realtor, :amount, 0, 'RELEASED')`, { replacements: { deal: `DEAL-${realtor}`, realtor, amount } });
    // eslint-disable-next-line no-await-in-loop
    await sequelize.query(`INSERT INTO commission_payouts (company_id, batch_ref, realtor_id, gross_minor, net_minor, status)
      VALUES (1, :batch, :realtor, :amount, :amount, 'APPROVED')`, { replacements: { batch, realtor, amount } });
  }
  const ents = await sequelize.query('SELECT id, realtor_id FROM commission_entitlements ORDER BY id', { type: QueryTypes.SELECT });
  const pays = await sequelize.query('SELECT id, realtor_id, net_minor FROM commission_payouts ORDER BY id', { type: QueryTypes.SELECT });
  for (const [i, payout] of pays.entries()) {
    // eslint-disable-next-line no-await-in-loop
    await sequelize.query(`INSERT INTO commission_payout_lines (payout_id, entitlement_id, realtor_id, deal_ref, amount_minor)
      VALUES (:p, :e, :r, :d, :a)`, { replacements: { p: payout.id, e: ents[i].id, r: payout.realtor_id, d: `DEAL-${payout.realtor_id}`, a: payout.net_minor } });
  }

  const outcomes = [];
  for (const payout of pays) {
    try {
      // eslint-disable-next-line no-await-in-loop
      outcomes.push(await store.markPayoutPaid(sequelize, payout.id, { reference: null, userId: 1 }));
    } catch (error) {
      outcomes.push({ error: error.message });
    }
  }
  check(engine, 'two same-day payouts both record payment',
    outcomes.every((o) => o.paid === 1) && await count('commission_payouts', "status = 'PAID'") === 2,
    JSON.stringify(outcomes));
  const refs = (await sequelize.query('SELECT reference FROM transactions ORDER BY id', { type: QueryTypes.SELECT })).map((r) => r.reference);
  check(engine, 'each payout gets its own cash-book row', refs.length === 2 && new Set(refs).size === 2, JSON.stringify(refs));
  check(engine, 'each entitlement is marked paid in full',
    await count('commission_entitlements', "status = 'PAID' AND paid_minor = released_minor") === 2);

  // 4. A replay of a paid payout is refused cleanly, not an error.
  const replay = await store.markPayoutPaid(sequelize, pays[0].id, { userId: 1 }).catch((error) => ({ error: error.message }));
  check(engine, 'paying an already-paid payout again is a clean refusal', /not_approved/.test(replay.skipped || ''), JSON.stringify(replay));

  // 5. A cash-book row already there (an interrupted earlier attempt): tolerated.
  await sequelize.query(`UPDATE commission_payouts SET status = 'APPROVED' WHERE id = :id`, { replacements: { id: pays[1].id } });
  await sequelize.query(`UPDATE commission_entitlements SET status = 'RELEASED', paid_minor = 0 WHERE id = :id`, { replacements: { id: ents[1].id } });
  await sequelize.query('DELETE FROM commission_ledger_entries WHERE entitlement_id = :id', { replacements: { id: ents[1].id } });
  const again = await store.markPayoutPaid(sequelize, pays[1].id, { userId: 1 }).catch((error) => ({ error: error.message }));
  check(engine, 'an existing cash-book row is tolerated, not fatal',
    again.paid === 1 && await count('transactions') === 2, JSON.stringify(again));
};

(async () => {
  // ── MySQL ─────────────────────────────────────────────────────────────────
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
  await admin.query(`CREATE DATABASE \`${MYSQL_DB}\``);
  const my = new Sequelize(MYSQL_DB, process.env.DB_USER, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306, dialect: 'mysql', logging: false,
  });
  try { await run(my, 'mysql'); } finally {
    await my.close();
    await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
    await admin.end();
  }

  // ── Postgres ──────────────────────────────────────────────────────────────
  let pgReachable = true;
  try {
    const probe = new Client({ ...PG, database: 'postgres', connectionTimeoutMillis: 4000 });
    await probe.connect();
    await probe.query(`DROP DATABASE IF EXISTS ${PG_DB}`);
    await probe.query(`CREATE DATABASE ${PG_DB}`);
    await probe.end();
  } catch (error) {
    pgReachable = false;
    console.log(`\n\x1b[33m  Postgres not reachable at ${PG.host}:${PG.port} — ${error.message}`);
    console.log('  Skipping the Postgres half — NOT counting it as passing.\x1b[0m\n');
  }
  if (pgReachable) {
    const pg = new Sequelize(PG_DB, PG.user, PG.password, {
      host: PG.host, port: PG.port, dialect: 'postgres', logging: false,
    });
    try { await run(pg, 'postgres'); } finally {
      await pg.close();
      const drop = new Client({ ...PG, database: 'postgres' });
      await drop.connect();
      await drop.query(`DROP DATABASE IF EXISTS ${PG_DB}`);
      await drop.end();
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const labels = [...new Set(results.map((r) => r.label))];
  const width = Math.max(...labels.map((l) => l.length));
  console.log(`\n  ${' '.repeat(width)}   mysql   postgres`);
  console.log(`  ${'─'.repeat(width + 20)}`);
  labels.forEach((label) => {
    const mark = (engine) => {
      const r = results.find((x) => x.label === label && x.engine === engine);
      return r ? (r.ok ? '\x1b[32m  ✓   \x1b[0m' : '\x1b[31m  ✗   \x1b[0m') : '\x1b[33m  –   \x1b[0m';
    };
    console.log(`  ${label.padEnd(width)}  ${mark('mysql')}  ${mark('postgres')}`);
    results.filter((r) => r.label === label && !r.ok).forEach((r) => console.log(`  ${' '.repeat(width)}     ${r.engine}: ${r.detail}`));
  });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n  ${failed ? '\x1b[31m' : '\x1b[32m'}${results.length - failed}/${results.length} checks passed\x1b[0m`
    + (pgReachable ? '' : ' \x1b[33m(postgres skipped)\x1b[0m') + '\n');
  process.exit(failed === 0 && pgReachable ? 0 : 1);
})().catch((error) => {
  console.error('\n\x1b[31mThe verification itself failed:\x1b[0m', error);
  process.exit(1);
});

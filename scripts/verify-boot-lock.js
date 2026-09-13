/**
 * Does the migration lock actually stop two boots overlapping?
 *
 * The failures it exists for are non-deterministic — a deadlock here, a dropped
 * constraint there — so "it booted fine" proves nothing. What can be proved is
 * the property underneath: two holders of the lock never overlap in time, on
 * either engine.
 *
 * Runs against a scratch database on each engine it can reach.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { Sequelize } = require('sequelize');
const mysql = require('mysql2/promise');
const { Client } = require('pg');
const { withBootLock } = require('../shared/src/bootLock');

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

const quiet = { warn: () => {}, info: () => {}, error: () => {} };

/**
 * Surfaces the one message that would invalidate a contention result: the lock
 * could not be taken, so the run proceeded unlocked and any overlap it sees
 * says nothing about whether locking works.
 */
let degraded = 0;
const noticeUnlocked = {
  info: () => {},
  error: () => {},
  warn: (message) => { degraded += 1; console.log(`        (lock unavailable) ${message}`); },
};
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Two workers take the lock at the same moment and each records when it entered
 * and left the critical section. If the lock works, the intervals are disjoint.
 */
const runContention = async (makeConnection, engine) => {
  const HOLD_MS = 400;
  const spans = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  degraded = 0;

  const worker = async (sequelize, id) => {
    try {
      await withBootLock(sequelize, async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        const from = Date.now();
        await sleep(HOLD_MS);
        spans.push({ id, from, to: Date.now() });
        concurrent -= 1;
      }, { logger: noticeUnlocked, timeoutSeconds: 30 });
    } catch (error) {
      console.log(`        worker ${id} failed: ${error.message}`);
    }
  };

  /**
   * Connections are opened and warmed BEFORE the contention starts.
   *
   * withBootLock degrades to running unlocked when it cannot take the lock —
   * which is correct behaviour and indistinguishable, from the outside, from
   * the lock not working. A worker that was still completing its TCP handshake
   * when the others were already inside would take that path and fail the test
   * for a reason that has nothing to do with locking.
   */
  const connections = ['a', 'b', 'c'].map(() => makeConnection());
  await Promise.all(connections.map((sequelize) => sequelize.authenticate()));

  await Promise.all(connections.map((sequelize, i) => worker(sequelize, 'abc'[i])));
  await Promise.all(connections.map((sequelize) => sequelize.close()));

  check(`${engine}: the lock was actually available to every worker`,
    degraded === 0, degraded ? `${degraded} worker(s) ran unlocked — result below is meaningless` : '');

  check(`${engine}: three concurrent boots never run together`,
    maxConcurrent === 1, `highest overlap observed: ${maxConcurrent}`);

  spans.sort((x, y) => x.from - y.from);
  const disjoint = spans.every((span, i) => i === 0 || span.from >= spans[i - 1].to);
  check(`${engine}: their critical sections are disjoint in time`,
    disjoint,
    spans.map((s) => `${s.id}:${s.from % 100000}-${s.to % 100000}`).join('  '));

  check(`${engine}: all three still completed`, spans.length === 3, `${spans.length}/3`);
};

/** The lock must not stop a single boot, nor leak into the next one. */
const runSequential = async (makeConnection, engine) => {
  const sequelize = makeConnection();
  try {
    const first = await withBootLock(sequelize, async () => 'first', { logger: quiet });
    const second = await withBootLock(sequelize, async () => 'second', { logger: quiet });
    check(`${engine}: the lock is released between boots`,
      first === 'first' && second === 'second',
      'a lock that outlived its boot would hang the next one');

    let thrown = null;
    try {
      await withBootLock(sequelize, async () => { throw new Error('migration blew up'); }, { logger: quiet });
    } catch (error) {
      thrown = error.message;
    }
    check(`${engine}: a failing migration still releases the lock`,
      thrown === 'migration blew up',
      'the error must propagate — a swallowed boot failure is worse than a crash');

    const after = await withBootLock(sequelize, async () => 'recovered', { logger: quiet });
    check(`${engine}: ...and the next boot can still take it`, after === 'recovered');
  } finally {
    await sequelize.close();
  }
};

(async () => {
  // ── MySQL ─────────────────────────────────────────────────────────────────
  const MYSQL_DB = `${process.env.DB_NAME || 'realto'}_verify_bootlock`;
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
  await admin.query(`CREATE DATABASE \`${MYSQL_DB}\``);

  const makeMysql = () => new Sequelize(MYSQL_DB, process.env.DB_USER, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306, dialect: 'mysql', logging: false,
  });

  console.log('\n── MySQL ───────────────────────────────────────────────────────');
  await runContention(makeMysql, 'mysql');
  await runSequential(makeMysql, 'mysql');

  await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
  await admin.end();

  // ── Postgres ──────────────────────────────────────────────────────────────
  const PG = {
    host: process.env.PG_HOST || 'localhost',
    port: Number(process.env.PG_PORT || 5433),
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'postgres',
    database: process.env.PG_DATABASE || 'realx8test',
  };

  let reachable = true;
  try {
    const probe = new Client({ ...PG, connectionTimeoutMillis: 4000 });
    await probe.connect();
    await probe.end();
  } catch (error) {
    reachable = false;
    console.log(`\n\x1b[33m  Postgres not reachable at ${PG.host}:${PG.port} — ${error.message}\x1b[0m`);
    console.log('  The advisory lock is spelled differently there, so this half is the half');
    console.log('  worth running. Start one with:');
    console.log('    docker run -d --name realx8-pg -e POSTGRES_PASSWORD=postgres \\');
    console.log('      -e POSTGRES_DB=realx8test -p 5433:5432 postgres:16-alpine\n');
  }

  if (reachable) {
    const makePg = () => new Sequelize(PG.database, PG.user, PG.password, {
      host: PG.host, port: PG.port, dialect: 'postgres', logging: false,
    });
    console.log('\n── Postgres ────────────────────────────────────────────────────');
    await runContention(makePg, 'postgres');
    await runSequential(makePg, 'postgres');
  }

  console.log('\n── Results ─────────────────────────────────────────────────────\n');
  console.log(`  ${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass}/${pass + fail} checks passed.\x1b[0m\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\n\x1b[31mThe verification itself failed:\x1b[0m', error);
  process.exit(1);
});

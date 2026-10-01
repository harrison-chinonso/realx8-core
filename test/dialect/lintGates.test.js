const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const { findingsFor, scan } = require('../../scripts/lint-transaction-safety');
const { RULES } = require('../../scripts/lint-sql-dialect');

/**
 * The gates that keep MySQL-only and Postgres-only behaviour out of the code.
 *
 * Development runs on MySQL; production runs on Postgres. Each engine accepts
 * things the other refuses, so a query can pass every local run and fail for
 * the first time in front of a customer — recording a commission payment did
 * exactly that ("current transaction is aborted"). These tests fail the build
 * when either linter finds anything, and prove each rule still catches the
 * shape it exists for, so a change that quietly blinds a rule fails too.
 */

const ROOT = path.join(__dirname, '..', '..');

test('the whole codebase passes the transaction-safety lint', () => {
  const findings = scan();
  assert.deepEqual(
    findings.map((f) => `${f.file}:${f.line} ${f.kind}`),
    [],
    'a failure caught inside an open transaction aborts it on Postgres — wrap the tolerated '
      + 'statement in withSavepoint() from shared/src/dialect, or mark it `// tx-safe: <reason>`',
  );
});

test('the whole codebase passes the SQL dialect lint', () => {
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lint-sql-dialect.js')], {
    cwd: ROOT, encoding: 'utf8',
  });
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  assert.equal(run.status, 0, run.stdout.replace(ansi, '').slice(-3000));
});

// ── transaction safety: the lint catches what it is for ─────────────────────

const flagged = (source) => findingsFor(source, 'fixture.js').filter((f) => f.kind !== 'parse-error');

test('flags a .catch that swallows a query run in the caller\'s transaction', () => {
  const findings = flagged(`
    const run = async (sequelize, transaction) => {
      await sequelize.query('INSERT INTO t VALUES (1)', { transaction }).catch(() => {});
    };`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, '.catch swallows');
});

test('flags a conditional rethrow — the "tolerate a duplicate" shape', () => {
  const findings = flagged(`
    const run = async (sequelize, transaction) => {
      try {
        await sequelize.query('INSERT INTO t VALUES (1)', { transaction });
      } catch (error) {
        if (!isDuplicateError(error)) throw error;
      }
    };`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'try/catch swallows');
});

test('flags a model call given a transaction, not only raw queries', () => {
  const findings = flagged(`
    const run = async (Model, transaction) => {
      try { return await Model.create({ a: 1 }, { transaction }); } catch { return null; }
    };`);
  assert.equal(findings.length, 1);
});

test('passes the same call inside withSavepoint', () => {
  assert.deepEqual(flagged(`
    const run = async (sequelize, transaction) => {
      await withSavepoint(sequelize, transaction, (sp) => sequelize.query('INSERT INTO t VALUES (1)', { transaction: sp }))
        .catch(() => {});
    };`), []);
});

test('passes a catch that always rethrows', () => {
  assert.deepEqual(flagged(`
    const run = async (sequelize, transaction) => {
      try { await sequelize.query('x', { transaction }); } catch (error) { log(error); throw error; }
    };`), []);
});

test('passes a catch that rolls the transaction back', () => {
  assert.deepEqual(flagged(`
    const run = async (sequelize) => {
      const transaction = await sequelize.transaction();
      try { await sequelize.query('x', { transaction }); await transaction.commit(); }
      catch (error) { await transaction.rollback(); console.error(error.message); }
    };`), []);
});

test('passes a try/catch around a whole sequelize.transaction()', () => {
  assert.deepEqual(flagged(`
    const run = async (sequelize) => {
      try {
        await sequelize.transaction(async (transaction) => {
          await sequelize.query('x', { transaction });
        });
      } catch { return null; }
    };`), []);
});

test('passes a call with no transaction, and an explicit `transaction: null`', () => {
  assert.deepEqual(flagged(`
    const run = async (sequelize) => {
      await sequelize.query('x').catch(() => []);
      await sequelize.query('y', { transaction: null }).catch(() => []);
    };`), []);
});

test('honours a `tx-safe:` acknowledgement', () => {
  assert.deepEqual(flagged(`
    const run = async (sequelize, transaction) => {
      try {
        await sequelize.query('x', { transaction });
        // tx-safe: nothing runs on this transaction after the catch
      } catch { return null; }
    };`), []);
});

// ── SQL dialect: the new rules catch what they are for ──────────────────────

const rule = (id) => {
  const found = RULES.find((r) => r.id === id);
  assert.ok(found, `rule ${id} exists`);
  return found;
};

test('postgres-only syntax is caught (it breaks MySQL, where development runs)', () => {
  const { test: matches } = rule('postgres-only-syntax');
  [
    'SELECT * FROM users WHERE name ILIKE :q',
    'SELECT id::text FROM t',
    'INSERT INTO t (a) VALUES (1) RETURNING id',
    'INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO NOTHING',
    'SELECT string_agg(name, \',\') FROM t',
    "SELECT date_trunc('month', created_at) FROM t",
    "SELECT * FROM t WHERE created_at > NOW() - INTERVAL '30 days'",
    'SELECT * FROM t WHERE a IS NOT DISTINCT FROM :b',
    'SELECT * FROM t ORDER BY a NULLS LAST',
  ].forEach((sql) => assert.equal(matches(sql), true, sql));
  [
    'SELECT * FROM users WHERE id = :id',
    'SELECT CAST(id AS CHAR) FROM t',
    'SELECT * FROM t WHERE created_at > :since',
  ].forEach((sql) => assert.equal(matches(sql), false, sql));
});

test('LIMIT inside an IN subquery is caught (MySQL refuses it)', () => {
  const { test: matches } = rule('limit-inside-in-subquery');
  assert.equal(matches('SELECT * FROM a WHERE id IN (SELECT id FROM b ORDER BY id LIMIT 5)'), true);
  assert.equal(matches('SELECT * FROM a WHERE id IN (SELECT id FROM b)'), false);
  assert.equal(matches('SELECT * FROM a ORDER BY id LIMIT 5'), false);
});

test('a case-sensitive LIKE on a search term is flagged for review', () => {
  const { test: matches, severity } = rule('case-sensitive-like-search');
  assert.equal(severity, 'warn');
  assert.equal(matches('SELECT * FROM users WHERE name LIKE :search'), true);
  assert.equal(matches('SELECT * FROM users WHERE LOWER(name) LIKE LOWER(:search)'), false);
});

test('the existing MySQL-only rules still fire', () => {
  assert.equal(rule('mysql-only-function').test('SELECT IFNULL(a, 0) FROM t'), true);
  assert.equal(rule('mysql-only-statement').test('INSERT IGNORE INTO t VALUES (1)'), true);
  assert.equal(rule('backtick-identifier').test('SELECT `type` FROM t'), true);
  assert.equal(rule('null-safe-equality').test('SELECT * FROM t WHERE a <=> :b'), true);
  assert.equal(rule('boolean-compared-to-integer').test('SELECT * FROM users WHERE is_active = 1'), true);
});

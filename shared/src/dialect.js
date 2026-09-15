const { QueryTypes, Op } = require('sequelize');

/**
 * The handful of places MySQL and PostgreSQL genuinely differ, in one module.
 *
 * This application is developed against MySQL and deployed against Postgres.
 * That is a difficult arrangement, because the two disagree in ways that do not
 * announce themselves: several of the differences below produce a SILENT no-op
 * on one engine rather than an error, so a migration appears to succeed and the
 * constraint it was supposed to create simply does not exist.
 *
 * The reported symptom that led here — `invalid input value for enum
 * enum_commision_status: "pending"` — is exactly that shape. A migration
 * written as `SHOW COLUMNS` + `ALTER TABLE ... MODIFY COLUMN` runs on MySQL and
 * throws on Postgres, where the throw was caught and treated as "table does not
 * exist yet", so the enum was never migrated and the rows were never moved.
 *
 * ── The rule this module exists to enforce ───────────────────────────────────
 *
 * Raw SQL that differs between the two must go through here, so the difference
 * is stated once and tested once, rather than being rediscovered as a
 * production error per call site.
 */

const isPostgres = (sequelize) => sequelize.getDialect() === 'postgres';

/**
 * True when `sequelize` is connected to MySQL. Used to gate the legacy,
 * MySQL-only raw-SQL migrations in each service's `migrations/` folder — they
 * exist purely to evolve an EXISTING MySQL installation forward, and have
 * nothing to do on a fresh database of any dialect, Postgres included, where
 * `sequelize.sync()` already creates the correct schema from the current
 * models.
 *
 * That gate is the right answer for a migration whose only job is to move an
 * old MySQL database forward. It is NOT the right answer for a migration that
 * also has to run against the live Postgres one — those belong on the helpers
 * below, which speak both engines rather than skipping one.
 */
const isMySQL = (sequelize) => sequelize.getDialect() === 'mysql';

/** Spelling kept for callers that reached for the other capitalisation. */
const isMysql = isMySQL;

/**
 * Quotes an identifier the way this engine expects.
 *
 * MySQL uses backticks, Postgres uses double quotes, and each REJECTS the
 * other's. This matters more than it looks: several tables here have columns
 * called `key`, `value` and `group`, all of which are reserved words that must
 * be quoted to be read at all.
 */
const quoteIdent = (sequelize, identifier) => {
  const safe = String(identifier).replace(/["`]/g, '');
  return isPostgres(sequelize) ? `"${safe}"` : `\`${safe}\``;
};

/** Convenience for a query written once and quoted per engine. */
const q = quoteIdent;

/**
 * Whether an error is "that unique key is already taken".
 *
 * MySQL reports ER_DUP_ENTRY, Postgres reports SQLSTATE 23505. Code that
 * recognises only the MySQL one treats a Postgres duplicate as an unexpected
 * failure — which, in the reference allocator, turns a retryable collision into
 * a 500 the user sees.
 */
const isDuplicateError = (error) => {
  if (!error) return false;
  if (error.name === 'SequelizeUniqueConstraintError') return true;
  const codes = [error.original?.code, error.parent?.code, error.code];
  return codes.some((code) => code === 'ER_DUP_ENTRY' || code === '23505');
};

/**
 * A table's columns, as a Map of name to type.
 *
 * `SHOW COLUMNS` is MySQL-only. information_schema.columns is in both, so it is
 * what this uses — and it returns an EMPTY map for a table that does not exist,
 * which callers must distinguish from "could not tell", hence null on error.
 */
/**
 * "That index already exists", which is NOT the same as a duplicate row.
 *
 * isDuplicateError above catches a unique-constraint violation — two rows with
 * the same key. This catches a DDL collision: creating an index whose name is
 * taken. They are different codes, and conflating them means a migration either
 * swallows a real data conflict or crashes a boot over work already done.
 *
 * MySQL raises ER_DUP_KEYNAME (1061); Postgres raises 42P07, which it uses for
 * any relation that already exists, indexes included. The message match is a
 * fallback for drivers that surface neither.
 */
const isDuplicateIndexError = (error) => {
  if (!error) return false;
  const codes = [error.original?.code, error.parent?.code, error.code];
  if (codes.some((code) => code === 'ER_DUP_KEYNAME' || code === '42P07')) return true;
  const numbers = [error.original?.errno, error.parent?.errno];
  if (numbers.some((errno) => errno === 1061)) return true;
  return /duplicate key name|already exists/i.test(error.message || '');
};

const columnsOf = async (sequelize, table) => {
  /**
   * The column list differs, not just the schema function.
   *
   * `udt_name` exists only in Postgres and `COLUMN_TYPE` only in MySQL, so a
   * single query naming both throws on each engine in turn — which the catch
   * below then reported as "this table does not exist", the precise shape of
   * failure this module was written to stop.
   */
  const sql = isPostgres(sequelize)
    ? `SELECT column_name, udt_name AS column_type
         FROM information_schema.columns
        WHERE table_schema = CURRENT_SCHEMA() AND table_name = :table`
    : `SELECT COLUMN_NAME AS column_name, COLUMN_TYPE AS column_type
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = :table`;
  try {
    const rows = await sequelize.query(sql, { replacements: { table }, type: QueryTypes.SELECT });
    if (!rows.length) return null; // no such table
    return new Map(rows.map((row) => [row.column_name, row.column_type]));
  } catch {
    return null;
  }
};

const tableExists = async (sequelize, table) => (await columnsOf(sequelize, table)) !== null;

/**
 * The values an enum column currently accepts.
 *
 * Postgres models an enum as a TYPE shared by every column that uses it, and
 * its values live in pg_enum. MySQL stores the list inline in the column
 * definition. Returns [] when the column is not an enum at all.
 */
const enumValues = async (sequelize, table, column) => {
  if (isPostgres(sequelize)) {
    const rows = await sequelize.query(
      `SELECT e.enumlabel AS value
         FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
         JOIN information_schema.columns c
           ON c.udt_name = t.typname
        WHERE c.table_schema = CURRENT_SCHEMA()
          AND c.table_name = :table
          AND c.column_name = :column
        ORDER BY e.enumsortorder`,
      { replacements: { table, column }, type: QueryTypes.SELECT },
    );
    return rows.map((row) => row.value);
  }

  const rows = await sequelize.query(
    `SELECT COLUMN_TYPE AS type
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = :table AND column_name = :column`,
    { replacements: { table, column }, type: QueryTypes.SELECT },
  );
  const definition = rows[0]?.type || rows[0]?.TYPE || '';
  const match = /^enum\((.*)\)$/i.exec(String(definition));
  if (!match) return [];
  return match[1].split(',').map((part) => part.trim().replace(/^'|'$/g, ''));
};

/**
 * The name of the Postgres TYPE backing an enum column.
 *
 * Needed because the type is the thing that has to be altered, and its name is
 * not always `enum_<table>_<column>` — a database restored from an older schema
 * can carry a type named after a table that has since been renamed, which is
 * why this is looked up rather than constructed.
 */
const enumTypeName = async (sequelize, table, column) => {
  const rows = await sequelize.query(
    `SELECT udt_name AS name
       FROM information_schema.columns
      WHERE table_schema = CURRENT_SCHEMA() AND table_name = :table AND column_name = :column`,
    { replacements: { table, column }, type: QueryTypes.SELECT },
  );
  return rows[0]?.name || null;
};

/**
 * Makes an enum column accept every value in `values`.
 *
 * ── The asymmetry that causes the production error ───────────────────────────
 *
 * MySQL rewrites the column and is done. Postgres cannot: a value can be ADDED
 * to a type, but the type cannot be narrowed while rows reference it, and until
 * Postgres 12 a value could not be added inside a transaction at all.
 *
 * So this only ever WIDENS. Removing a retired value is a separate, deliberate
 * act — see `narrowEnum` — because it can only be done once no row uses it.
 */
const widenEnum = async (sequelize, table, column, values, { defaultValue } = {}) => {
  const existing = await enumValues(sequelize, table, column);
  const missing = values.filter((value) => !existing.includes(value));
  if (!missing.length) return [];

  if (isPostgres(sequelize)) {
    const type = await enumTypeName(sequelize, table, column);
    if (!type) return [];
    // One statement per value, and each committed on its own: ADD VALUE cannot
    // run inside a transaction block on older servers, and IF NOT EXISTS makes
    // a re-run harmless.
    for (const value of missing) {
      // eslint-disable-next-line no-await-in-loop
      await sequelize.query(`ALTER TYPE ${quoteIdent(sequelize, type)} ADD VALUE IF NOT EXISTS :value`, {
        replacements: { value },
      });
    }
    return missing;
  }

  const all = [...existing, ...missing];
  const list = all.map((value) => `'${String(value).replace(/'/g, "''")}'`).join(',');
  const suffix = defaultValue ? ` DEFAULT '${String(defaultValue).replace(/'/g, "''")}'` : '';
  await sequelize.query(
    `ALTER TABLE ${quoteIdent(sequelize, table)} MODIFY COLUMN ${quoteIdent(sequelize, column)} ENUM(${list})${suffix}`,
  );
  return missing;
};

/**
 * Restricts an enum column to exactly `values`.
 *
 * Only safe once nothing references the values being dropped, so the caller is
 * expected to have moved the rows first. On Postgres this means building a new
 * type and swapping it, which is why it is not done casually on every boot.
 */
const narrowEnum = async (sequelize, table, column, values, { defaultValue } = {}) => {
  const existing = await enumValues(sequelize, table, column);
  const doomed = existing.filter((value) => !values.includes(value));
  if (!doomed.length) return [];

  const list = values.map((value) => `'${String(value).replace(/'/g, "''")}'`).join(',');

  if (isPostgres(sequelize)) {
    const type = await enumTypeName(sequelize, table, column);
    if (!type) return [];
    const temp = `${type}_new`;
    const T = (name) => quoteIdent(sequelize, name);
    const col = quoteIdent(sequelize, column);
    const tbl = quoteIdent(sequelize, table);
    await sequelize.query(`DROP TYPE IF EXISTS ${T(temp)}`);
    await sequelize.query(`CREATE TYPE ${T(temp)} AS ENUM (${list})`);
    await sequelize.query(`ALTER TABLE ${tbl} ALTER COLUMN ${col} DROP DEFAULT`);
    await sequelize.query(
      `ALTER TABLE ${tbl} ALTER COLUMN ${col} TYPE ${T(temp)} USING ${col}::text::${T(temp)}`,
    );
    await sequelize.query(`DROP TYPE ${T(type)}`);
    await sequelize.query(`ALTER TYPE ${T(temp)} RENAME TO ${T(type).replace(/"/g, '')}`);
    if (defaultValue) {
      await sequelize.query(`ALTER TABLE ${tbl} ALTER COLUMN ${col} SET DEFAULT '${defaultValue}'`);
    }
    return doomed;
  }

  const suffix = defaultValue ? ` DEFAULT '${String(defaultValue).replace(/'/g, "''")}'` : '';
  await sequelize.query(
    `ALTER TABLE ${quoteIdent(sequelize, table)} MODIFY COLUMN ${quoteIdent(sequelize, column)} ENUM(${list})${suffix}`,
  );
  return doomed;
};

/**
 * Whether a named index exists.
 *
 * MySQL exposes indexes through information_schema.statistics, which Postgres
 * does not have at all — a query against it throws, and the surrounding
 * try/catch turns that into "no index", so the index gets created every boot or
 * never at all depending on which way the caller guessed.
 */
const indexExists = async (sequelize, table, name) => {
  const sql = isPostgres(sequelize)
    ? `SELECT 1 FROM pg_indexes WHERE schemaname = CURRENT_SCHEMA() AND tablename = :table AND indexname = :name LIMIT 1`
    : `SELECT 1 FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = :table AND index_name = :name LIMIT 1`;
  const rows = await sequelize.query(sql, {
    replacements: { table, name }, type: QueryTypes.SELECT,
  });
  return rows.length > 0;
};

/** Adds a unique index, spelled the way each engine wants it. */
const addUniqueIndex = async (sequelize, table, columns, name) => {
  const cols = columns.map((column) => quoteIdent(sequelize, column)).join(', ');
  const sql = isPostgres(sequelize)
    ? `CREATE UNIQUE INDEX ${quoteIdent(sequelize, name)} ON ${quoteIdent(sequelize, table)} (${cols})`
    : `ALTER TABLE ${quoteIdent(sequelize, table)} ADD UNIQUE INDEX ${quoteIdent(sequelize, name)} (${cols})`;
  await sequelize.query(sql);
};

/**
 * Drops an index, including one that is really a CONSTRAINT.
 *
 * Postgres backs a UNIQUE constraint with an index that cannot be dropped on
 * its own — `DROP INDEX` fails with "constraint X requires it", and the index
 * survives. That matters here: the index being dropped is the old GLOBAL
 * uniqueness on document numbers, so leaving it in place keeps every company
 * drawing from one sequence, which is the bug the per-company index exists to
 * fix. MySQL has no such distinction.
 */
const dropIndex = async (sequelize, table, name) => {
  if (!isPostgres(sequelize)) {
    await sequelize.query(
      `ALTER TABLE ${quoteIdent(sequelize, table)} DROP INDEX ${quoteIdent(sequelize, name)}`,
    );
    return;
  }

  const constraints = await sequelize.query(
    `SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = CURRENT_SCHEMA() AND table_name = :table AND constraint_name = :name`,
    { replacements: { table, name }, type: QueryTypes.SELECT },
  );

  if (constraints.length) {
    await sequelize.query(
      `ALTER TABLE ${quoteIdent(sequelize, table)} DROP CONSTRAINT ${quoteIdent(sequelize, name)}`,
    );
    return;
  }
  await sequelize.query(`DROP INDEX IF EXISTS ${quoteIdent(sequelize, name)}`);
};

/**
 * Whether a named CONSTRAINT exists.
 *
 * Separate from indexExists because the two are different objects: a UNIQUE
 * constraint is backed by an index, but a CHECK constraint has no index at all
 * and never appears in pg_indexes or information_schema.statistics.
 */
const constraintExists = async (sequelize, table, name) => {
  const rows = await sequelize.query(
    `SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = ${isPostgres(sequelize) ? 'CURRENT_SCHEMA()' : 'DATABASE()'}
        AND table_name = :table AND constraint_name = :name LIMIT 1`,
    { replacements: { table, name }, type: QueryTypes.SELECT },
  );
  return rows.length > 0;
};

/**
 * Adds a CHECK constraint.
 *
 * Supported by both engines, with one caveat worth knowing: MySQL only began
 * ENFORCING them in 8.0.16 — before that it parsed the clause and silently
 * ignored it, which is the worst of both worlds because the constraint appears
 * to exist. `checksAreEnforced` below is how a caller finds out.
 *
 * The expression is passed in already spelled for this engine, because the two
 * differ on more than syntax: comparing an enum column to a string literal
 * needs an explicit ::text cast in Postgres and none in MySQL.
 */
const addCheckConstraint = async (sequelize, table, name, expression) => {
  await sequelize.query(
    `ALTER TABLE ${quoteIdent(sequelize, table)}
     ADD CONSTRAINT ${quoteIdent(sequelize, name)} CHECK (${expression})`,
  );
};

const dropConstraint = async (sequelize, table, name) => {
  await sequelize.query(
    `ALTER TABLE ${quoteIdent(sequelize, table)} DROP CONSTRAINT ${quoteIdent(sequelize, name)}`,
  );
};

/**
 * Whether CHECK constraints are actually enforced here.
 *
 * Postgres always. MySQL from 8.0.16 — and a version that merely parses them is
 * more dangerous than one that rejects them outright, because the constraint is
 * visible in the schema while guaranteeing nothing. A caller that relies on a
 * CHECK for correctness should say so out loud when this is false.
 */
const checksAreEnforced = async (sequelize) => {
  if (isPostgres(sequelize)) return true;
  const [row] = await sequelize.query('SELECT VERSION() AS v', { type: QueryTypes.SELECT });
  const [major, minor, patch] = String(row?.v || '0').split('-')[0].split('.').map(Number);
  if (major > 8) return true;
  if (major < 8) return false;
  if (minor > 0) return true;
  return (patch || 0) >= 16;
};

/**
 * The id of the row the last INSERT on THIS connection created.
 *
 * `LAST_INSERT_ID()` does not exist in Postgres, so every call site using it
 * threw there — and they sit on the payment and purchase paths, which is to say
 * recording a payment and creating a purchase both failed outright on the
 * production engine while working perfectly in development.
 *
 * Postgres `lastval()` has the same session-scoped meaning: the most recent
 * value generated by a sequence on this connection. So the existing reasoning
 * at each call site still holds unchanged — the surrounding transaction pins
 * the connection, which is what stops another request's row being read. It is
 * only the spelling that differs.
 *
 * Prefer `insertReturningId` in new code: RETURNING is part of the INSERT
 * itself, so there is no session state to reason about at all.
 */
const lastInsertId = async (sequelize, { transaction } = {}) => {
  const sql = isPostgres(sequelize)
    ? 'SELECT lastval() AS id'
    : 'SELECT LAST_INSERT_ID() AS id';
  const [row] = await sequelize.query(sql, { transaction, type: QueryTypes.SELECT });
  return Number(row?.id);
};

/**
 * Runs an INSERT and returns the id of the row it created.
 *
 * `LAST_INSERT_ID()` does not exist in Postgres, so every call site that used
 * it was a hard failure there — and they sit on the payment path, where it
 * matters most. Postgres answers with RETURNING, which is also better: it is
 * part of the same statement, so there is no per-connection state to lose.
 *
 * The MySQL branch keeps the two-statement form but runs both on the SAME
 * transaction, which is what makes LAST_INSERT_ID() safe under concurrency.
 */
const insertReturningId = async (sequelize, sql, { replacements, transaction, idColumn = 'id' } = {}) => {
  if (isPostgres(sequelize)) {
    const rows = await sequelize.query(`${sql} RETURNING ${quoteIdent(sequelize, idColumn)}`, {
      replacements, transaction, type: QueryTypes.SELECT,
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    return Number(row?.[idColumn]);
  }

  await sequelize.query(sql, { replacements, transaction, type: QueryTypes.INSERT });
  const [row] = await sequelize.query('SELECT LAST_INSERT_ID() AS id', {
    transaction, type: QueryTypes.SELECT,
  });
  return Number(row?.id);
};

/**
 * The LIKE operator that matches case-insensitively on this engine.
 *
 * This one does not announce itself at all — neither engine errors, they just
 * disagree. MySQL's default collation (utf8mb4_*_ci) makes LIKE
 * case-INsensitive, so `?search=lekki` finds "Lekki Court" all through
 * development. Postgres collates case-sensitively and LIKE follows suit, so the
 * same search finds nothing in production and the feature reads as broken
 * rather than as a dialect difference.
 *
 * Op.iLike is Postgres-only — Sequelize throws on MySQL rather than emitting
 * anything — so the choice has to be made per engine and cannot simply be
 * hardcoded to the more forgiving one.
 */
const likeOperator = (sequelize) => (isPostgres(sequelize) ? Op.iLike : Op.like);

/**
 * The same choice, as a SQL KEYWORD rather than a Sequelize operator.
 *
 * Needed wherever a comparison is written as raw SQL instead of built from
 * operators — a subquery against another table, say. Postgres's LIKE is
 * case-SENSITIVE and MySQL's is not, so a hardcoded LIKE stops matching
 * differently-cased text the moment it reaches production. Same trap as
 * likeOperator above, one layer down.
 */
const likeKeyword = (sequelize) => (isPostgres(sequelize) ? 'ILIKE' : 'LIKE');

/**
 * "Insert this row unless it is already there", in both engines.
 *
 * MySQL spells it `INSERT IGNORE`; Postgres spells it `ON CONFLICT DO NOTHING`
 * and treats the MySQL form as a syntax error — so a statement that quietly did
 * the right thing in development failed outright in production.
 *
 * `body` is everything after `INSERT INTO`, so both the VALUES and the
 * INSERT ... SELECT shapes work:
 *
 *   insertIgnoring(sequelize, 'user_roles (user_id, role_id) VALUES (:u, :r)', opts)
 *
 * Both forms lean on the target's own unique key to spot the clash, which is
 * what makes them atomic. A `WHERE NOT EXISTS` check would read as portable and
 * is not: two concurrent callers can both pass it and the second insert throws.
 */
const insertIgnoring = (sequelize, body, options) => sequelize.query(
  isMySQL(sequelize)
    ? `INSERT IGNORE INTO ${body}`
    : `INSERT INTO ${body} ON CONFLICT DO NOTHING`,
  options,
);

/**
 * Cast a column to text, in whichever spelling the engine accepts.
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 *
 * Postgres gives every ENUM column its own TYPE, named after the table and
 * column — `enum_debit_notes_party_type`. Two tables declaring the same enum
 * therefore have two incompatible types, and a UNION across them fails with
 * "UNION could not convert type X to Y". MySQL has no such thing: its enums are
 * inline, the union is text, and the query works.
 *
 * So this is invisible in development and fatal in production. It took down
 * /notes/pending-approval — the credit and debit approval queue — which failed
 * every sixty seconds for anybody polling it, with a 400 and a message no
 * screen displayed.
 *
 * `CAST(x AS TEXT)` is Postgres; MySQL wants `CAST(x AS CHAR)` and rejects
 * TEXT. Neither accepts the other's, and `::text` is Postgres-only syntax.
 */
const castText = (sequelize, expression) => (isPostgres(sequelize)
  ? `CAST(${expression} AS TEXT)`
  : `CAST(${expression} AS CHAR)`);

module.exports = {
  isPostgres,
  likeOperator,
  likeKeyword,
  insertIgnoring,
  isMySQL,
  isMysql,
  quoteIdent,
  q,
  isDuplicateError,
  isDuplicateIndexError,
  columnsOf,
  tableExists,
  enumValues,
  enumTypeName,
  widenEnum,
  narrowEnum,
  indexExists,
  addUniqueIndex,
  dropIndex,
  insertReturningId,
  lastInsertId,
  constraintExists,
  addCheckConstraint,
  dropConstraint,
  checksAreEnforced,
  castText,
};

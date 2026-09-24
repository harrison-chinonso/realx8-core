/**
 * A dress rehearsal for the production migration, on production's engine.
 *
 * ── Why this exists separately from verify-multi-company ────────────────────
 *
 * That script proves the FEATURE, against MySQL, which is what development
 * runs. This proves the STEP THAT CHANGES PRODUCTION, against Postgres, which
 * is what production runs — and they are not the same risk.
 *
 * The dangerous part is not the new index, it is dropping the old one. In
 * Postgres a column declared `unique: true` is backed by a CONSTRAINT, and
 * `DROP INDEX` on a constraint-backed index fails with "cannot drop index …
 * because constraint … requires it". The index survives, the migration logs a
 * warning nobody reads, and the deploy looks clean while the thing it was for
 * — a second account on the same address — is still refused by an index
 * everyone believes is gone.
 *
 * dropIndex in shared/src/dialect.js handles that case. Nothing had ever run
 * it, because every migration run so far has been MySQL, where the distinction
 * does not exist.
 *
 * ── What it asserts ─────────────────────────────────────────────────────────
 *
 * That the schema afterwards accepts what it must and still refuses what it
 * must, tested by INSERT rather than by reading catalogue tables — an index
 * that exists under a name nobody expected is not a passing state.
 *
 *   PG_HOST / PG_PORT / PG_USER / PG_PASSWORD override the connection.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { Sequelize, QueryTypes } = require('sequelize');

const PG = {
  host: process.env.PG_HOST || 'localhost',
  port: Number(process.env.PG_PORT || 5433),
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
  database: process.env.PG_DATABASE || 'realx8test',
};
const SCHEMA = 'multi_company_rehearsal';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

/** Did this INSERT land, or was it refused by a constraint? */
const tryInsert = async (sequelize, sql, replacements) => {
  try {
    await sequelize.query(sql, { replacements, type: QueryTypes.INSERT });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error.parent?.message || error.message };
  }
};

(async () => {
  const sequelize = new Sequelize(PG.database, PG.user, PG.password, {
    host: PG.host, port: PG.port, dialect: 'postgres', logging: false,
    searchPath: SCHEMA,
    dialectOptions: { options: `-c search_path=${SCHEMA}` },
  });

  try {
    await sequelize.authenticate();
  } catch (error) {
    console.error(`\nCannot reach Postgres at ${PG.host}:${PG.port} — ${error.message}`);
    console.error('  docker run -d --name realx8-pg -e POSTGRES_PASSWORD=postgres \\');
    console.error('    -e POSTGRES_DB=realx8test -p 5433:5432 postgres:16-alpine\n');
    process.exit(1);
  }

  // A schema of its own, dropped and rebuilt, so this can never touch anything.
  await sequelize.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await sequelize.query(`CREATE SCHEMA ${SCHEMA}`);

  console.log('\n── The shape production is in today ─────────────────────────────\n');

  /*
   * `users` as Postgres builds it from the model BEFORE this change: email and
   * google_id declared unique, which Postgres backs with CONSTRAINTS rather
   * than bare indexes. That distinction is the whole point of the rehearsal.
   */
  await sequelize.query(`
    CREATE TABLE ${SCHEMA}.users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      type VARCHAR(64) NOT NULL DEFAULT 'client',
      google_id VARCHAR(255) NULL UNIQUE,
      company_id INTEGER NULL,
      deleted_at TIMESTAMP WITH TIME ZONE NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`);
  await sequelize.query(`
    CREATE TABLE ${SCHEMA}.refresh_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      token VARCHAR(255) NOT NULL UNIQUE,
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
      sid VARCHAR(64) NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`);

  await sequelize.query(
    `INSERT INTO ${SCHEMA}.users (name, email, password, type, company_id)
     VALUES ('Ada', 'ada@example.test', 'x', 'realtor', 1)`,
  );

  const before = await tryInsert(
    sequelize,
    `INSERT INTO ${SCHEMA}.users (name, email, password, type, company_id)
     VALUES ('Ada', 'ada@example.test', 'x', 'realtor', 2)`,
  );
  check('Before: one address cannot appear in two companies',
    before.ok === false, before.message);

  const constraintsBefore = await sequelize.query(
    `SELECT conname FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = :schema AND t.relname = 'users' AND c.contype = 'u'`,
    { replacements: { schema: SCHEMA }, type: QueryTypes.SELECT },
  );
  check('...enforced by CONSTRAINTS, which is the case never yet exercised',
    constraintsBefore.length >= 2, constraintsBefore.map((r) => r.conname).join(', '));

  console.log('\n── Running the migrations, exactly as boot does ─────────────────\n');

  await require('../services/user-service/src/migrations/emailUniquePerCompany')(sequelize);
  await require('../services/user-service/src/migrations/addOpenedAccounts')(sequelize);

  console.log('');

  const after = await tryInsert(
    sequelize,
    `INSERT INTO ${SCHEMA}.users (name, email, password, type, company_id)
     VALUES ('Ada', 'ada@example.test', 'x', 'realtor', 2)`,
  );
  check('The same address is now accepted in a second company',
    after.ok === true, after.message || 'inserted');

  const twice = await tryInsert(
    sequelize,
    `INSERT INTO ${SCHEMA}.users (name, email, password, type, company_id)
     VALUES ('Impostor', 'ada@example.test', 'x', 'realtor', 1)`,
  );
  check('...and still refused twice inside ONE company', twice.ok === false, twice.message);

  const googleOne = await tryInsert(
    sequelize,
    `INSERT INTO ${SCHEMA}.users (name, email, password, type, google_id, company_id)
     VALUES ('Bem', 'bem@example.test', 'x', 'client', 'g-123', 1)`,
  );
  const googleTwo = await tryInsert(
    sequelize,
    `INSERT INTO ${SCHEMA}.users (name, email, password, type, google_id, company_id)
     VALUES ('Bem', 'bem@example.test', 'x', 'client', 'g-123', 2)`,
  );
  check('One Google account can sign in to two companies',
    googleOne.ok && googleTwo.ok, googleTwo.message || 'both inserted');

  const googleSame = await tryInsert(
    sequelize,
    `INSERT INTO ${SCHEMA}.users (name, email, password, type, google_id, company_id)
     VALUES ('Bem2', 'bem2@example.test', 'x', 'client', 'g-123', 1)`,
  );
  check('...but not twice in the same one', googleSame.ok === false, googleSame.message);

  const leftovers = await sequelize.query(
    `SELECT conname FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = :schema AND t.relname = 'users' AND c.contype = 'u'
       AND array_length(c.conkey, 1) = 1`,
    { replacements: { schema: SCHEMA }, type: QueryTypes.SELECT },
  );
  check('No single-column unique constraint survived the drop',
    leftovers.length === 0, leftovers.map((r) => r.conname).join(', ') || 'none');

  const columns = await sequelize.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = :schema AND table_name = 'refresh_tokens' AND column_name = 'opened_accounts'`,
    { replacements: { schema: SCHEMA }, type: QueryTypes.SELECT },
  );
  check('refresh_tokens.opened_accounts was added', columns.length === 1, '');

  console.log('\n── Running them again, as a restart would ───────────────────────\n');

  /*
   * A restart must be a NO-OP, and "no output" is how that is observed.
   *
   * It was not, once: the lookup index this migration creates on google_id
   * shared its name with one of the indexes it drops, so every boot dropped it
   * and built it again — churn on the table holding every account, and a window
   * with no index on a column sign-in searches by. Nothing failed, which is why
   * it needs asserting rather than eyeballing.
   */
  const said = [];
  const realLog = console.log;
  console.log = (...args) => { said.push(args.join(' ')); };
  await require('../services/user-service/src/migrations/emailUniquePerCompany')(sequelize);
  await require('../services/user-service/src/migrations/addOpenedAccounts')(sequelize);
  console.log = realLog;

  check('A restart does no work at all', said.length === 0, said.join(' | ') || 'silent');

  const stillRefused = await tryInsert(
    sequelize,
    `INSERT INTO ${SCHEMA}.users (name, email, password, type, company_id)
     VALUES ('Impostor', 'ada@example.test', 'x', 'realtor', 1)`,
  );
  check('A second run changes nothing and breaks nothing',
    stillRefused.ok === false, stillRefused.message);

  console.log('\n── The refusal a half-migrated database would give ──────────────\n');

  /*
   * What happens if the composite index cannot be added because the data
   * already violates it. The migration must decline and say why rather than
   * throwing on a boot path, or the service does not start.
   */
  await sequelize.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}_dirty`);
  await sequelize.query(`
    CREATE TABLE ${SCHEMA}_dirty.users (
      id SERIAL PRIMARY KEY, name VARCHAR(255), email VARCHAR(255) NOT NULL,
      password VARCHAR(255), type VARCHAR(64), google_id VARCHAR(255) NULL,
      company_id INTEGER NULL, deleted_at TIMESTAMP WITH TIME ZONE NULL
    )`);
  await sequelize.query(`
    INSERT INTO ${SCHEMA}_dirty.users (name, email, password, type, company_id)
    VALUES ('A', 'clash@example.test', 'x', 'client', 1), ('B', 'clash@example.test', 'x', 'client', 1)`);

  const dirty = new Sequelize(PG.database, PG.user, PG.password, {
    host: PG.host, port: PG.port, dialect: 'postgres', logging: false,
    dialectOptions: { options: `-c search_path=${SCHEMA}_dirty` },
  });
  let threw = false;
  try {
    await require('../services/user-service/src/migrations/emailUniquePerCompany')(dirty);
  } catch { threw = true; }
  check('Data that violates the new rule declines rather than crashing the boot',
    threw === false, 'reported and skipped');
  await dirty.close();

  await sequelize.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await sequelize.query(`DROP SCHEMA IF EXISTS ${SCHEMA}_dirty CASCADE`);
  await sequelize.close();

  console.log(`\n  ${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(1); });

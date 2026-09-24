/**
 * The level-up fee column exists on Postgres too.
 *
 * ── The bug this is the regression test for ─────────────────────────────────
 *
 * `realtor_levels.levelup_fee_minor` is declared on the model, so every read of
 * a level selects it. It is added by a migration that was written for both
 * engines and says so in its own header — and was filed inside the `isMySQL`
 * gate with the legacy migrations that only walk an old MySQL installation
 * forward. On Postgres it therefore never ran, and configuring a level-up fee
 * failed with "column levelup_fee_minor does not exist".
 *
 * sync() cannot rescue it: user-service syncs with { force: false }, which
 * creates a MISSING table but never adds a column to one that already exists —
 * and production's `realtor_levels` came across from MySQL rather than being
 * built by sync.
 *
 * So this builds the table the way that database has it, WITHOUT the column,
 * and asserts the migration adds it and a fee can then be stored.
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
const SCHEMA = 'levelup_fee_rehearsal';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

(async () => {
  const sequelize = new Sequelize(PG.database, PG.user, PG.password, {
    host: PG.host, port: PG.port, dialect: 'postgres', logging: false,
    dialectOptions: { options: `-c search_path=${SCHEMA}` },
  });

  try {
    await sequelize.authenticate();
  } catch (error) {
    console.error(`\nCannot reach Postgres at ${PG.host}:${PG.port} — ${error.message}\n`);
    process.exit(1);
  }

  await sequelize.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await sequelize.query(`CREATE SCHEMA ${SCHEMA}`);

  console.log('\n── The table as a carried-over database has it ──────────────────\n');

  await sequelize.query(`
    CREATE TABLE ${SCHEMA}.realtor_levels (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      commission_percentage NUMERIC(5,2) NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      company_id INTEGER NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`);

  const columnsNow = async () => (await sequelize.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = :schema AND table_name = 'realtor_levels'`,
    { replacements: { schema: SCHEMA }, type: QueryTypes.SELECT },
  )).map((r) => r.column_name);

  check('It starts without levelup_fee_minor, as production did',
    !(await columnsNow()).includes('levelup_fee_minor'), '');

  let failedBefore = null;
  try {
    await sequelize.query(
      `INSERT INTO ${SCHEMA}.realtor_levels (name, position, levelup_fee_minor) VALUES ('Gold', 20, 1500000)`,
    );
  } catch (error) { failedBefore = error.parent?.message || error.message; }
  check('...so setting a level-up fee fails, exactly as reported',
    failedBefore !== null, failedBefore);

  console.log('\n── Running the migration ───────────────────────────────────────\n');

  await require('../services/user-service/src/migrations/addRealtorChargeFees')(sequelize);

  console.log('');
  check('The column is there now', (await columnsNow()).includes('levelup_fee_minor'), '');

  await sequelize.query(
    `INSERT INTO ${SCHEMA}.realtor_levels (name, position, levelup_fee_minor) VALUES ('Gold', 20, 1500000)`,
  );
  const [row] = await sequelize.query(
    `SELECT levelup_fee_minor FROM ${SCHEMA}.realtor_levels WHERE name = 'Gold'`,
    { type: QueryTypes.SELECT },
  );
  check('...and a fee stores and reads back', Number(row.levelup_fee_minor) === 1500000,
    String(row.levelup_fee_minor));

  const [zero] = await sequelize.query(
    `INSERT INTO ${SCHEMA}.realtor_levels (name, position) VALUES ('Bronze', 10)
     RETURNING levelup_fee_minor`,
    { type: QueryTypes.SELECT },
  );
  check('A level created without one is free, not null',
    Number(zero.levelup_fee_minor) === 0, String(zero.levelup_fee_minor));

  console.log('\n── Running it again, as a restart would ────────────────────────\n');
  const said = [];
  const realLog = console.log;
  console.log = (...args) => { said.push(args.join(' ')); };
  await require('../services/user-service/src/migrations/addRealtorChargeFees')(sequelize);
  console.log = realLog;
  check('A restart does nothing', said.length === 0, said.join(' | ') || 'silent');

  /*
   * And the guard that keeps it safe to run everywhere: a database that has no
   * realtor_levels at all — a brand new one, where sync will create the table
   * complete — must be left alone rather than thrown at on a boot path.
   */
  await sequelize.query(`DROP TABLE ${SCHEMA}.realtor_levels`);
  let threw = false;
  try {
    await require('../services/user-service/src/migrations/addRealtorChargeFees')(sequelize);
  } catch { threw = true; }
  check('A database without the table is skipped, not crashed into', threw === false, '');

  await sequelize.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await sequelize.close();

  console.log(`\n  ${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(1); });

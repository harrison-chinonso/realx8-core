/**
 * What every enum column in a database actually accepts, and what its rows hold.
 *
 * Written because `invalid input value for enum ...: "pending"` kept being
 * reported from the live Postgres while development (MySQL) was clean, and the
 * two cannot be compared by reading code: Postgres models an enum as a TYPE
 * that `sync()` will not add values to once it exists, so a database carried
 * forward from a copy keeps whatever vocabulary it was created with, forever.
 *
 * READ-ONLY by default. Pass --fix to widen any enum whose rows or code need a
 * value it does not have.
 *
 *   # against the live database, read-only
 *   DB_DIALECT=postgres DB_HOST=... DB_PORT=5432 DB_NAME=... DB_USER=... \
 *   DB_PASSWORD=... DB_SSL=true node scripts/diagnose-enums.js
 *
 *   # and again with --fix once the report looks right
 *   ... node scripts/diagnose-enums.js --fix
 *
 * With no DB_* overrides it reads cred.env, i.e. the development database.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { Sequelize, QueryTypes } = require('sequelize');
const D = require('../shared/src/dialect');

const FIX = process.argv.includes('--fix');

/**
 * The vocabularies the CODE expects, for the columns that have caused trouble.
 *
 * Only these are repaired by --fix. Everything else is reported so a difference
 * can be seen, because widening an enum this file knows nothing about would be
 * guessing at the application's intent.
 */
const EXPECTED = {
  'commissions.status': ['created', 'payment_requested', 'approved', 'paid', 'cancelled'],
  'transactions.entry_type': ['credit', 'debit'],
  'referral_transactions.status': ['pending', 'paid', 'cancelled'],
  'credit_notes.status': ['draft', 'sent', 'partial', 'used', 'cancelled'],
  'debit_notes.status': ['draft', 'sent', 'partial', 'paid', 'cancelled'],
};

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

(async () => {
  const dialect = (process.env.DB_DIALECT || 'mysql').toLowerCase();
  const sequelize = new Sequelize(
    process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD,
    {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || (dialect === 'postgres' ? 5432 : 3306)),
      dialect,
      logging: false,
      dialectOptions: /^true$/i.test(process.env.DB_SSL || '')
        ? { ssl: { require: true, rejectUnauthorized: false } }
        : {},
    },
  );

  await sequelize.authenticate();
  console.log(`\n  ${dialect} — ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(`  ${FIX ? yellow('--fix: enums will be WIDENED where needed') : dim('read-only (pass --fix to repair)')}\n`);

  // Every enum column in the schema, on either engine.
  const columns = D.isPostgres(sequelize)
    ? await sequelize.query(
      `SELECT c.table_name, c.column_name, c.udt_name AS type_name
         FROM information_schema.columns c
         JOIN pg_type t ON t.typname = c.udt_name
        WHERE c.table_schema = CURRENT_SCHEMA() AND t.typtype = 'e'
        ORDER BY c.table_name, c.column_name`,
      { type: QueryTypes.SELECT },
    )
    : await sequelize.query(
      `SELECT table_name, column_name, column_type AS type_name
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND data_type = 'enum'
        ORDER BY table_name, column_name`,
      { type: QueryTypes.SELECT },
    );

  let problems = 0;

  for (const col of columns) {
    const table = col.table_name || col.TABLE_NAME;
    const column = col.column_name || col.COLUMN_NAME;
    const key = `${table}.${column}`;

    // eslint-disable-next-line no-await-in-loop
    const accepted = await D.enumValues(sequelize, table, column);

    // What the rows actually hold — a value in use but not accepted cannot
    // happen, but a value ACCEPTED and unused is the signal that a vocabulary
    // has moved on, and one MISSING is the error being chased.
    let inUse = [];
    try {
      // eslint-disable-next-line no-await-in-loop
      const rows = await sequelize.query(
        `SELECT DISTINCT ${D.quoteIdent(sequelize, column)}::text AS v FROM ${D.quoteIdent(sequelize, table)} LIMIT 50`
          .replace('::text', D.isPostgres(sequelize) ? '::text' : ''),
        { type: QueryTypes.SELECT },
      );
      inUse = rows.map((r) => r.v).filter((v) => v !== null);
    } catch { /* table unreadable — the accepted list is still worth printing */ }

    const expected = EXPECTED[key];
    const missing = expected ? expected.filter((v) => !accepted.includes(v)) : [];
    const extra = expected ? accepted.filter((v) => !expected.includes(v)) : [];

    const flag = missing.length ? red(' MISSING VALUES') : (expected ? green(' ok') : '');
    console.log(`  ${key}${flag}`);
    console.log(`      accepts: ${accepted.join(', ') || dim('(none)')}`);
    if (inUse.length) console.log(`      in use : ${inUse.join(', ')}`);
    if (expected && missing.length) {
      problems += 1;
      console.log(`      ${red(`code expects but the type lacks: ${missing.join(', ')}`)}`);
      console.log(`      ${dim('this is what raises: invalid input value for enum ' + (col.type_name || '') + ': "' + missing[0] + '"')}`);
      if (FIX) {
        // eslint-disable-next-line no-await-in-loop
        const added = await D.widenEnum(sequelize, table, column, expected);
        console.log(`      ${green(`widened: added ${added.join(', ')}`)}`);
      }
    }
    if (expected && extra.length) {
      console.log(`      ${yellow(`retired values still accepted: ${extra.join(', ')}`)} ${dim('(harmless; narrow only once no row uses them)')}`);
    }
    console.log('');
  }

  if (!problems) {
    console.log(`  ${green('No enum is missing a value the code needs.')}`);
    console.log(`  ${dim('If an error persists, it names a type this script did not flag — send the exact message.')}\n`);
  } else if (FIX) {
    console.log(`  ${green(`${problems} enum(s) widened. Re-run without --fix to confirm.`)}\n`);
  } else {
    console.log(`  ${red(`${problems} enum(s) need widening.`)} Re-run with --fix to repair.\n`);
  }

  await sequelize.close();
  process.exit(0);
})().catch((error) => {
  console.error('\n\x1b[31mCould not complete:\x1b[0m', error.message);
  process.exit(1);
});

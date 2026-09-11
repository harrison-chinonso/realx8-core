/**
 * One-off migration: copy all data from the local dev MySQL database into
 * the live Neon Postgres database, matching tables by name.
 *
 * This is DESTRUCTIVE on the Postgres side: every matched table is
 * TRUNCATEd before the copy. It does not touch the MySQL source.
 *
 * Usage:
 *   SRC_HOST=localhost SRC_PORT=3306 SRC_USER=root SRC_PASSWORD=password SRC_DB=realto \
 *   DST_HOST=ep-...-pooler.c-2.eu-west-2.aws.neon.tech DST_PORT=5432 DST_USER=realx8_owner \
 *   DST_PASSWORD=... DST_DB=realx8 DST_ENDPOINT=ep-...-pooler \
 *   node scripts/migrate-mysql-to-postgres.js [--dry-run] [--only=table1,table2]
 */
const mysql = require('mysql2/promise');
const { Client } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.split('=')[1].split(',')) : null;

const BATCH_SIZE = 500;

function pgIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

async function main() {
  const src = await mysql.createConnection({
    host: process.env.SRC_HOST || 'localhost',
    port: Number(process.env.SRC_PORT || 3306),
    user: process.env.SRC_USER || 'root',
    password: process.env.SRC_PASSWORD || '',
    database: process.env.SRC_DB || 'realto',
    // Return DATE/DATETIME as strings so we can pass them through to pg as-is
    // instead of JS Date objects picking up local-timezone shifts.
    dateStrings: true,
  });

  const dst = new Client({
    host: process.env.DST_HOST,
    port: Number(process.env.DST_PORT || 5432),
    user: process.env.DST_USER,
    password: process.env.DST_PASSWORD,
    database: process.env.DST_DB,
    ssl: { require: true, rejectUnauthorized: false },
    ...(process.env.DST_ENDPOINT ? { options: `endpoint=${process.env.DST_ENDPOINT}` } : {}),
  });
  await dst.connect();

  console.log(`[migrate] connected. dry-run=${DRY_RUN}`);

  const { rows: pgTables } = await dst.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  const targetTableNames = pgTables.map((r) => r.table_name).filter((n) => !ONLY || ONLY.has(n));

  const [mysqlTables] = await src.query('SHOW TABLES');
  const sourceTableNames = new Set(mysqlTables.map((r) => Object.values(r)[0]));

  const tablesToCopy = targetTableNames.filter((t) => sourceTableNames.has(t));
  const skipped = targetTableNames.filter((t) => !sourceTableNames.has(t));
  if (skipped.length) console.log(`[migrate] skipping (no matching source table): ${skipped.join(', ')}`);

  console.log(`[migrate] will copy ${tablesToCopy.length} tables`);

  // Column metadata per PG table, to know data types for conversion + quoting.
  const columnInfo = {};
  for (const table of tablesToCopy) {
    const { rows } = await dst.query(
      `SELECT column_name, data_type, udt_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [table],
    );
    columnInfo[table] = rows;
  }

  if (DRY_RUN) {
    for (const table of tablesToCopy) {
      const [[{ c }]] = await src.query(`SELECT COUNT(*) as c FROM \`${table}\``);
      console.log(`[dry-run] ${table}: ${c} rows would be copied`);
    }
    await src.end();
    await dst.end();
    return;
  }

  // Neon's role is not a superuser, so we can't DISABLE TRIGGER ALL (that
  // touches the system RI-constraint triggers). Instead, make every FK
  // constraint deferrable (allowed for the owning role) and defer all
  // constraint checks to end-of-transaction, so insert order doesn't matter.
  const { rows: fkConstraints } = await dst.query(`
    SELECT conname, conrelid::regclass::text AS tbl
    FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace
  `);
  for (const { conname, tbl } of fkConstraints) {
    await dst.query(`ALTER TABLE ${tbl} ALTER CONSTRAINT ${pgIdent(conname)} DEFERRABLE INITIALLY DEFERRED`);
  }

  if (tablesToCopy.length) {
    await dst.query(`TRUNCATE TABLE ${tablesToCopy.map(pgIdent).join(', ')} RESTART IDENTITY CASCADE`);
  }

  await dst.query('BEGIN');
  await dst.query('SET CONSTRAINTS ALL DEFERRED');

  let totalRows = 0;
  try {
    for (const table of tablesToCopy) {
      const cols = columnInfo[table];
      const colNames = cols.map((c) => c.column_name);
      const [rows] = await src.query(`SELECT * FROM \`${table}\``);

      if (!rows.length) {
        console.log(`[migrate] ${table}: 0 rows`);
        continue;
      }

      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const chunk = rows.slice(i, i + BATCH_SIZE);
        const values = [];
        const tuples = [];
        let p = 1;
        for (const row of chunk) {
          const placeholders = [];
          for (const col of cols) {
            let v = row[col.column_name];
            v = convertValue(v, col);
            values.push(v);
            placeholders.push(`$${p++}`);
          }
          tuples.push(`(${placeholders.join(',')})`);
        }
        const sql = `INSERT INTO ${pgIdent(table)} (${colNames.map(pgIdent).join(',')}) VALUES ${tuples.join(',')}`;
        await dst.query(sql, values);
      }
      totalRows += rows.length;
      console.log(`[migrate] ${table}: ${rows.length} rows copied`);
    }
  } catch (e) {
    console.error('[migrate] error during copy, rolling back transaction:', e.message);
    await dst.query('ROLLBACK');
    throw e;
  }

  await dst.query('COMMIT');

  // Fix sequences for any serial/identity columns (no trigger re-enable
  // needed now, since we never disabled any).
  for (const table of tablesToCopy) {
    const cols = columnInfo[table];
    for (const col of cols) {
      const { rows: seqRows } = await dst.query('SELECT pg_get_serial_sequence($1, $2) as seq', [table, col.column_name]);
      const seq = seqRows[0] && seqRows[0].seq;
      if (seq) {
        await dst.query(
          `SELECT setval($1, COALESCE((SELECT MAX(${pgIdent(col.column_name)}) FROM ${pgIdent(table)}), 1), true)`,
          [seq],
        );
      }
    }
  }

  console.log(`[migrate] done. total rows copied: ${totalRows}`);
  await src.end();
  await dst.end();
}

function convertValue(v, col) {
  if (v === null || v === undefined) return null;
  if (col.data_type === 'boolean') {
    if (typeof v === 'boolean') return v;
    return v === 1 || v === '1' || v === true;
  }
  if (col.udt_name === 'json' || col.udt_name === 'jsonb') {
    if (typeof v === 'string') return v; // pg accepts JSON text directly
    return JSON.stringify(v);
  }
  if (Buffer.isBuffer(v)) return v;
  return v;
}

main().catch((e) => {
  console.error('[migrate] FAILED', e);
  process.exit(1);
});

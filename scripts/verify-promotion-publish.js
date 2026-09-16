/**
 * Publishing a promotion, on Postgres.
 *
 * Reproduces a production failure: pressing Publish returned
 * "syntax error at end of input". Nothing in the controller's own SQL is built
 * by string concatenation, so this drives the REAL setStatus against a real
 * Postgres to find which statement the parser is actually choking on.
 *
 * Throwaway database; dropped at the end.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { Client } = require('pg');

const PG = {
  host: process.env.PG_HOST || '127.0.0.1',
  port: Number(process.env.PG_PORT || 5433),
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
};
const DB = 'realx8_promo_publish';

process.env.DB_DIALECT = 'postgres';
process.env.DB_HOST = PG.host;
process.env.DB_PORT = String(PG.port);
process.env.DB_USER = PG.user;
process.env.DB_PASSWORD = PG.password;
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'promopublish';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

(async () => {
  const admin = new Client({ ...PG, database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();

  const { sequelize } = require('../services/property-service/src/models');
  await sequelize.sync({ alter: true });
  console.log('  schema synced');

  const tables = await sequelize.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'promotion%'",
    { type: sequelize.QueryTypes.SELECT },
  );
  console.log('  promotion tables:', tables.map((t) => t.table_name).join(', ') || '(none)');

  await require('../services/property-service/src/migrations/createPromotionEngine')(sequelize);
  const built = await sequelize.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'promotion%'",
    { type: sequelize.QueryTypes.SELECT },
  );
  console.log('  after the migration:', JSON.stringify(built));

  const { createPromotion, setStatus, listPromotions } = require('../services/property-service/src/controllers/promotionController');

  const run = (handler, req) => new Promise((resolve) => {
    let code = 200;
    const res = {
      status(c) { code = c; return res; },
      json(body) { resolve({ code, body }); return res; },
    };
    Promise.resolve(handler(req, res, (err) => resolve({ code: 500, body: { error: err } })))
      .catch((err) => resolve({ code: 500, body: { error: err } }));
  });

  const user = { id: 1, company_id: 1, type: 'admin' };

  console.log('\n── Creating a draft ─────────────────────────────────────────────');
  const created = await run(createPromotion, {
    user,
    body: {
      name: 'Repro Campaign',
      code: 'REPRO1',
      trigger_type: 'AUTOMATIC',
      starts_at: new Date(Date.now() - 86400000),
      ends_at: new Date(Date.now() + 30 * 86400000),
      // configFrom reads these off the body itself, not a nested `config`.
      benefit_type: 'PERCENTAGE',
      percentage: 5,
      scope: { properties: [1] },
    },
  });
  const cerr = created.body?.error;
  if (cerr) {
    console.log('  ', created.code, `${cerr.name}: ${cerr.message}`);
    console.log('   pg  :', cerr.parent?.message);
    console.log('   SQL :', String(cerr.sql || cerr.parent?.sql || '').replace(/\s+/g, ' '));
  } else {
    console.log('  ', created.code, JSON.stringify(created.body).slice(0, 160));
  }
  check('A draft is created, and comes back with its id',
    created.code === 201 && Number(created.body?.data?.id) > 0,
    cerr ? cerr.message : `id ${created.body?.data?.id}`);

  const id = created.body?.data?.id;
  if (id) {
    console.log('\n── Publishing it (this is what fails in production) ─────────────');
    const published = await run(setStatus, { user, params: { id: String(id) }, body: { status: 'ACTIVE' } });
    const err = published.body?.error;
    if (err?.sql) console.log('   SQL:', String(err.sql).replace(/\s+/g, ' ').slice(0, 400));
    check('Publishing moves it to ACTIVE',
      published.code === 200 && published.body?.data?.status === 'ACTIVE',
      err ? `${err.name}: ${err.parent?.message || err.message}` : JSON.stringify(published.body).slice(0, 200));

    console.log('\n── Saving an edit to a promotion that is already live ───────────');
    {
      /*
       * The wizard saves the edit and then publishes. Editing something already
       * ACTIVE therefore asks ACTIVE to become ACTIVE, and that used to answer
       * "An active promotion cannot become active" — after the edit had been
       * written, so the admin saw a failure for work that had succeeded.
       */
      const again = await run(setStatus, { user, params: { id: String(id) }, body: { status: 'ACTIVE' } });
      check('Asking for the status it already has is accepted, not a conflict',
        again.code === 200 && again.body?.data?.status === 'ACTIVE',
        `HTTP ${again.code} — ${JSON.stringify(again.body).slice(0, 140)}`);
      check('...and says it changed nothing',
        again.body?.unchanged === true, JSON.stringify(again.body?.unchanged));

      const illegal = await run(setStatus, { user, params: { id: String(id) }, body: { status: 'DRAFT' } });
      check('A move that really is illegal is still refused',
        illegal.code === 409 && /cannot become draft/i.test(illegal.body?.message || ''),
        `HTTP ${illegal.code} — ${illegal.body?.message}`);
    }

    console.log('\n── Listing afterwards ──────────────────────────────────────────');
    const listed = await run(listPromotions, { user, query: {} });
    const lerr = listed.body?.error;
    check('The list reads back without error', !lerr, lerr ? lerr.message : `${listed.body?.data?.length} row(s)`);
  }

  console.log('\n── The old way still fails, so the guard is real ────────────────');
  {
    /*
     * The exact shape createPromotion used to have. If Postgres ever starts
     * returning an id for a plain INSERT this check goes green and the fix
     * above stops being necessary — which is worth knowing either way.
     */
    const [rawId] = await sequelize.query(
      `INSERT INTO "promotions" (company_id, name, code, trigger_type, status, priority, stackable, created_at, updated_at)
       VALUES (1, 'Old Way', 'OLDWAY', 'AUTOMATIC', 'DRAFT', 0, false, NOW(), NOW())`,
      { type: sequelize.QueryTypes.INSERT },
    );
    check('A destructured INSERT yields no usable id on Postgres',
      !(Number(rawId) > 0), `got ${JSON.stringify(rawId)} — on MySQL this is the new row's id`);

    let truncated = null;
    try {
      await sequelize.query('SELECT MAX(version) FROM "promotion_versions" WHERE promotion_id = :promotionId',
        { replacements: { promotionId: rawId }, type: sequelize.QueryTypes.SELECT });
    } catch (e) {
      truncated = e.parent?.message || e.message;
    }
    check('...and using it truncates the next statement', /syntax error at end of input/.test(truncated || ''), truncated);
  }

  console.log('\n── Nowhere else reads an insert id the MySQL-only way ───────────');
  {
    /*
     * A repo-wide scan, because this is a CLASS of bug rather than one site.
     * `const [id] = await sequelize.query(..., { type: INSERT })` is correct on
     * MySQL and silently yields nothing on Postgres, and the damage depends
     * entirely on what the id is used for next — a null in a response here, a
     * truncated statement and a 500 there.
     */
    const fs = require('fs');
    const walk = (dir, out = []) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith('.js')) out.push(full);
      }
      return out;
    };
    const offenders = [];
    for (const file of [...walk('services'), ...walk('shared')]) {
      const src = fs.readFileSync(file, 'utf8');
      const re = /const \[\s*\w+[^\]]*\]\s*=\s*await sequelize\.query\(/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        // Only THIS call's own arguments: walk to its matching close paren, or
        // a SELECT twenty lines above an INSERT gets blamed for it.
        let depth = 0;
        let end = m.index + m[0].length - 1;
        for (; end < src.length; end += 1) {
          if (src[end] === '(') depth += 1;
          else if (src[end] === ')') { depth -= 1; if (depth === 0) break; }
        }
        const body = src.slice(m.index, end);
        if (/type:\s*QueryTypes\.INSERT/.test(body)) {
          offenders.push(`${file}:${src.slice(0, m.index).split('\n').length}`);
        }
      }
    }
    check('No file destructures an INSERT result for its id',
      offenders.length === 0,
      offenders.length ? offenders.join('\n        ') : 'scanned services/ and shared/');
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);

  await sequelize.close();
  process.exitCode = fail ? 1 : 0;
  const drop = new Client({ ...PG, database: 'postgres' });
  await drop.connect();
  await drop.query(`DROP DATABASE IF EXISTS ${DB}`);
  await drop.end();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

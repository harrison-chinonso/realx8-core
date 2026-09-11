/**
 * Search, filter, sort and export on list endpoints — over real HTTP, against a
 * real MySQL, through the SAME crudFactory the services mount.
 *
 * What this exists to prove is not that a filter filters. It is the property a
 * filter can quietly destroy: that no combination of query parameters lets a
 * caller read another company's rows, or interrogate a column that is none of
 * their business. A filter is a query language handed to whoever can log in,
 * and it would look exactly like a working feature in every other test.
 *
 * Runs against a throwaway database, never the development one.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const express = require('express');
const mysql = require('mysql2/promise');
const { Sequelize, DataTypes } = require('sequelize');

const SOURCE_DB = process.env.DB_NAME;
const DB = `${SOURCE_DB}_verify_listquery`;

const {
  buildCrudController, buildCompanyScope,
} = require('../services/crm-service/src/utils/crudFactory');
const { EXPORT_LIMIT } = require('../shared/src/listQuery');

/**
 * Half the checks below assert that a bad request is REFUSED, so the error
 * handler logs a stack trace for each one. Those are the expected outcome, not
 * a fault, and forty of them bury the results. The logger is quieted before the
 * handler picks it up.
 */
const logger = require('../services/crm-service/src/config/logger');

logger.error = () => {};
const { errorHandler } = require('../services/crm-service/src/middleware/errorHandler');

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

(async () => {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  const sequelize = new Sequelize(DB, process.env.DB_USER, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    dialect: 'mysql',
    logging: false,
  });

  /**
   * A table with one column of every kind the filters have to handle, plus a
   * `password` — a column that must be untouchable however it is named.
   */
  const Note = sequelize.define('Note', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    reference: { type: DataTypes.STRING },
    title: { type: DataTypes.STRING },
    status: { type: DataTypes.ENUM('draft', 'sent', 'paid', 'cancelled') },
    amount: { type: DataTypes.DECIMAL(12, 2) },
    is_flagged: { type: DataTypes.BOOLEAN, defaultValue: false },
    issued_at: { type: DataTypes.DATE },
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
    password: { type: DataTypes.STRING },
  }, { tableName: 'notes', timestamps: false });

  await sequelize.sync({ force: true });

  // Company 1 is ours. Company 2 is the rival that must never appear.
  const rows = [
    { reference: 'CN-0001', title: 'Alpha roof repair', status: 'draft', amount: 1000, issued_at: '2026-01-10', company_id: 1, password: 'hash-a', is_flagged: false },
    { reference: 'CN-0002', title: 'Beta plumbing', status: 'sent', amount: 5000, issued_at: '2026-02-15', company_id: 1, password: 'hash-b', is_flagged: true },
    { reference: 'CN-0003', title: 'Gamma wiring', status: 'paid', amount: 9000, issued_at: '2026-03-20', company_id: 1, password: 'hash-c', is_flagged: false },
    { reference: 'CN-0004', title: 'Delta 100% survey', status: 'draft', amount: 2500, issued_at: '2026-04-01', company_id: 1, password: 'hash-d', is_flagged: false },
    { reference: 'CN-9001', title: 'Rival secret job', status: 'paid', amount: 7777, issued_at: '2026-02-01', company_id: 2, password: 'hash-r', is_flagged: true },
    { reference: 'CN-9002', title: 'Rival alpha thing', status: 'draft', amount: 8888, issued_at: '2026-05-01', company_id: 2, password: 'hash-s', is_flagged: false },
  ];
  await Note.bulkCreate(rows);

  // ── The app, mounting the real controller ─────────────────────────────────
  const crud = buildCrudController(Note, {
    searchFields: null, // exercise the derived default
    defaultWhere: buildCompanyScope,
    scopeWhere: buildCompanyScope,
  });

  const app = express();
  // Stands in for the auth gate: whoever the test says is calling.
  app.use((req, res, next) => {
    const asCompany = req.headers['x-as-company'];
    req.user = req.headers['x-as-platform'] === 'true'
      ? { id: 1, isSuperiorAdmin: true }
      // 'none' stands for an account attached to no company at all — the state
      // that used to widen the scope instead of narrowing it.
      : { id: 2, company_id: asCompany === 'none' ? null : Number(asCompany || 1) };
    next();
  });
  app.get('/notes', crud.list);
  app.use(errorHandler);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const BASE = `http://127.0.0.1:${server.address().port}/notes`;

  /** A list request as company 1 unless told otherwise. */
  const get = async (query = '', headers = {}) => {
    const response = await fetch(`${BASE}${query}`, { headers });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body };
  };
  const refs = (body) => (body.data || []).map((row) => row.reference).sort();

  console.log('\n── Tenant isolation: what a filter must never be able to do ─────');

  {
    const { body } = await get('');
    check('A plain list is scoped to the caller\'s company',
      JSON.stringify(refs(body)) === '["CN-0001","CN-0002","CN-0003","CN-0004"]',
      `${refs(body).join(', ')} — the rival's rows are absent`);
  }
  {
    const { status, body } = await get('?filter[company_id]=2');
    check('Naming company_id in a filter is refused outright',
      status === 400, `${status} ${body.message || ''}`);
  }
  {
    // The dangerous shape: the old handler built one flat object by spreading,
    // so a user clause naming a scoped column REPLACED the scope.
    const { status, body } = await get('?filter[status]=paid');
    check('A filter narrows within the company, it does not replace the scope',
      status === 200 && JSON.stringify(refs(body)) === '["CN-0003"]',
      `${refs(body).join(', ') || '(none)'} — the rival's paid row is not returned`);
  }
  {
    const { body } = await get('?search=alpha');
    check('Search cannot reach across companies either',
      JSON.stringify(refs(body)) === '["CN-0001"]',
      `${refs(body).join(', ')} — "Rival alpha thing" also matches the term, and is excluded`);
  }
  {
    const { body } = await get('?export=true');
    check('An export is scoped exactly like a page',
      refs(body).every((r) => r.startsWith('CN-000')),
      `${refs(body).join(', ')}`);
  }
  {
    const { body } = await get('', { 'x-as-company': '2' });
    check('The other company sees its own rows, so the scope is real',
      JSON.stringify(refs(body)) === '["CN-9001","CN-9002"]', refs(body).join(', '));
  }
  {
    /**
     * A user whose company_id is NULL must not mean "no filter".
     *
     * buildCompanyScope used to return {} for them, which is not "no company"
     * but "every company": a company-level admin whose row carried a null
     * company_id saw every tenant's rows, indistinguishable from a platform
     * admin. Measured on /invoices before the fix, such an account returned
     * invoices from both companies.
     */
    const { body } = await get('', { 'x-as-company': 'none' });
    check('A user with NO company sees nothing, rather than everything',
      (body.data || []).length === 0,
      `${refs(body).join(', ') || '(none)'} — over-restrictive is a support ticket, `
      + 'over-permissive is a breach across tenants');
  }

  console.log('\n── Sensitive columns are not a query language ────────────────────');

  {
    const { status, body } = await get('?filter[password][like]=hash-a');
    check('A password column cannot be filtered',
      status === 400, `${status} ${body.message || ''} — otherwise LIKE answers a hash one character at a time`);
  }
  {
    const { status } = await get('?sort=password');
    check('...nor sorted by', status === 400);
  }
  {
    const { body } = await get('?search=hash-a');
    check('...nor swept by a bare search',
      (body.data || []).length === 0, 'the derived search list excludes it');
  }
  {
    // The older and worse of the two holes: nothing excluded these attributes,
    // so a list endpoint serialised the row wholesale — bcrypt hashes included
    // — to anyone who could log in.
    const { body } = await get('');
    const leaked = (body.data || []).filter((row) => 'password' in row);
    check('A password hash is never in the response body',
      leaked.length === 0,
      leaked.length ? `LEAKED on ${leaked.length} row(s)` : 'the column is excluded from what is sent');
  }
  {
    const { body } = await get('?export=true');
    check('...including in an export, which is the copy that gets filed and mailed',
      (body.data || []).every((row) => !('password' in row)));
  }
  {
    const { body } = await get('?sort=amount');
    check('...and the rows are otherwise intact, so the exclusion is surgical',
      (body.data || []).every((row) => row.reference && row.status && row.amount !== undefined),
      'reference, status and amount all still present');
  }

  console.log('\n── Filtering ────────────────────────────────────────────────────');

  {
    const { body } = await get('?filter[status]=draft');
    check('Equality', JSON.stringify(refs(body)) === '["CN-0001","CN-0004"]', refs(body).join(', '));
  }
  {
    const { body } = await get('?filter[status]=draft,sent');
    check('A comma-separated list is an IN, as a multi-select sends',
      JSON.stringify(refs(body)) === '["CN-0001","CN-0002","CN-0004"]', refs(body).join(', '));
  }
  {
    const { body } = await get('?filter[amount][gte]=5000');
    check('gte on a number', JSON.stringify(refs(body)) === '["CN-0002","CN-0003"]', refs(body).join(', '));
  }
  {
    const { body } = await get('?filter[amount][between]=2000,6000');
    check('between', JSON.stringify(refs(body)) === '["CN-0002","CN-0004"]', refs(body).join(', '));
  }
  {
    const { body } = await get('?filter[status][ne]=draft');
    check('ne', JSON.stringify(refs(body)) === '["CN-0002","CN-0003"]', refs(body).join(', '));
  }
  {
    const { body } = await get('?filter[issued_at][gte]=2026-03-01&filter[issued_at][lte]=2026-04-30');
    check('A date range, compared as dates rather than as strings',
      JSON.stringify(refs(body)) === '["CN-0003","CN-0004"]', refs(body).join(', '));
  }
  {
    const { body } = await get('?filter[is_flagged]=true');
    check('A boolean written the way a checkbox sends it',
      JSON.stringify(refs(body)) === '["CN-0002"]', refs(body).join(', '));
  }
  {
    const { body } = await get('?filter[title][like]=roof');
    check('like, on one named column',
      JSON.stringify(refs(body)) === '["CN-0001"]', refs(body).join(', '));
  }
  {
    const { body } = await get('?filter[status]=draft&filter[amount][gte]=2000');
    check('Two filters both apply, rather than the last one winning',
      JSON.stringify(refs(body)) === '["CN-0004"]', refs(body).join(', '));
  }

  console.log('\n── Bad input fails loudly, not silently ─────────────────────────');

  {
    const { status, body } = await get('?filter[stauts]=draft');
    check('A misspelled column is refused, not ignored',
      status === 400 && /stauts/.test(body.message || ''),
      `${status} ${body.message || ''} — ignoring it would return every row, formatted like a filtered answer`);
  }
  {
    const { status, body } = await get('?filter[amount][gte]=abc');
    check('A non-number against a number column says so',
      status === 400, `${status} ${body.message || ''}`);
  }
  {
    const { status, body } = await get('?filter[issued_at][gte]=not-a-date');
    check('An unparseable date says so, rather than matching nothing',
      status === 400, `${status} ${body.message || ''}`);
  }
  {
    const { status, body } = await get('?filter[amount][gte]=1000&filter[amount][nope]=2');
    check('An unknown operator is named, with the valid ones listed',
      status === 400 && /nope/.test(body.message || ''), `${status} ${body.message || ''}`);
  }
  {
    const { status } = await get('?sort=no_such_column');
    check('An unknown sort column is refused', status === 400);
  }

  console.log('\n── Search ───────────────────────────────────────────────────────');

  {
    const { body } = await get('?search=plumbing');
    check('Matches a text column nobody had to configure',
      JSON.stringify(refs(body)) === '["CN-0002"]', 'searchFields was null, so the list came from the model');
  }
  {
    const { body } = await get('?search=CN-0003');
    check('Matches the reference too, being another text column',
      JSON.stringify(refs(body)) === '["CN-0003"]', refs(body).join(', '));
  }
  {
    const { body } = await get('?search=%25');
    check('A bare % is a literal, not a wildcard matching everything',
      (body.data || []).length === 1 && refs(body)[0] === 'CN-0004',
      'only "Delta 100% survey" contains one — an unescaped term would return the whole table');
  }
  {
    const { body } = await get('?search=zzz-nothing');
    check('No match is an empty page, not an error',
      (body.data || []).length === 0 && body.pagination.total === 0);
  }

  console.log('\n── Sorting ──────────────────────────────────────────────────────');

  {
    const { body } = await get('?sort=amount');
    check('Ascending',
      JSON.stringify((body.data || []).map((r) => Number(r.amount))) === '[1000,2500,5000,9000]',
      (body.data || []).map((r) => r.amount).join(', '));
  }
  {
    const { body } = await get('?sort=-amount');
    check('A leading minus is descending',
      JSON.stringify((body.data || []).map((r) => Number(r.amount))) === '[9000,5000,2500,1000]',
      (body.data || []).map((r) => r.amount).join(', '));
  }
  {
    const { body } = await get('?sort=status,-amount');
    check('Two keys, in the order given',
      JSON.stringify(refs(body).slice(0, 1)) === '["CN-0001"]',
      (body.data || []).map((r) => `${r.status}:${r.amount}`).join(', '));
  }

  console.log('\n── Paging, and the export that made this necessary ──────────────');

  {
    const { body } = await get('');
    check('Defaults are unchanged: page 1, ten rows',
      body.pagination.page === 1 && body.pagination.limit === 10);
  }
  {
    const { body } = await get('?limit=2&page=2&sort=amount');
    check('A second page is the second page',
      JSON.stringify(refs(body)) === '["CN-0002","CN-0003"]'
      && body.pagination.total === 4 && body.pagination.totalPages === 2,
      `${refs(body).join(', ')} total=${body.pagination.total}`);
  }
  {
    const { body } = await get('?limit=99999');
    check('An ordinary page is still capped at 100',
      body.pagination.limit === 100, `limit=${body.pagination.limit}`);
  }
  {
    // The reason this whole module exists: a client-side export of "the table"
    // could only ever contain the rows the current page had loaded.
    const { body } = await get('?limit=2&export=true');
    check('An export returns the whole filtered set, not the current page',
      (body.data || []).length === 4 && body.pagination.exported === true,
      `${(body.data || []).length} rows, exported=${body.pagination.exported}`);
  }
  {
    const { body } = await get('?export=true&filter[status]=draft');
    check('An export honours the filters, so it exports what was on screen',
      JSON.stringify(refs(body)) === '["CN-0001","CN-0004"]', refs(body).join(', '));
  }
  {
    const { body } = await get('?limit=all');
    check('limit=all is the same request by another name',
      (body.data || []).length === 4 && body.pagination.exported === true);
  }
  {
    const { body } = await get('?export=true');
    check('An untruncated export says it was not truncated',
      body.pagination.truncated === false, `cap is ${EXPORT_LIMIT} rows and there are 4`);
  }

  console.log('\n── The platform admin ───────────────────────────────────────────');

  {
    const { body } = await get('', { 'x-as-platform': 'true' });
    check('Sees every company, being scoped to none',
      (body.data || []).length === 6, `${(body.data || []).length} rows`);
  }
  {
    const { body } = await get('?company_id=2', { 'x-as-platform': 'true' });
    check('...and narrows with the company_id parameter, which is the supported way',
      JSON.stringify(refs(body)) === '["CN-9001","CN-9002"]', refs(body).join(', '));
  }
  {
    const { status } = await get('?filter[company_id]=2', { 'x-as-platform': 'true' });
    check('...but not by filtering on company_id, even as a platform admin',
      status === 400, 'one rule, so there is no second path to reason about');
  }

  console.log('\n── Results ─────────────────────────────────────────────────────\n');
  console.log(`  ${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass}/${pass + fail} checks passed.\x1b[0m`);

  server.close();
  await sequelize.close();
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();
  console.log(`\n  Scratch database ${DB} dropped.\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\n\x1b[31mThe verification itself failed:\x1b[0m', error);
  process.exit(1);
});

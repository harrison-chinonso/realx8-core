/**
 * The audit trail: recording it, scoping it, and not being able to change it.
 *
 * Every administrative action is recorded by middleware in the request pipeline
 * rather than by a call at each of the roughly three hundred routes that change
 * something — see shared/src/audit.js for why. That decision is what these
 * checks are really testing, because it has three failure modes that a glance
 * at the code will not show you:
 *
 *   something that should have been recorded was silently skipped
 *   something that should NEVER be recorded — a password — was
 *   one company's activity was visible to another
 *
 * And one guarantee that has to hold against the database, not against this
 * codebase: an entry cannot be edited or deleted, by anyone, ever.
 *
 * Drives the REAL middleware and the REAL controller against a throwaway
 * database.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const express = require('express');
const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_audit`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }

// Point the service's models at the scratch database BEFORE anything requires
// them — config/database.js reads this at require time.
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifyaudit';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

/** Calls an express handler and captures what it answered. */
const callController = async (handler, req) => {
  let status = 200; let body = null;
  const res = {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
    set() { return this; },
  };
  await handler({ query: {}, params: {}, body: {}, ...req }, res, (error) => { throw error; });
  return { status, body };
};

/** The middleware writes AFTER the response, so give the insert a moment. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 250); });

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

  const { sequelize, AuditLog } = require('../services/user-service/src/models');
  const { createAuditor } = require('../shared/src/audit');
  const { describeRequest } = require('../shared/src/auditCatalog');
  const createAuditTable = require('../services/user-service/src/migrations/createAuditLog');

  await createAuditTable(sequelize);

  // ── A miniature application, wired exactly as a real service is ────────────
  const { auditMiddleware } = createAuditor(sequelize);
  const app = express();
  app.use(express.json());
  app.use(auditMiddleware());
  // Stands in for the edge's auth gate: whoever the test says is calling.
  let currentUser = null;
  app.use((req, res, next) => { if (currentUser) req.user = currentUser; next(); });

  app.post('/api/properties/:id/approve', (req, res) => res.json({ data: { id: Number(req.params.id), name: 'Riverside Plot' } }));
  app.put('/api/users/:id', (req, res) => res.json({ data: { id: Number(req.params.id), name: req.body.name } }));
  app.post('/api/users', (req, res) => res.status(201).json({ data: { id: 99, name: req.body.name } }));
  app.delete('/api/invoices/:id', (req, res) => res.json({ message: 'gone' }));
  app.get('/api/properties', (req, res) => res.json({ data: [] }));
  app.post('/api/auth/refresh', (req, res) => res.json({ data: { ok: true } }));
  app.post('/api/notifications/12/read', (req, res) => res.json({ data: { ok: true } }));
  app.post('/api/properties/5/reject', (req, res) => res.status(403).json({ message: 'nope' }));
  app.post('/api/settings', (req, res) => {
    req.audit({ entity_label: 'Company name', metadata: { changed: { from: 'Old', to: req.body.value } } });
    res.json({ data: { id: 3 } });
  });

  const server = app.listen(0);
  const port = server.address().port;
  const request = (method, url, { body, user } = {}) => {
    currentUser = user ?? null;
    return fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  };

  const ADMIN_1 = { id: 5, name: 'Ada Admin', email: 'ada@acme.test', type: 'super_admin', company_id: 1 };
  const ADMIN_2 = { id: 6, name: 'Bo Admin', email: 'bo@rival.test', type: 'super_admin', company_id: 2 };
  const PLATFORM = { id: 1, name: 'Platform', email: 'root@realx8.test', type: 'superior_admin', company_id: null, isSuperiorAdmin: true };

  console.log('\n── An action is recorded without anyone calling a logger ────────');

  await request('POST', '/api/properties/12/approve', { user: ADMIN_1 });
  await settle();
  let rows = await AuditLog.findAll({ order: [['id', 'ASC']] });
  const approval = rows[0];
  check('Approving a property produced an entry', rows.length === 1, `${rows.length} row(s)`);
  check('...named after what was done', approval?.action === 'properties.approve', approval?.action);
  check('...in words, not just a route', approval?.action_label === 'Approved a property', approval?.action_label);
  check('...naming who did it', approval?.actor_name === 'Ada Admin' && approval?.actor_id === 5,
    `${approval?.actor_name} (#${approval?.actor_id}, ${approval?.actor_type})`);
  check('...naming which company it affected', approval?.company_id === 1, String(approval?.company_id));
  check('...naming what it was done to',
    approval?.entity_type === 'property' && approval?.entity_id === '12',
    `${approval?.entity_type} #${approval?.entity_id}`);
  check('...and when', approval?.created_at instanceof Date, String(approval?.created_at));
  check('...under the name everything else spells it',
    Object.hasOwn(approval.toJSON(), 'created_at'),
    'the screen, the sort and the date filter all read created_at');

  console.log('\n── A route nobody has thought about is still recorded ───────────');

  {
    /**
     * The point of deriving the name from the route: a route added next month
     * appears in the trail with no edit to any catalogue. This is the check
     * that would fail if somebody replaced the scheme with a hand-kept table.
     */
    const invented = describeRequest('POST', '/api/widgets/4/refurbish');
    check('An invented route still gets a sensible action name',
      invented?.action === 'widgets.refurbish.create' && invented?.entity_id === '4',
      JSON.stringify(invented));
  }

  console.log('\n── What must NEVER be recorded ─────────────────────────────────');

  await request('POST', '/api/users', {
    user: ADMIN_1,
    body: { name: 'New Person', email: 'new@acme.test', password: 'hunter2', passcode: '123456' },
  });
  await settle();
  rows = await AuditLog.findAll({ order: [['id', 'ASC']] });
  const created = rows[rows.length - 1];
  const metadata = JSON.parse(created.metadata || '{}');
  check('A password is replaced, not stored',
    metadata.requested?.password === '[redacted]',
    JSON.stringify(metadata.requested));
  check('...and so is anything else shaped like a credential',
    metadata.requested?.passcode === '[redacted]');
  check('The rest of the change IS kept — it is the record',
    metadata.requested?.name === 'New Person' && metadata.requested?.email === 'new@acme.test');
  check('The new record is identified by what it returned',
    created.entity_id === '99', `entity_id=${created.entity_id}`);
  check('...and labelled the way a person would name it',
    created.entity_label === 'New Person', created.entity_label);

  console.log('\n── What must not fill the trail with noise ──────────────────────');

  const before = await AuditLog.count();
  await request('GET', '/api/properties', { user: ADMIN_1 });
  await request('POST', '/api/auth/refresh', { user: ADMIN_1 });
  await request('POST', '/api/notifications/12/read', { user: ADMIN_1 });
  await request('POST', '/api/properties/12/approve');           // nobody signed in
  await request('POST', '/api/properties/5/reject', { user: ADMIN_1 }); // refused, 403
  await settle();
  check('Reading something is not activity', await AuditLog.count() === before,
    'a GET changes nothing, and recording every one would bury what did');
  check('A token refresh is machinery, not an administrator’s decision',
    !(await AuditLog.findOne({ where: { action: 'auth.refresh' } })),
    'the /api prefix is stripped before the skip list is consulted');
  check('Marking a notification read is not activity',
    !(await AuditLog.findOne({ where: { module: 'notifications' } })));
  check('An unauthenticated request attributes nobody, so records nothing',
    !(await AuditLog.findOne({ where: { actor_id: null } })));
  check('A REFUSED action is not recorded as an action',
    !(await AuditLog.findOne({ where: { action: 'properties.reject' } })),
    'otherwise a reader cannot tell what happened from what was attempted');

  console.log('\n── A controller can add what the route cannot know ──────────────');

  await request('POST', '/api/settings', { user: ADMIN_1, body: { key: 'app_name', value: 'New Name' } });
  await settle();
  const setting = await AuditLog.findOne({ where: { action: 'settings.create' } });
  const settingMeta = JSON.parse(setting?.metadata || '{}');
  check('req.audit() enriches the entry the middleware was writing anyway',
    setting?.entity_label === 'Company name' && settingMeta.changed?.to === 'New Name',
    JSON.stringify(settingMeta));
  check('...without displacing what was submitted',
    settingMeta.requested?.key === 'app_name');

  console.log('\n── One company must never see another’s ─────────────────────────');

  await request('PUT', '/api/users/77', { user: ADMIN_2, body: { name: 'Rival Person' } });
  await request('DELETE', '/api/invoices/31', { user: PLATFORM, body: {} });
  await settle();

  const controller = require('../services/user-service/src/controllers/auditController');
  const listFor = async (user, query = {}) => (await callController(
    controller.listAuditLogs, { user, query: { limit: 100, ...query } },
  )).body;

  const asAdmin1 = await listFor(ADMIN_1);
  const asAdmin2 = await listFor(ADMIN_2);
  const asPlatform = await listFor(PLATFORM);

  check('A company administrator sees their own company',
    asAdmin1.data.length > 0 && asAdmin1.data.every((r) => r.company_id === 1),
    `${asAdmin1.data.length} rows, all company 1`);
  check('...and none of anybody else’s',
    !asAdmin1.data.some((r) => r.company_id === 2),
    'the scope is a WHERE clause the caller cannot influence');
  check('The other company sees only its own',
    asAdmin2.data.length > 0 && asAdmin2.data.every((r) => r.company_id === 2),
    `${asAdmin2.data.length} rows, all company 2`);
  check('A platform administrator sees every company',
    asPlatform.data.length === await AuditLog.count(),
    `${asPlatform.data.length} of ${await AuditLog.count()}`);
  check('...and can narrow to one',
    (await listFor(PLATFORM, { company_id: 2 })).data.every((r) => r.company_id === 2));

  {
    const theirs = asAdmin2.data[0];
    const reach = await callController(controller.getAuditLog, {
      user: ADMIN_1, params: { id: theirs.id },
    });
    check('An entry belonging to another company is simply not found',
      reach.status === 404,
      'the same answer as a non-existent id, so the endpoint cannot be probed');
  }

  check('The list omits the detail blob it would otherwise send on every row',
    !Object.hasOwn(asAdmin1.data[0], 'metadata'),
    'it is the largest column and nothing on the list renders it');
  {
    const one = await callController(controller.getAuditLog, {
      user: ADMIN_1, params: { id: asAdmin1.data[0].id },
    });
    check('...and one entry carries it, parsed',
      typeof one.body.data.metadata === 'object');
  }

  console.log('\n── An audit cannot be edited or deleted ─────────────────────────');

  const target = await AuditLog.findOne();
  // Captured before anything tries to change it: a rejected `update()` still
  // sets the attribute on the in-memory instance before the hook refuses, so
  // comparing against `target.action` afterwards would compare it to the
  // tampered value rather than the stored one.
  const untouched = target.action;

  {
    let refused = false;
    try { await target.update({ action: 'tampered' }); } catch { refused = true; }
    check('The model refuses an update', refused);
  }
  {
    let refused = false;
    try { await target.destroy(); } catch { refused = true; }
    check('The model refuses a delete', refused);
  }
  {
    /**
     * The one that actually matters. The two above only bind code that goes
     * through this model — they say nothing about another service, a migration,
     * or somebody at a database prompt.
     */
    let refused = false;
    try {
      await sequelize.query(`UPDATE audit_logs SET action = 'tampered' WHERE id = ${target.id}`);
    } catch { refused = true; }
    check('The DATABASE refuses an update, whatever issues it', refused,
      'a trigger, so it holds against a direct connection too');

    refused = false;
    try {
      await sequelize.query(`DELETE FROM audit_logs WHERE id = ${target.id}`);
    } catch { refused = true; }
    check('The DATABASE refuses a delete', refused);

    const after = await AuditLog.findByPk(target.id);
    check('...and the entry is still there, unchanged',
      after && after.action === untouched, `${after?.action} (was ${untouched})`);
  }

  check('There is no route that writes one',
    (() => {
      const routes = require('../services/user-service/src/routes/auditRoutes');
      return routes.stack.every((layer) => Object.keys(layer.route?.methods || { get: true }).every((m) => m === 'get'));
    })(),
    'reading is the only thing the API offers');

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

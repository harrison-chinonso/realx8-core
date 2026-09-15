/**
 * Branches: one per property, never another company's, and closing one releases
 * the properties rather than taking them with it.
 *
 * ── The three rules, and which one has no symptom ───────────────────────────
 *
 *   1. A property is in at most ONE branch. Enforced by the schema — a single
 *      `branch_id` column — so it is checked here only to prove the column is
 *      what the model actually uses, not to prove arithmetic.
 *
 *   2. A property may only be assigned to a branch of its OWN company. A
 *      foreign key can say branch 7 exists; it cannot say whose it is. This is
 *      the rule with no symptom: a property filed under a stranger's office
 *      looks exactly like a property filed correctly, right up until that
 *      company opens its branch report and finds somebody else's estate in it.
 *
 *   3. Closing a branch unassigns its properties. The branch is soft-deleted,
 *      so the foreign key never fires and the controller has to do it. Left
 *      undone, every property would point at a branch that appears in no list
 *      and render a blank where the office name goes.
 *
 * Driven through the REAL controllers with req/res doubles — the rules live in
 * the controller, and a test that reimplemented them would pass whatever the
 * controller did.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_branches`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifybranches';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

const capture = () => {
  const out = { statusCode: 200, body: null };
  out.status = (code) => { out.statusCode = code; return out; };
  out.json = (body) => { out.body = body; return out; };
  return out;
};

/** Runs a controller and reports what it did, including how it failed. */
const call = async (handler, req) => {
  const res = capture();
  let thrown = null;
  await handler(req, res, (err) => { thrown = err; });
  return { ...res, thrown };
};

const ACME = { id: 10, type: 'admin', company_id: 1 };
const ZULU = { id: 20, type: 'admin', company_id: 2 };

(async () => {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  const models = require('../services/property-service/src/models');
  const { sequelize, Branch, Property } = models;
  await sequelize.sync({ force: true });
  await require('../services/property-service/src/migrations/linkPropertiesToBranches')(sequelize);

  const { branchCrud, listBranchProperties } = require('../services/property-service/src/controllers/branchController');
  const { propertyCrud } = require('../services/property-service/src/controllers/propertyController');

  console.log('\n── A company opens an office ────────────────────────────────────');
  let acmeBranch; let zuluBranch;
  {
    const created = await call(branchCrud.create, {
      user: ACME, body: { name: 'Lekki Office', address: '12 Admiralty Way, Lekki' }, query: {},
    });
    acmeBranch = created.body?.data;
    check('A branch is created with a name and an office address',
      created.statusCode === 201 && acmeBranch?.name === 'Lekki Office'
        && acmeBranch?.address === '12 Admiralty Way, Lekki',
      JSON.stringify({ name: acmeBranch?.name, address: acmeBranch?.address }));
    check('...scoped to the company that created it',
      Number(acmeBranch?.company_id) === 1, `company_id=${acmeBranch?.company_id}`);

    const other = await call(branchCrud.create, {
      user: ZULU, body: { name: 'Ikoyi Office', address: '3 Kingsway Road' }, query: {},
    });
    zuluBranch = other.body?.data;

    const acmeList = await call(branchCrud.list, { user: ACME, query: {} });
    const names = (acmeList.body?.data || []).map((row) => row.name);
    check('One company never sees another’s branches',
      names.length === 1 && names[0] === 'Lekki Office', JSON.stringify(names));
  }

  console.log('\n── A property goes in exactly one branch ────────────────────────');
  let property;
  {
    const created = await call(propertyCrud.create, {
      user: ACME, body: { name: 'The Loundasian', branch_id: acmeBranch.id }, query: {},
    });
    property = created.body?.data;
    check('A property can be assigned to a branch as it is created',
      Number(property?.branch_id) === Number(acmeBranch.id),
      `branch_id=${property?.branch_id}`);

    /*
     * "Only one branch" is not arithmetic to be checked — it is the shape of
     * the table. Reassigning MOVES the property; there is nowhere for a second
     * assignment to go.
     */
    const second = await Branch.create({ name: 'Ajah Office', company_id: 1 });
    await call(propertyCrud.update, {
      user: ACME, params: { id: property.id }, body: { branch_id: second.id }, query: {},
    });
    await property.reload();
    check('Assigning a second branch MOVES it rather than adding one',
      Number(property.branch_id) === Number(second.id), `branch_id=${property.branch_id}`);

    const inFirst = await Property.count({ where: { branch_id: acmeBranch.id } });
    check('...so the first branch no longer runs it', inFirst === 0, `${inFirst} still in the first branch`);

    // Put it back for the tests below.
    await property.update({ branch_id: acmeBranch.id });
  }

  console.log('\n── ...and never another company’s branch ────────────────────────');
  {
    const attempt = await call(propertyCrud.update, {
      user: ACME, params: { id: property.id }, body: { branch_id: zuluBranch.id }, query: {},
    });
    await property.reload();

    check('Assigning another company’s branch is refused',
      Boolean(attempt.thrown) && attempt.thrown.status === 400,
      attempt.thrown ? attempt.thrown.message : 'no error raised');
    check('...and the property keeps the branch it had',
      Number(property.branch_id) === Number(acmeBranch.id),
      `branch_id=${property.branch_id}`);

    /*
     * Refused, not silently dropped. Storing null would have looked like the
     * assignment worked until somebody opened the branch and found it missing.
     */
    check('...rather than being quietly unassigned',
      property.branch_id !== null);

    const created = await call(propertyCrud.create, {
      user: ACME, body: { name: 'Cross-tenant attempt', branch_id: zuluBranch.id }, query: {},
    });
    check('The same refusal applies at creation',
      Boolean(created.thrown) && created.thrown.status === 400,
      created.thrown ? created.thrown.message : 'no error raised');
  }

  console.log('\n── Unassigning, and closing an office ───────────────────────────');
  {
    await call(propertyCrud.update, {
      user: ACME, params: { id: property.id }, body: { branch_id: '' }, query: {},
    });
    await property.reload();
    check('An empty value clears the assignment', property.branch_id === null);

    await call(propertyCrud.update, {
      user: ACME, params: { id: property.id }, body: { branch_id: acmeBranch.id }, query: {},
    });
    await property.reload();

    /*
     * The distinction that matters: a form that does not mention branch_id must
     * leave it alone. Treating absent as "clear it" would unassign every
     * property whenever anybody edited its name.
     */
    await call(propertyCrud.update, {
      user: ACME, params: { id: property.id }, body: { name: 'The Loundasian Estate' }, query: {},
    });
    await property.reload();
    check('An edit that does not mention the branch leaves it alone',
      Number(property.branch_id) === Number(acmeBranch.id),
      `branch_id=${property.branch_id}`);

    const listed = await call(listBranchProperties, { user: ACME, params: { id: acmeBranch.id }, query: {} });
    check('A branch can list what it runs',
      (listed.body?.data || []).length === 1, JSON.stringify((listed.body?.data || []).map((p) => p.name)));

    const denied = await call(listBranchProperties, { user: ZULU, params: { id: acmeBranch.id }, query: {} });
    check('...and another company cannot list it', denied.statusCode === 404);

    await call(branchCrud.remove, { user: ACME, params: { id: acmeBranch.id }, query: {} });
    await property.reload();
    check('Closing a branch releases its properties', property.branch_id === null,
      `branch_id=${property.branch_id}`);
    check('...and does not delete them',
      (await Property.findByPk(property.id)) !== null);
  }

  console.log('\n── The migration is safe to run twice ───────────────────────────');
  {
    let err = null;
    try {
      await require('../services/property-service/src/migrations/linkPropertiesToBranches')(sequelize);
      await require('../services/property-service/src/migrations/linkPropertiesToBranches')(sequelize);
    } catch (error) { err = error; }
    check('Running it again on a database it has already done is a no-op',
      err === null, err ? err.message : '');
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await sequelize.close();
  await admin.query(`DROP DATABASE \`${DB}\``);
  await admin.end();
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

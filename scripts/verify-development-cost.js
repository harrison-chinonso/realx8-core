/**
 * What a project cost, and when a sale becomes revenue (ACC-10 and ACC-8).
 *
 * ── Why the two are verified in one file ────────────────────────────────────
 *
 * Because they post in one journal. Deferring revenue to handover while the
 * costs hit the P&L as contractors are paid would report eighteen months of
 * losses and then a month of pure margin with no cost against it — worse than
 * recognising everything on the invoice date, because it is wrong in a way
 * that looks deliberate. A test suite that checked them separately could pass
 * twice over while the books said that.
 *
 * ── The checks worth writing this file for ──────────────────────────────────
 *
 * That an allocation of an awkward pool across awkward units sums to the pool
 * EXACTLY, because a control account out by a few kobo per project is one no
 * accountant can sign.
 *
 * That a cost landing after a unit has gone is charged to it rather than
 * sitting in work in progress for ever — the failure that makes a WIP balance
 * grow with nothing to explain it.
 *
 * That output tax is NOT touched at handover. It followed the tax point when
 * the invoice was raised, and charging it again is the single most common
 * place this design goes wrong in other systems.
 *
 * And that a write-down cannot be typed. It follows from a stated expectation
 * of what the project will fetch, or it is refused — otherwise it is an
 * earnings lever wearing an accounting standard's name.
 *
 * Drives the REAL controllers against a throwaway database.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { QueryTypes } = require('sequelize');
const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_development`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifydev';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};
const show = (minor) => `₦${(Number(minor) / 100).toLocaleString('en-US')}`;

const COMPANY = 1;
const PROJECT = 7;

const run = (handler, req) => new Promise((resolve) => {
  let code = 200;
  const res = {
    status(c) { code = c; return res; },
    json(body) { resolve({ code, body }); return res; },
  };
  Promise.resolve(handler(req, res, (err) => resolve({ code: 500, body: { error: err } })))
    .catch((err) => resolve({ code: 500, body: { error: err } }));
});

(async () => {
  // ── The arithmetic, with no database at all (ACC-10.3) ────────────────────
  console.log('\n── ACC-10.3  The allocation, as pure arithmetic ────────────────');
  {
    const { allocate, BASIS } = require('../shared/src/accounting/costAllocation');

    /*
     * A pool that does not divide and units that do not either. 1,000,000,001
     * kobo across three units of 333, 333 and 334 square metres is chosen
     * precisely because every naive implementation loses money on it.
     */
    const awkward = allocate(100000000001, [
      { id: 1, size: 333 }, { id: 2, size: 333 }, { id: 3, size: 334 },
    ], BASIS.SALEABLE_AREA);
    const sum = awkward.allocations.reduce((t, a) => t + a.allocated_minor, 0);
    check('An awkward pool lands entirely on the units',
      sum === 100000000001,
      `${awkward.allocations.map((a) => show(a.allocated_minor)).join(' + ')} = ${show(sum)}`);

    const again = allocate(100000000001, [
      { id: 3, size: 334 }, { id: 1, size: 333 }, { id: 2, size: 333 },
    ], BASIS.SALEABLE_AREA);
    const byId = (r) => [...r.allocations].sort((a, b) => a.unit_id - b.unit_id).map((a) => a.allocated_minor);
    check('...and the same pool allocated twice gives the same answer',
      JSON.stringify(byId(awkward)) === JSON.stringify(byId(again)),
      'an allocation that moved between runs would make every margin unexplainable');

    const byValue = allocate(100000000, [
      { id: 1, size: 100, price_minor: 90000000 },
      { id: 2, size: 100, price_minor: 10000000 },
    ], BASIS.SALES_VALUE);
    check('Sales value splits by price where area cannot tell units apart',
      byValue.allocations[0].allocated_minor === 90000000,
      `${show(byValue.allocations[0].allocated_minor)} / ${show(byValue.allocations[1].allocated_minor)}`);

    const noWeight = allocate(50000000, [{ id: 1, size: 0 }, { id: 2, size: 0 }], BASIS.SALEABLE_AREA);
    check('A project whose units have no area allocates NOTHING rather than guessing',
      noWeight.allocated_minor === 0 && noWeight.unallocated_minor === 50000000,
      'an even split would be an invented answer wearing the shape of a real one');
  }

  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  const models = require('../services/finance-service/src/models');
  const { sequelize } = models;
  const userModels = require('../services/user-service/src/models');
  const propertyModels = require('../services/property-service/src/models');

  await userModels.Company.sync({ force: true });
  await userModels.RealtorLevel.sync({ force: true });
  await userModels.User.sync({ force: true });
  await userModels.Setting.sync({ force: true });
  await userModels.Company.create({
    id: COMPANY, name: 'Development Test Co', slug: 'dev-test', email: 'dev@test',
  });
  await userModels.User.create({
    id: 501, name: 'Buyer One', email: 'buyer@test', password: 'x', type: 'client', company_id: COMPANY,
  });

  // Parents before children: `properties` has foreign keys into both.
  await propertyModels.Branch.sync({ force: true });
  await propertyModels.PropertyUnit.sync({ force: true });
  await propertyModels.Property.sync({ force: true });
  await propertyModels.PropertyUnits.sync({ force: true });
  await propertyModels.Property.create({
    id: PROJECT, name: 'Favour City Epe', type: 'estate', company_id: COMPANY, status: 'available',
  });
  /*
   * Three units, deliberately unequal: 400, 400 and 200 square metres, so the
   * split is 40/40/20 and a mistake in the weighting is visible rather than
   * hidden behind equal shares.
   */
  const UNITS = [
    { id: 11, property_id: PROJECT, name: 'Plot A', size: '400', price: 50000000, quantity: 1 },
    { id: 12, property_id: PROJECT, name: 'Plot B', size: '400', price: 50000000, quantity: 1 },
    { id: 13, property_id: PROJECT, name: 'Plot C', size: '200', price: 30000000, quantity: 1 },
  ];
  await propertyModels.PropertyUnits.bulkCreate(UNITS);

  await models.LedgerAccount.sync({ force: true });
  await models.JournalEntry.sync({ force: true });
  await models.JournalLine.sync({ force: true });
  await models.Vendor.sync({ force: true });
  await models.Bill.sync({ force: true });
  await models.Transaction.sync({ force: true });
  await models.ExpenseType.sync({ force: true });
  await models.AccountingPolicy.sync({ force: true });
  await models.Handover.sync({ force: true });
  // `invoices` points at both of these, so both have to exist first.
  await models.Tax.sync({ force: true });
  await models.ReminderSchedule.sync({ force: true });
  await models.Invoice.sync({ force: true });
  await models.InstallmentPlan.sync({ force: true });
  await models.InvoicePaymentPlan.sync({ force: true });

  await require('../services/finance-service/src/migrations/seedChartOfAccounts')(sequelize);
  await require('../services/finance-service/src/migrations/seedExpenseTypes')(sequelize);

  await userModels.Setting.create({
    group: 'accounting', key: 'post_to_ledger', value: 'true', company_id: COMPANY,
  });

  const ap = require('../services/finance-service/src/controllers/payablesController');
  const dev = require('../services/finance-service/src/controllers/developmentController');
  const ho = require('../services/finance-service/src/controllers/handoverController');
  const ledger = require('../shared/src/accounting/ledger');
  const { postEvent, recognitionFor } = require('../shared/src/accounting/posting');

  const RAISER = { id: 88, company_id: COMPANY, type: 'admin' };
  const APPROVER = { id: 89, company_id: COMPANY, type: 'admin' };

  const linesOf = async (entryId) => sequelize.query(
    'SELECT account_code, account_role, debit_minor, credit_minor, property_id '
    + 'FROM journal_lines WHERE entry_id = :id ORDER BY position',
    { replacements: { id: entryId }, type: QueryTypes.SELECT },
  );
  const entryFor = async (source) => {
    const [row] = await sequelize.query(
      'SELECT id, reference, debit_minor FROM journal_entries WHERE source = :source ORDER BY id DESC LIMIT 1',
      { replacements: { source }, type: QueryTypes.SELECT },
    );
    return row;
  };
  const balanceOf = async (role) => {
    const [row] = await sequelize.query(
      `SELECT COALESCE(SUM(l.debit_minor), 0) - COALESCE(SUM(l.credit_minor), 0) AS bal
         FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id
        WHERE a.role = :role`,
      { replacements: { role }, type: QueryTypes.SELECT },
    );
    return Number(row?.bal || 0);
  };

  const typeNamed = async (name) => {
    const [row] = await sequelize.query(
      'SELECT id, capitalisable FROM expense_types WHERE company_id = :c AND name = :name LIMIT 1',
      { replacements: { c: COMPANY, name }, type: QueryTypes.SELECT },
    );
    return row;
  };

  // ── ACC-10.2 ──────────────────────────────────────────────────────────────
  console.log('\n── ACC-10.2  Which costs belong to the building ────────────────');
  {
    const build = await typeNamed('Subcontractor works');
    const selling = await typeNamed('Selling and marketing');
    check('Seeded: subcontractor works capitalises', Boolean(build?.capitalisable), '');
    check('...and selling does not, which IAS 2.16 is explicit about',
      selling && !selling.capitalisable, '');

    const interest = await typeNamed('Finance and borrowing costs');
    check('Borrowing cost is seeded OFF, as a decision for an accountant to take',
      interest && !interest.capitalisable,
      'capitalising interest properly needs a rate and a project window, not a tick-box');
  }

  const vendor = await run(ap.createVendor, {
    user: RAISER, body: { name: 'Adeyemi Contractors', withholding_rate: 5 },
  });
  const vendorId = vendor.body?.data?.id;
  const buildType = await typeNamed('Subcontractor works');
  const sellingType = await typeNamed('Selling and marketing');

  console.log('\n── A build cost with no project is refused ─────────────────────');
  {
    const out = await run(ap.createBill, {
      user: RAISER,
      body: {
        vendor_id: vendorId, net_minor: 100000000, bill_date: '2026-01-10',
        expense_type_id: buildType.id,
      },
    });
    check('Refused, rather than quietly expensed',
      out.code === 422 && /coded to a project/.test(out.body?.message || ''),
      out.body?.message);
  }

  const raiseAndApprove = async (body) => {
    const raised = await run(ap.createBill, { user: RAISER, body });
    if (raised.code !== 201) return raised;
    await run(ap.approveBill, {
      user: APPROVER, params: { id: String(raised.body.data.id) }, body: {},
    });
    return raised;
  };

  // ── ACC-10.1 ──────────────────────────────────────────────────────────────
  console.log('\n── ACC-10.1  ₦120m of build cost, and ₦8m of marketing ─────────');
  {
    await raiseAndApprove({
      vendor_id: vendorId,
      net_minor: 12000000000,
      tax_minor: 900000000,
      bill_date: '2026-02-01',
      description: 'Foundation and superstructure',
      property_id: PROJECT,
      expense_type_id: buildType.id,
    });

    const entry = await entryFor('bill');
    const lines = await linesOf(entry.id);
    const at = (role) => lines.find((l) => l.account_role === role);
    check('The build cost is on the balance sheet, not in this month\'s profit',
      Number(at('DEVELOPMENT_WIP')?.debit_minor) === 12000000000,
      `Dr 1210 ${show(at('DEVELOPMENT_WIP')?.debit_minor)}`);
    check('...carrying the project, which is what makes it allocable later',
      Number(at('DEVELOPMENT_WIP')?.property_id) === PROJECT, `property ${PROJECT}`);

    await raiseAndApprove({
      vendor_id: vendorId,
      net_minor: 800000000,
      bill_date: '2026-02-05',
      description: 'Billboards on the Lekki road',
      property_id: PROJECT,
      expense_type_id: sellingType.id,
    });
    const selling = await entryFor('bill');
    const sellingLines = await linesOf(selling.id);
    check('Marketing on the SAME estate is expensed, not capitalised',
      !sellingLines.some((l) => l.account_role === 'DEVELOPMENT_WIP'),
      'coding a cost to a project and capitalising it are different acts');
    /*
     * Not merely "somewhere other than WIP". The first version of the seeder
     * left non-capitalisable types uncoded, so every one of them fell through
     * to cost of units sold — a billboard reported as part of what a unit
     * cost to build, and a gross margin wrong in the direction nobody checks.
     */
    check('...and lands in marketing rather than in the cost of units sold',
      sellingLines.some((l) => l.account_code === '5120' && Number(l.debit_minor) === 800000000),
      sellingLines.filter((l) => l.debit_minor > 0).map((l) => `Dr ${l.account_code}`).join(' '));
  }

  // ── ACC-10.6 ──────────────────────────────────────────────────────────────
  console.log('\n── ACC-10.6  The WIP report, which proves the control account ──');
  {
    const out = await run(dev.wipReport, { user: APPROVER, query: {} });
    const project = out.body?.data?.projects?.[0];
    check('The project carries what was capitalised to it',
      Number(project?.movements?.capitalised_minor) === 12000000000,
      show(project?.movements?.capitalised_minor));
    check('Every naira in the account belongs to a project',
      Number(out.body?.data?.unassigned_minor) === 0,
      `control ${show(out.body?.data?.control_balance_minor)} = projects ${show(out.body?.data?.projects_balance_minor)}`);

    const alloc = Object.fromEntries(project.units.map((u) => [u.name, u.allocated_minor]));
    check('400/400/200 sqm splits the pool 40/40/20',
      alloc['Plot A'] === 4800000000 && alloc['Plot B'] === 4800000000 && alloc['Plot C'] === 2400000000,
      `A ${show(alloc['Plot A'])} · B ${show(alloc['Plot B'])} · C ${show(alloc['Plot C'])}`);
  }

  // ── ACC-8.2 ───────────────────────────────────────────────────────────────
  console.log('\n── ACC-8.2  The recognition policy, narrowest first ────────────');
  {
    check('Nothing configured defers — the conservative answer',
      await recognitionFor(sequelize, { propertyId: PROJECT, companyId: COMPANY }) === 'ON_HANDOVER', '');

    await run(dev.savePolicy, {
      user: APPROVER, body: { scope: 'company', revenue_recognition: 'ON_INVOICE' },
    });
    check('A company default is picked up',
      await recognitionFor(sequelize, { propertyId: PROJECT, companyId: COMPANY }) === 'ON_INVOICE', '');

    await run(dev.savePolicy, {
      user: APPROVER,
      body: { scope: 'property', property_id: PROJECT, revenue_recognition: 'ON_HANDOVER' },
    });
    check('...and one estate\'s own policy beats it',
      await recognitionFor(sequelize, { propertyId: PROJECT, companyId: COMPANY }) === 'ON_HANDOVER',
      'the same developer sells off-plan units and bare land on different terms');
  }

  // ── ACC-8.3 ───────────────────────────────────────────────────────────────
  console.log('\n── ACC-8.3  A ₦50m sale on Plot A, invoiced ────────────────────');
  const invoice = await models.Invoice.create({
    company_id: COMPANY, invoice_id: 'INV-0001', client_id: 501, property_id: PROJECT,
    amount: 500000, status: 'sent', type: 'property_sale', issue_date: '2026-03-01',
  });
  await models.InvoicePaymentPlan.create({
    invoice_id: invoice.id, payment_type: 'installment',
    property_unit_id: 11, unit_price_minor: 5000000000,
  });
  {
    await postEvent(sequelize, {
      rule: 'invoice',
      companyId: COMPANY,
      entryDate: '2026-03-01',
      source: 'invoice',
      sourceId: String(invoice.id),
      memo: 'INV-0001',
      input: {
        grossMinor: 5000000000,
        vatMinor: 375000000,
        recognition: await recognitionFor(sequelize, { propertyId: PROJECT, companyId: COMPANY }),
        dimensions: { property_id: PROJECT, party_id: 501, party_type: 'client' },
      },
    });
    const entry = await entryFor('invoice');
    const lines = await linesOf(entry.id);
    const at = (role) => lines.find((l) => l.account_role === role);
    check('Revenue is NOT taken — it waits in contract liability',
      Number(at('CONTRACT_LIABILITY')?.credit_minor) === 5000000000
      && !lines.some((l) => l.account_role === 'REVENUE_UNIT_SALES'),
      `Cr 2120 ${show(at('CONTRACT_LIABILITY')?.credit_minor)}`);
    check('ACC-8.4  Output tax follows the tax point and is taken NOW',
      Number(at('VAT_OUTPUT')?.credit_minor) === 375000000,
      'VAT timing is independent of revenue timing');
  }

  // ── ACC-8.1 ───────────────────────────────────────────────────────────────
  console.log('\n── ACC-8.1  Handover, and the document it depends on ───────────');
  let handoverId = null;
  {
    const awaiting = await run(ho.awaitingHandover, { user: APPROVER, query: {} });
    check('The sale appears in the queue of revenue waiting to be recognised',
      awaiting.body?.data?.length === 1
      && Number(awaiting.body.data[0].deferred_minor) === 5000000000,
      awaiting.body?.error?.message
        || `${awaiting.body?.data?.[0]?.reference} ${show(awaiting.body?.data?.[0]?.deferred_minor)}`);

    const out = await run(ho.recordHandover, {
      user: APPROVER,
      body: { invoice_id: invoice.id, handover_date: '2027-10-19', notes: 'Keys given' },
    });
    handoverId = out.body?.data?.id;
    check('Recorded without the acknowledgement...', out.code === 201, out.body?.data?.reference);
    check('...but revenue does NOT move',
      out.body?.posted === false && await balanceOf('REVENUE_UNIT_SALES') === 0,
      out.body?.message);

    const attached = await run(ho.attachAcknowledgement, {
      user: APPROVER,
      params: { id: String(handoverId) },
      body: { acknowledgement_url: 'https://res.cloudinary.com/demo/image/upload/v1/ack.png' },
    });
    check('Attaching it is what recognises', attached.body?.posted === true, attached.body?.message);
  }

  // ── ACC-10.4 ──────────────────────────────────────────────────────────────
  console.log('\n── ACC-10.4  Revenue and its cost, in ONE journal ──────────────');
  {
    const entry = await entryFor('handover');
    const lines = await linesOf(entry.id);
    console.log(`        ${lines.map((l) => `${l.debit_minor > 0 ? 'Dr' : 'Cr'} ${l.account_code} ${l.account_role} ${show(l.debit_minor || l.credit_minor)}`).join('\n        ')}`);
    const at = (role) => lines.find((l) => l.account_role === role);

    check('Deferred revenue is released', Number(at('CONTRACT_LIABILITY')?.debit_minor) === 5000000000, '');
    check('...into revenue', Number(at('REVENUE_UNIT_SALES')?.credit_minor) === 5000000000, '');
    check('Plot A\'s share of the build cost is charged in the SAME entry',
      Number(at('COST_OF_SALES')?.debit_minor) === 4800000000,
      `${show(4800000000)} — 40% of ${show(12000000000)}`);
    check('...and comes out of work in progress',
      Number(at('DEVELOPMENT_WIP')?.credit_minor) === 4800000000, '');
    check('VAT is NOT touched again',
      !lines.some((l) => l.account_role === 'VAT_OUTPUT'),
      'charging output tax a second time is the commonest failure of this design');

    check('Gross margin on the sale falls out of the ledger',
      5000000000 - 4800000000 === 200000000,
      `${show(5000000000)} less ${show(4800000000)} = ${show(200000000)}`);
  }

  // ── ACC-10.4, afterwards ──────────────────────────────────────────────────
  console.log('\n── A cost that lands AFTER the unit has gone ───────────────────');
  {
    await raiseAndApprove({
      vendor_id: vendorId,
      net_minor: 3000000000,
      bill_date: '2027-12-01',
      description: 'Estate road, finished the year after',
      property_id: PROJECT,
      expense_type_id: buildType.id,
    });

    const detail = await run(dev.projectDetail, { user: APPROVER, params: { propertyId: PROJECT }, query: {} });
    const plotA = detail.body.data.units.find((u) => u.name === 'Plot A');
    check('Plot A is now allocated more than was released for it',
      Number(plotA.allocated_minor) === 6000000000 && Number(plotA.released_minor) === 4800000000,
      `allocated ${show(plotA.allocated_minor)} · released ${show(plotA.released_minor)}`);
    check('...and the difference is named as a catch-up rather than left in WIP',
      Number(detail.body.data.catch_up_minor) === 1200000000,
      show(detail.body.data.catch_up_minor));

    const before = await balanceOf('COST_OF_SALES');
    const out = await run(dev.postCatchUp, {
      user: APPROVER, params: { propertyId: PROJECT }, body: { entry_date: '2027-12-01' },
    });
    check('Releasing it charges cost of sales',
      out.code === 200 && await balanceOf('COST_OF_SALES') - before === 1200000000,
      out.body?.message);
    check('...and the same release offered twice is refused',
      (await run(dev.postCatchUp, {
        user: APPROVER, params: { propertyId: PROJECT }, body: { entry_date: '2027-12-01' },
      })).code === 409,
      'nothing left outstanding');
  }

  // ── ACC-10.5 ──────────────────────────────────────────────────────────────
  console.log('\n── ACC-10.5  A project worth less than it cost ─────────────────');
  {
    const freehand = await run(dev.postWriteDown, {
      user: APPROVER, params: { propertyId: PROJECT }, body: { reason: 'Market is soft' },
    });
    check('A write-down cannot simply be typed',
      freehand.code === 422 && /expected to fetch first/.test(freehand.body?.message || ''),
      freehand.body?.message);

    const carrying = await balanceOf('DEVELOPMENT_WIP');
    await run(dev.assessNrv, {
      user: APPROVER,
      params: { propertyId: PROJECT },
      body: { nrv_proceeds_minor: carrying - 500000000, note: 'Repriced after the road scheme moved' },
    });

    const out = await run(dev.postWriteDown, {
      user: APPROVER,
      params: { propertyId: PROJECT },
      body: { reason: 'Repriced after the road scheme moved', entry_date: '2027-12-31' },
    });
    check('Stated first, the write-down posts',
      out.code === 200 && await balanceOf('INVENTORY_WRITE_DOWN') === 500000000,
      `Dr 5030 ${show(await balanceOf('INVENTORY_WRITE_DOWN'))}`);
    check('...and is kept out of cost of units sold, which IAS 2 asks to be disclosed separately',
      await balanceOf('COST_OF_SALES') === 6000000000,
      `cost of sales ${show(await balanceOf('COST_OF_SALES'))}`);
    check('The project is now carried at what it will fetch',
      await balanceOf('DEVELOPMENT_WIP') === carrying - 500000000,
      show(await balanceOf('DEVELOPMENT_WIP')));
  }

  // ── ACC-8.5 ───────────────────────────────────────────────────────────────
  console.log('\n── ACC-8.5  What is still deferred ─────────────────────────────');
  {
    const out = await run(ho.deferredRevenue, { user: APPROVER, query: {} });
    check('Nothing is deferred once the only sale has been handed over',
      Number(out.body?.data?.total_minor) === 0
      && Number(out.body?.data?.unexplained_minor) === 0,
      out.body?.error?.message || `control ${show(out.body?.data?.control_balance_minor)}`);
  }

  // ── Reversal ──────────────────────────────────────────────────────────────
  console.log('\n── A handover recorded in error ────────────────────────────────');
  {
    const revenueBefore = -(await balanceOf('REVENUE_UNIT_SALES'));
    const out = await run(ho.reverseHandover, {
      user: APPROVER, params: { id: String(handoverId) }, body: { reason: 'Keys were not actually given' },
    });
    check('Reversed, by a mirrored journal rather than by deletion',
      out.code === 200 && -(await balanceOf('REVENUE_UNIT_SALES')) === revenueBefore - 5000000000,
      out.body?.message);

    const [row] = await sequelize.query(
      'SELECT status, reversal_reason FROM handovers WHERE id = :id',
      { replacements: { id: handoverId }, type: QueryTypes.SELECT },
    );
    check('...and the record survives, saying why',
      row?.status === 'reversed' && Boolean(row?.reversal_reason), row?.reversal_reason);
  }

  console.log('\n── The books balance through all of it ─────────────────────────');
  {
    const tb = await ledger.trialBalance(sequelize, { companyId: COMPANY });
    check('Trial balance balances', tb.balanced === true,
      `Dr ${show(tb.debit_minor)} = Cr ${show(tb.credit_minor)}`);
  }

  console.log(`\n  ${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass}/${pass + fail} checks passed.\x1b[0m\n`);

  await sequelize.close();
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  console.log(`  Scratch database ${DB} dropped.\n`);
  await admin.end();
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error('\x1b[31mThe verification itself failed:\x1b[0m', error);
  process.exit(1);
});

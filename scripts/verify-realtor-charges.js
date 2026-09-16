/**
 * What a realtor is billed when they ask to be verified or to move up.
 *
 * ── What this proves ───────────────────────────────────────────────────────
 *
 *   * a company that has set a price bills it, once, on submission;
 *   * a company that has not set one bills nothing at all — no zero-value
 *     notes for somebody to clear later;
 *   * resubmitting after a rejection does not bill twice;
 *   * the note points back at the request it pays for, which is what lets
 *     approving the payment approve the request;
 *   * a level's price comes from THAT level, not from a company-wide figure.
 *
 * Driven through the real controllers against a throwaway database.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_realtor_charges`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifycharges';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};
const naira = (v) => `₦${Number(v).toLocaleString('en-NG')}`;

(async () => {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  const userModels = require('../services/user-service/src/models');
  const financeModels = require('../services/finance-service/src/models');
  await userModels.sequelize.sync({ force: true });
  await financeModels.sequelize.sync({ alter: true });
  await require('../services/user-service/src/migrations/addRealtorChargeFees')(userModels.sequelize);
  await require('../services/finance-service/src/migrations/addNoteChargeColumns')(financeModels.sequelize);

  const {
    sequelize, Company, User, Setting, RealtorLevel, RealtorKyc, RealtorLevelRequest,
  } = userModels;
  const { CreditNote } = financeModels;

  const kyc = require('../services/user-service/src/controllers/realtorKycController');
  const levels = require('../services/user-service/src/controllers/realtorLevelController');

  const run = (handler, req) => new Promise((resolve) => {
    let code = 200;
    const res = {
      status(c) { code = c; return res; },
      json(body) { resolve({ code, body }); return res; },
    };
    Promise.resolve(handler(req, res, (err) => resolve({ code: 500, body: { error: err } })))
      .catch((err) => resolve({ code: 500, body: { error: err } }));
  });

  await Company.create({ id: 1, name: 'Verify Co', slug: 'verify-co', email: 'co@example.test' });
  const realtor = await User.create({
    name: 'Ada Obi', email: 'ada@example.test', password: 'x', type: 'realtor', company_id: 1,
  });
  const actor = { id: realtor.id, company_id: 1, type: 'realtor' };

  const DOCS = {
    id_type: 'national_id',
    id_number: 'A123456789',
    id_document_url: 'https://example.test/id.png',
    address_document_type: 'utility_bill',
    address_line: '12 Marina, Lagos',
    address_document_url: 'https://example.test/bill.png',
  };

  console.log('\n── A company that charges nothing ───────────────────────────────');
  {
    const out = await run(kyc.submitKyc, { user: actor, body: DOCS });
    const notes = await CreditNote.count();
    check('Submitting verification is accepted', out.code === 201 || out.code === 200, `HTTP ${out.code}`);
    check('...and raises no note at all when no fee is set',
      notes === 0 && out.body?.charge == null, `${notes} note(s)`);
    await RealtorKyc.destroy({ where: {} });
  }

  console.log('\n── A company that charges ₦10,000 ───────────────────────────────');
  let verificationNoteId = null;
  {
    await Setting.create({ key: 'verification_fee_minor', value: '1000000', group: 'realtor', company_id: 1 });
    const out = await run(kyc.submitKyc, { user: actor, body: DOCS });
    const note = await CreditNote.findOne({ where: { source_type: 'realtor_verification' } });
    verificationNoteId = note?.id ?? null;

    check('A note is raised for the configured amount',
      note != null && Number(note.amount) === 10000, naira(note?.amount ?? 0));
    check('...against the realtor, as a realtor',
      note?.client_id === realtor.id && note?.party_type === 'realtor',
      `client_id ${note?.client_id}, party ${note?.party_type}`);
    check('...pointing at the submission it bills',
      Number(note?.source_id) === (await RealtorKyc.findOne({ where: {} }))?.id,
      `source ${note?.source_type}#${note?.source_id}`);
    check('...already approved, because the price was decided by configuration',
      note?.status === 'approved', note?.status);
    check('...with a reference a person can quote',
      /^CN/.test(note?.credit_note_id || ''), note?.credit_note_id);
    check('...and the reply tells the realtor what they owe',
      Number(out.body?.charge?.amount) === 10000, JSON.stringify(out.body?.charge));
  }

  console.log('\n── Resubmitting after a rejection ───────────────────────────────');
  {
    const record = await RealtorKyc.findOne({ where: {} });
    await record.update({ status: 'rejected' });
    await run(kyc.submitKyc, { user: actor, body: DOCS });
    const notes = await CreditNote.count({ where: { source_type: 'realtor_verification' } });
    check('Does not bill a second time', notes === 1, `${notes} note(s)`);
  }

  console.log('\n── Levels are priced one by one ─────────────────────────────────');
  {
    const free = await RealtorLevel.create({ name: 'Bronze', position: 10, company_id: 1, levelup_fee_minor: 0 });
    const paid = await RealtorLevel.create({ name: 'Gold', position: 20, company_id: 1, levelup_fee_minor: 1500000 });

    const freeOut = await run(levels.createRequest, { user: actor, body: { level_id: free.id } });
    check('A free level raises nothing',
      freeOut.code === 201 && freeOut.body?.charge == null, `HTTP ${freeOut.code}`);
    await RealtorLevelRequest.destroy({ where: {} });

    const paidOut = await run(levels.createRequest, { user: actor, body: { level_id: paid.id } });
    const note = await CreditNote.findOne({ where: { source_type: 'realtor_levelup' } });
    check('A priced level raises that level\'s price',
      Number(note?.amount) === 15000, naira(note?.amount ?? 0));
    check('...naming the level on the note',
      /Gold/.test(note?.reason || ''), note?.reason);
    check('...and pointing at the request',
      Number(note?.source_id) === Number(paidOut.body?.data?.id),
      `source ${note?.source_type}#${note?.source_id}`);
    check('The two charges are separate notes',
      (await CreditNote.count()) === 2 && verificationNoteId !== note?.id,
      `${await CreditNote.count()} notes`);
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await sequelize.close();
  await financeModels.sequelize.close();
  await admin.query(`DROP DATABASE \`${DB}\``);
  await admin.end();
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

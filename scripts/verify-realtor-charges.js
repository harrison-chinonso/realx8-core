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
 *   * a level's price comes from THAT level, not from a company-wide figure;
 *   * the realtor can see their own notes and nobody else's;
 *   * uploading proof is a CLAIM — it changes no status by itself;
 *   * confirming the payment approves the request the fee was for, and moves
 *     the realtor's level with it;
 *   * a request an administrator already decided is not overwritten;
 *   * a party can chase an unpaid refund, once a day, and not at all once it
 *     has been paid.
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

/**
 * Wait briefly for something a handler set going but did not wait for.
 *
 * Every dispatch in this feature is fired without await, on purpose: a
 * notification failure must not roll back the thing it reports. So the row
 * lands just after the response does, and asserting the instant the handler
 * returns tests the scheduler rather than the dispatch. Returns null if it
 * never arrives, which is a real failure and reads as one.
 */
const eventually = async (find, tries = 40) => {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const found = await find();
    if (found) return found;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  return null;
};

(async () => {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  const userModels = require('../services/user-service/src/models');
  const financeModels = require('../services/finance-service/src/models');
  /*
   * The notification tables, so a dispatch is actually written rather than
   * swallowed. Every dispatch in this feature is best-effort and never throws,
   * which means a broken one is invisible — the only way to see it is to give
   * it somewhere to land and then look.
   */
  const notifyModels = require('../services/notification-service/src/models');
  await userModels.sequelize.sync({ force: true });
  await notifyModels.sequelize.sync({ alter: true });
  await financeModels.sequelize.sync({ alter: true });
  await require('../services/user-service/src/migrations/addRealtorChargeFees')(userModels.sequelize);
  await require('../services/finance-service/src/migrations/addNoteChargeColumns')(financeModels.sequelize);

  const {
    sequelize, Company, User, Setting, RealtorLevel, RealtorKyc, RealtorLevelRequest,
  } = userModels;
  const { CreditNote, DebitNote } = financeModels;

  const kyc = require('../services/user-service/src/controllers/realtorKycController');
  const levels = require('../services/user-service/src/controllers/realtorLevelController');
  const myNotes = require('../services/finance-service/src/controllers/myNotesController');
  const noteApproval = require('../services/finance-service/src/controllers/noteApprovalController');

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


  /*
   * settle() decides which kind of note it is from the URL it was reached by,
   * so a synthetic request has to carry one. An approver, not the realtor.
   */
  const approver = { id: 999, company_id: 1, type: 'admin' };
  const settleReq = (kind, id) => ({
    user: approver, params: { id }, body: {},
    baseUrl: `/${kind}-notes`, path: `/${id}/settle`,
  });

  console.log('\n── The realtor can see what they owe ────────────────────────────');
  {
    const other = await User.create({
      name: 'Bode Ade', email: 'bode@example.test', password: 'x', type: 'realtor', company_id: 1,
    });
    await CreditNote.create({
      credit_note_id: 'CN-OTHER', client_id: other.id, party_type: 'realtor',
      amount: 5000, status: 'approved', company_id: 1,
    });

    const out = await run(myNotes.listMine, { user: actor, query: {} });
    const seen = out.body?.data?.credit || [];
    check('Their own notes come back', out.code === 200 && seen.length === 2, `${seen.length} note(s)`);
    check("...and another realtor's does not",
      !seen.some((n) => n.reference === 'CN-OTHER'), seen.map((n) => n.reference).join(', '));
    /*
     * The date the note was raised. `underscored: true` maps the column but
     * not the attribute, so reading note.created_at returns undefined and the
     * page renders a dash where the date should be — a defect invisible to
     * every check that only looks at amounts and statuses.
     */
    check('...each carrying the date it was raised',
      seen.every((n) => n.created_at != null), JSON.stringify(seen.map((n) => n.created_at)));
    check('...with somewhere to pay it into',
      out.body?.data?.payment != null && Array.isArray(out.body.data.payment.bank?.accounts),
      JSON.stringify(out.body?.data?.payment?.bank ?? null));

    // A draft is a note somebody is still writing, and is nobody else's business.
    await CreditNote.create({
      credit_note_id: 'CN-DRAFT', client_id: realtor.id, party_type: 'realtor',
      amount: 100, status: 'draft', company_id: 1,
    });
    const after = await run(myNotes.listMine, { user: actor, query: {} });
    check('Drafts are not shown at all',
      !(after.body?.data?.credit || []).some((n) => n.reference === 'CN-DRAFT'),
      `${(after.body?.data?.credit || []).length} note(s)`);
  }

  console.log('\n── Uploading proof is a claim, not a payment ────────────────────');
  {
    const bad = await run(myNotes.submitProof, {
      user: actor, params: { id: verificationNoteId }, body: {},
    });
    check('Proof is required', bad.code === 400, `HTTP ${bad.code}`);

    const out = await run(myNotes.submitProof, {
      user: actor,
      params: { id: verificationNoteId },
      body: { document_url: 'https://example.test/receipt.png', reference: 'TRF-889' },
    });
    const note = await CreditNote.findByPk(verificationNoteId);
    check('The proof is recorded', out.code === 200 && note.payment_proof_url != null, note.payment_proof_url);
    check('...with the reference and when it was sent',
      note.payment_reference === 'TRF-889' && note.payment_submitted_at != null, note.payment_reference);
    /*
     * The one that matters. If uploading a screenshot settled the note, the
     * approval step would exist only on the screen, and anybody with a picture
     * of somebody else's receipt would be verified.
     */
    check('...and the note is NOT settled by it', note.status === 'approved', note.status);

    const kycRow = await RealtorKyc.findOne({ where: {} });
    check('...nor is the verification approved by it', kycRow.status !== 'approved', kycRow.status);

    const elsewhere = await CreditNote.findOne({ where: { credit_note_id: 'CN-OTHER' } });
    const trespass = await run(myNotes.submitProof, {
      user: actor, params: { id: elsewhere.id }, body: { document_url: 'https://example.test/x.png' },
    });
    check("A realtor cannot pay against another realtor's note", trespass.code === 404, `HTTP ${trespass.code}`);
  }

  console.log('\n── Confirming the payment approves what it paid for ─────────────');
  {
    const out = await run(noteApproval.settle, settleReq('credit', verificationNoteId));
    const note = await CreditNote.findByPk(verificationNoteId);
    const kycRow = await RealtorKyc.findOne({ where: {} });

    check('The note settles', out.code === 200 && note.status === 'used', `HTTP ${out.code}, ${note.status}`);
    check('...and the verification is approved with it', kycRow.status === 'approved', kycRow.status);
    check('...recorded against the approver, not the realtor',
      Number(kycRow.reviewed_by) === approver.id, `reviewed_by ${kycRow.reviewed_by}`);
    check('...and the reply says what it unlocked',
      out.body?.data?.unlocked?.kind === 'verification', JSON.stringify(out.body?.data?.unlocked));

    /*
     * Dispatches are best-effort and never throw, so a broken one shows up as
     * silence rather than a failure. The rows are the only evidence.
     */
    const told = await eventually(async () => {
      const rows = await notifyModels.Notification.findAll({ where: { user_id: realtor.id } });
      return rows.find((row) => /your payment has been confirmed/i.test(row.body || '')) || null;
    });
    check('...and the realtor is told, in their own words', told != null, told?.body || 'nothing sent');
  }

  console.log('\n── A paid upgrade moves the realtor up ──────────────────────────');
  {
    const note = await CreditNote.findOne({ where: { source_type: 'realtor_levelup' } });
    const request = await RealtorLevelRequest.findByPk(note.source_id);

    await run(noteApproval.settle, settleReq('credit', note.id));
    await request.reload();
    const moved = await User.findByPk(realtor.id);

    check('The upgrade request is approved', request.status === 'approved', request.status);
    /*
     * The level itself, not just the request row. A request reading approved
     * while the realtor is still on their old level is the support ticket this
     * whole path exists to avoid.
     */
    check('...and the realtor is actually on the new level',
      Number(moved.realtor_level_id) === Number(request.requested_level_id),
      `level ${moved.realtor_level_id} vs requested ${request.requested_level_id}`);
  }

  console.log('\n── A decision already taken is not overwritten ──────────────────');
  {
    const kycRow = await RealtorKyc.create({
      user_id: realtor.id, company_id: 1, status: 'rejected',
      review_notes: 'Photograph unreadable.', ...DOCS,
    });
    const note = await CreditNote.create({
      credit_note_id: 'CN-LATE', client_id: realtor.id, party_type: 'realtor',
      amount: 10000, status: 'approved', company_id: 1,
      source_type: 'realtor_verification', source_id: kycRow.id,
    });

    const out = await run(noteApproval.settle, settleReq('credit', note.id));
    await kycRow.reload();
    check('The note still settles', out.code === 200, `HTTP ${out.code}`);
    check('...but a refused verification stays refused',
      kycRow.status === 'rejected' && kycRow.review_notes === 'Photograph unreadable.',
      `${kycRow.status} — ${kycRow.review_notes}`);
    check('...and nothing is claimed to have been unlocked',
      out.body?.data?.unlocked == null, JSON.stringify(out.body?.data?.unlocked));
  }

  console.log('\n── Chasing a refund the company owes ────────────────────────────');
  {
    // The admin who raised it. A system-raised note has none, which is why the
    // event also carries permission recipients — see notificationEvents.js.
    const raisedBy = await User.create({
      name: 'Chidi Admin', email: 'chidi@example.test', password: 'x', type: 'admin', company_id: 1,
    });
    const owed = await DebitNote.create({
      debit_note_id: 'DN-0001', client_id: realtor.id, party_type: 'realtor',
      amount: 25000, status: 'approved', reason: 'Overpayment on INV-0009', company_id: 1,
      created_by: raisedBy.id,
    });

    const listed = await run(myNotes.listMine, { user: actor, query: {} });
    check('It appears on their page',
      (listed.body?.data?.debit || []).some((n) => n.reference === 'DN-0001'),
      `${(listed.body?.data?.debit || []).length} note(s)`);

    const first = await run(myNotes.remind, { user: actor, params: { id: owed.id } });
    await owed.reload();
    check('A reminder is accepted', first.code === 200 && owed.reminder_sent_at != null, `HTTP ${first.code}`);

    /*
     * Nobody holds finance.notes.approve in this fixture, so the ONLY recipient
     * is the named one — which is the case the use case turns on: a refund
     * raised by a person must reach that person.
     */
    const chased = await eventually(() => notifyModels.Notification.findOne({
      where: { type: 'debit_note_reminder', user_id: raisedBy.id },
    }));
    check('...and the admin who raised it actually hears', chased != null,
      chased?.body || 'nobody notified');

    /*
     * The throttle. A button that notifies somebody is a button people press
     * twice, and a queue of identical reminders is a queue nobody reads.
     */
    const second = await run(myNotes.remind, { user: actor, params: { id: owed.id } });
    check('...a second one the same day is refused', second.code === 429, `HTTP ${second.code}`);
    check('...saying when they may send another',
      /\d+ hour/.test(second.body?.message || ''), second.body?.message);

    // Yesterday: the window has passed, so chasing again is reasonable.
    await owed.update({ reminder_sent_at: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    const later = await run(myNotes.remind, { user: actor, params: { id: owed.id } });
    check('...and allowed again a day later', later.code === 200, `HTTP ${later.code}`);

    await owed.update({ status: 'paid' });
    const paid = await run(myNotes.remind, { user: actor, params: { id: owed.id } });
    check('Chasing a refund already paid is refused', paid.code === 409, `HTTP ${paid.code}`);
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await sequelize.close();
  await financeModels.sequelize.close();
  await notifyModels.sequelize.close();
  await admin.query(`DROP DATABASE \`${DB}\``);
  await admin.end();
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

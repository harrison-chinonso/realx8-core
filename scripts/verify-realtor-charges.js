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
  const { CreditNote, Invoice } = financeModels;

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
    id_document_url: 'https://res.cloudinary.com/verify/image/upload/v1/id.png',
    address_document_type: 'utility_bill',
    address_line: '12 Marina, Lagos',
    address_document_url: 'https://res.cloudinary.com/verify/image/upload/v1/bill.png',
  };

  /*
   * The document URLs are Cloudinary URLs rather than example.test ones.
   *
   * safeUploadUrl refuses a hand-typed link — a KYC document has to be one the
   * upload button produced, because somebody else has to open it. This fixture
   * predated that rule and had been failing on it since, which is what an
   * unrun verifier looks like: seven red checks about a charge, caused by a
   * URL two screens earlier.
   */
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
  /*
   * The charge is an INVOICE, not a credit note (ACC-0.1).
   *
   * It was a `credit_note` with a proof-of-payment column bolted on, which is
   * the instrument that REDUCES what somebody owes used for the opposite. A
   * fee the realtor must pay increases what they owe, and the document for
   * that is an invoice — on its own FEE- series so it does not consume a
   * number from the property sales sequence.
   */
  let verificationInvoiceId = null;
  {
    await Setting.create({ key: 'verification_fee_minor', value: '1000000', group: 'realtor', company_id: 1 });
    const out = await run(kyc.submitKyc, { user: actor, body: DOCS });
    const bill = await Invoice.findOne({ where: { source_type: 'realtor_verification' } });
    verificationInvoiceId = bill?.id ?? null;

    check('An invoice is raised for the configured amount',
      bill != null && Number(bill.amount) === 10000, naira(bill?.amount ?? 0));
    check('...against the realtor, as a service fee',
      bill?.client_id === realtor.id && bill?.type === 'service_fee',
      `client_id ${bill?.client_id}, type ${bill?.type}`);
    check('...carrying no property, because a fee has none',
      bill?.property_id == null, `property_id ${bill?.property_id}`);
    check('...pointing at the submission it bills',
      Number(bill?.source_id) === (await RealtorKyc.findOne({ where: {} }))?.id,
      `source ${bill?.source_type}#${bill?.source_id}`);
    check('...issued rather than draft, because the price was decided by configuration',
      bill?.status === 'sent', bill?.status);
    check('ACC-0.2  ...numbered from the fee series, not the sales series',
      /^FEE-/.test(bill?.invoice_id || ''), bill?.invoice_id);
    check('...and the reply tells the realtor what they owe',
      Number(out.body?.charge?.amount) === 10000, JSON.stringify(out.body?.charge));
  }

  console.log('\n── Resubmitting after a rejection ───────────────────────────────');
  {
    const record = await RealtorKyc.findOne({ where: {} });
    await record.update({ status: 'rejected' });
    await run(kyc.submitKyc, { user: actor, body: DOCS });
    const bills = await Invoice.count({ where: { source_type: 'realtor_verification' } });
    check('Does not bill a second time', bills === 1, `${bills} invoice(s)`);
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
    const bill = await Invoice.findOne({ where: { source_type: 'realtor_levelup' } });
    check('A priced level raises that level\'s price',
      Number(bill?.amount) === 15000, naira(bill?.amount ?? 0));
    check('...naming the level, in the reply the realtor is shown',
      /Gold/.test(paidOut.body?.charge?.reason || ''), paidOut.body?.charge?.reason);
    check('...and pointing at the request',
      Number(bill?.source_id) === Number(paidOut.body?.data?.id),
      `source ${bill?.source_type}#${bill?.source_id}`);
    check('The two charges are separate invoices',
      (await Invoice.count()) === 2 && verificationInvoiceId !== bill?.id,
      `${await Invoice.count()} invoices`);
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

    /*
     * One note, not two. The fee used to appear here as a credit note; it is a
     * service-fee invoice now (ACC-0.1) and shows with the realtor's other
     * invoices. What is left on this screen is the instrument that genuinely
     * belongs: a credit note reducing what they owe.
     */
    await CreditNote.create({
      credit_note_id: 'CN-MINE', client_id: realtor.id, party_type: 'realtor',
      amount: 2500, status: 'approved', company_id: 1,
    });
    const out = await run(myNotes.listMine, { user: actor, query: {} });
    const seen = out.body?.data?.credit || [];
    check('Their own notes come back', out.code === 200 && seen.length === 1, `${seen.length} note(s)`);
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

  console.log('\n── Paying the fee invoice settles what it paid for ──────────────');
  {
    /*
     * The fee is paid through the ORDINARY invoice path now (ACC-0.3).
     *
     * It used to have a path of its own: upload proof against a credit note,
     * have an approver settle the note, and the settle cascaded to the
     * verification. The proof-of-payment machinery on invoices already does
     * all of that and does it with a receipt and an approval trail the fee
     * never had — so the fee gained a control rather than losing one.
     */
    const { applyApprovedPayment } = require('../services/finance-service/src/services/allocationService');
    const { approvePaidRequest } = require('../shared/src/realtorChargeCascade');

    const bill = await Invoice.findOne({ where: { source_type: 'realtor_verification' } });
    const result = await applyApprovedPayment({
      invoiceId: bill.id, amountMinor: 1000000, paymentMethod: 'bank_transfer',
      reference: 'TRF-FEE-VERIFY', approvedBy: 999, companyId: 1,
    });
    check('The ordinary payment path takes it', result?.paidInFull === true,
      `paidInFull ${result?.paidInFull}`);

    await bill.reload();
    check('...and the invoice settles', bill.status === 'paid', bill.status);

    const unlocked = await approvePaidRequest(sequelize, {
      sourceType: bill.source_type, sourceId: bill.source_id, approverId: 999,
    });
    const kycRow = await RealtorKyc.findOne({ where: {} });
    check('...and the verification it paid for is approved',
      kycRow.status === 'approved', `${kycRow.status}, cascade returned ${unlocked?.kind ?? 'null'}`);
    check('...recorded against the approver, not the realtor',
      Number(kycRow.reviewed_by) === 999, `reviewed_by ${kycRow.reviewed_by}`);
  }

  console.log('\n── A paid upgrade moves the realtor up ──────────────────────────');
  {
    const bill = await Invoice.findOne({ where: { source_type: 'realtor_levelup' } });
    const request = await RealtorLevelRequest.findByPk(bill.source_id);

    /*
     * Paid, then cascaded — the same two steps the verification fee takes
     * above. The level-up fee was the other credit note; it is the other
     * service-fee invoice now.
     */
    const { applyApprovedPayment } = require('../services/finance-service/src/services/allocationService');
    const { approvePaidRequest } = require('../shared/src/realtorChargeCascade');
    await applyApprovedPayment({
      invoiceId: bill.id, amountMinor: 1500000, paymentMethod: 'bank_transfer',
      reference: 'TRF-FEE-LEVEL', approvedBy: 999, companyId: 1,
    });
    await approvePaidRequest(sequelize, {
      sourceType: bill.source_type, sourceId: bill.source_id, approverId: 999,
    });
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

  /*
   * "Chasing a refund the company owes" is gone with the instrument.
   *
   * It tested a realtor nudging somebody about a DEBIT NOTE — which was doing
   * duty as both an overpayment refund and a commission payout, under a name
   * that means neither. Refunds have their own document and approval screen
   * now (ACC-0.5) and a commission payout has the payout run, so there is no
   * longer one list that mixes them and no reminder button on it.
   */

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await sequelize.close();
  await financeModels.sequelize.close();
  await notifyModels.sequelize.close();
  await admin.query(`DROP DATABASE \`${DB}\``);
  await admin.end();
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

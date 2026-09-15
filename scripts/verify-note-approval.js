/**
 * Credit and debit notes cannot be self-approved, and an overpayment becomes
 * something that can be refunded.
 *
 * ── What is actually being proven ───────────────────────────────────────────
 *
 * A credit note writes off money owed TO the company; a debit note creates
 * money owed OUT of it. The status used to be a field on the create form, so
 * one person could raise a note straight into a payable state — the approval
 * existed only as a convention. Four things have to hold for that to be closed:
 *
 *   1. a note is raised as pending whatever the caller sent
 *   2. an edit cannot move it, so approval is not reachable through Save
 *   3. nothing is paid out or used before it is approved
 *   4. an overpayment raises its own note, exactly once per payment
 *
 * Drives the REAL controllers and the REAL migration against a throwaway
 * database. (3) is the one that matters: it is the difference between a
 * workflow and a decoration.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { QueryTypes } = require('sequelize');
const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_note_approval`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }

// Before any model is required — see verify-commission-store.js.
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifynotes';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};
const naira = (amount) => Math.round(amount * 100);

/** Runs a controller and resolves with { status, body }. */
const call = (handler, req) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { resolve({ status: this.statusCode, body }); return this; },
  };
  Promise.resolve(handler(req, res, reject)).catch(reject);
});

/** An admin of company 1 — company-scoped, as every staff request is. */
const asAdmin = (extra = {}) => ({
  user: { id: 900, type: 'admin', company_id: 1 },
  query: {}, params: {}, body: {}, baseUrl: '/finance', path: '/',
  ...extra,
});

(async () => {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  const models = require('../services/finance-service/src/models');
  const { sequelize } = models;

  const userModels = require('../services/user-service/src/models');
  // Parents before children — `users` carries a foreign key to each.
  await userModels.Company.sync({ force: true });
  await userModels.RealtorLevel.sync({ force: true });
  await userModels.User.sync({ force: true });
  await userModels.Company.create({ id: 1, name: 'Test Company', slug: 'test-co', email: 'co@test' });
  await sequelize.query(`INSERT INTO users (id, name, email, password, type, company_id, created_at, updated_at) VALUES
    (900, 'Admin',  'admin@test',  'x', 'admin',  1, NOW(), NOW()),
    (901, 'Buyer',  'buyer@test',  'x', 'client', 1, NOW(), NOW())`);

  // Same reason on the finance side: both notes carry a tax_id.
  await models.Tax.sync({ force: true });
  await models.CreditNote.sync({ force: true });
  await models.DebitNote.sync({ force: true });

  // The migration runs against tables the model just built, so it should find
  // nothing to do — which is itself worth knowing, because it is what happens
  // on every boot after the first.
  await require('../services/finance-service/src/migrations/addNoteApprovalStates')(sequelize);

  const c = require('../services/finance-service/src/controllers/financeController');
  const notes = require('../services/finance-service/src/controllers/noteApprovalController');

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n── A note is raised as pending, whatever the form sent ─────────');
  let creditId; let debitId;
  {
    const created = await call(c.creditNoteCrud.create, asAdmin({
      body: {
        client_id: 901, party_type: 'client', amount: 250_000,
        reason: 'Goodwill adjustment',
        // The old form sent this. It must not survive.
        status: 'used',
      },
    }));
    creditId = created.body?.data?.id;
    const row = await models.CreditNote.findByPk(creditId);
    check('A credit note asking to be created as `used` is created as pending',
      row?.status === 'pending_approval',
      `status ${row?.status} — the creator does not get to choose`);
    check('...and it still got its reference', Boolean(row?.credit_note_id), row?.credit_note_id);

    const createdDebit = await call(c.debitNoteCrud.create, asAdmin({
      body: { client_id: 901, party_type: 'client', amount: 90_000, status: 'paid' },
    }));
    debitId = createdDebit.body?.data?.id;
    const debit = await models.DebitNote.findByPk(debitId);
    check('A debit note asking to be created as `paid` is created as pending',
      debit?.status === 'pending_approval', `status ${debit?.status}`);
  }

  console.log('\n── Save cannot approve it either ───────────────────────────────');
  {
    await call(c.creditNoteCrud.update, asAdmin({
      params: { id: String(creditId) },
      body: { amount: 250_000, status: 'approved', approved_by: 900 },
    }));
    const row = await models.CreditNote.findByPk(creditId);
    /**
     * The interesting half. Stripping the field from CREATE alone would leave
     * the edit screen as a second door onto the same room — raise it pending,
     * save it approved.
     */
    check('An edit carrying `status: approved` leaves it pending',
      row?.status === 'pending_approval', `status ${row?.status}`);
    check('...and cannot forge an approver either',
      row?.approved_by == null, `approved_by ${row?.approved_by}`);
  }

  console.log('\n── Nothing is used or paid before it is approved ───────────────');
  {
    const early = await call(notes.settle, asAdmin({
      params: { id: String(creditId) }, baseUrl: '/finance', path: '/credit-notes/1/settle',
    }));
    check('Settling a pending credit note is refused',
      early.status === 409, `${early.status} — ${early.body?.message}`);
    check('...and says so in words an admin can act on',
      /has not been approved/i.test(early.body?.message || ''), early.body?.message);

    const row = await models.CreditNote.findByPk(creditId);
    check('...and the note did not move', row?.status === 'pending_approval');
  }

  console.log('\n── Approving, and what approval requires ───────────────────────');
  {
    // A note with no party: startable, not approvable.
    const partyless = await models.CreditNote.create({
      credit_note_id: 'CN-TEST-1', company_id: 1, amount: 1000, client_id: null,
    });
    const refused = await call(notes.approve, asAdmin({
      params: { id: String(partyless.id) }, path: '/credit-notes/x/approve',
    }));
    check('A note with nobody to credit cannot be approved',
      refused.status === 422, `${refused.status} — ${refused.body?.message}`);

    const zero = await models.CreditNote.create({
      credit_note_id: 'CN-TEST-2', company_id: 1, amount: 0, client_id: 901,
    });
    const refusedZero = await call(notes.approve, asAdmin({
      params: { id: String(zero.id) }, path: '/credit-notes/x/approve',
    }));
    check('A note for nothing cannot be approved',
      refusedZero.status === 422, `${refusedZero.status} — ${refusedZero.body?.message}`);

    const ok = await call(notes.approve, asAdmin({
      params: { id: String(creditId) }, path: '/credit-notes/x/approve',
    }));
    const row = await models.CreditNote.findByPk(creditId);
    check('A complete note approves', ok.status === 200 && row?.status === 'approved', row?.status);
    check('...and records who signed it and when',
      row?.approved_by === 900 && Boolean(row?.approved_at),
      `by ${row?.approved_by} at ${row?.approved_at}`);

    const again = await call(notes.approve, asAdmin({
      params: { id: String(creditId) }, path: '/credit-notes/x/approve',
    }));
    check('Approving it twice is refused', again.status === 409, again.body?.message);

    const settled = await call(notes.settle, asAdmin({
      params: { id: String(creditId) }, path: '/credit-notes/x/settle',
    }));
    const after = await models.CreditNote.findByPk(creditId);
    check('An approved credit note can then be used',
      settled.status === 200 && after?.status === 'used', after?.status);
  }

  console.log('\n── Paying a debit note is what writes the ledger entry ─────────');
  {
    await models.Transaction.sync({ force: true });

    const note = await models.DebitNote.create({
      debit_note_id: 'DN-LEDGER-1', company_id: 1, amount: 450_000, client_id: 901,
      party_type: 'realtor', reason: 'Commission payout for August',
    });

    /**
     * Nothing is written while it is merely approved. An approval is a decision
     * that money MAY go out, which is not the same event as it going out — and
     * a ledger that records the decision would say the realtor had been paid
     * from the moment somebody signed the form.
     */
    await call(notes.approve, asAdmin({ params: { id: String(note.id) }, path: '/debit-notes/x/approve' }));
    const [afterApproval] = await sequelize.query(
      'SELECT COUNT(*) AS n FROM transactions', { type: QueryTypes.SELECT },
    );
    check('Approving a debit note writes no ledger entry',
      Number(afterApproval.n) === 0, `${afterApproval.n} transaction(s)`);

    const paid = await call(notes.settle, asAdmin({
      params: { id: String(note.id) },
      body: { reference: 'TRF-99887', payment_method: 'transfer' },
      path: '/debit-notes/x/settle',
    }));
    check('Paying it does', paid.status === 200 && paid.body?.data?.transaction_id != null,
      `transaction ${paid.body?.data?.transaction_id}`);

    const [entry] = await sequelize.query(
      'SELECT user_id, type, entry_type, amount, reference, description FROM transactions',
      { type: QueryTypes.SELECT },
    );
    check('...as a DEBIT against the party it was raised for',
      entry && entry.entry_type === 'debit' && Number(entry.user_id) === 901,
      entry ? `${entry.entry_type} for user ${entry.user_id}` : 'no entry');
    check('...for the note\'s amount',
      entry && Number(entry.amount) === 450_000, entry ? String(entry.amount) : '');
    check('...carrying the payment reference somebody can reconcile against',
      entry && entry.reference === 'TRF-99887', entry?.reference);
    check('...and saying what it was for',
      entry && /Commission payout for August/.test(entry.description || ''), entry?.description);

    /**
     * A credit note discharges what somebody owes rather than moving money, so
     * using one must write nothing. Getting this wrong would double-count: the
     * invoice is reduced AND the ledger says cash left.
     */
    const credit = await models.CreditNote.create({
      credit_note_id: 'CN-LEDGER-1', company_id: 1, amount: 200_000, client_id: 901,
    });
    await call(notes.approve, asAdmin({ params: { id: String(credit.id) }, path: '/credit-notes/x/approve' }));
    await call(notes.settle, asAdmin({ params: { id: String(credit.id) }, path: '/credit-notes/x/settle' }));
    const [afterCredit] = await sequelize.query(
      'SELECT COUNT(*) AS n FROM transactions', { type: QueryTypes.SELECT },
    );
    check('Using a credit note writes nothing to the ledger',
      Number(afterCredit.n) === 1, `still ${afterCredit.n} entry — the debit note's`);
  }

  console.log('\n── Refusing needs a reason, and the reason is kept ─────────────');
  {
    const noReason = await call(notes.reject, asAdmin({
      params: { id: String(debitId) }, body: {}, path: '/debit-notes/x/reject',
    }));
    check('Refusing with no reason is refused', noReason.status === 400, noReason.body?.message);

    await call(notes.reject, asAdmin({
      params: { id: String(debitId) },
      body: { reason: 'The client asked for it to come off the next instalment.' },
      path: '/debit-notes/x/reject',
    }));
    const row = await models.DebitNote.findByPk(debitId);
    check('A refused note keeps the reason',
      row?.status === 'rejected' && /next instalment/.test(row?.rejection_reason || ''),
      row?.rejection_reason);

    const paidAnyway = await call(notes.settle, asAdmin({
      params: { id: String(debitId) }, path: '/debit-notes/x/settle',
    }));
    check('A refused note cannot be paid out anyway',
      paidAnyway.status === 409, `${paidAnyway.status} — ${paidAnyway.body?.message}`);
  }

  console.log('\n── Another company\'s note is not visible ───────────────────────');
  {
    const theirs = await models.DebitNote.create({
      debit_note_id: 'DN-OTHER-1', company_id: 2, amount: 500_000, client_id: 901,
    });
    const reached = await call(notes.approve, asAdmin({
      params: { id: String(theirs.id) }, path: '/debit-notes/x/approve',
    }));
    check('Approving across a company boundary is a 404, not an approval',
      reached.status === 404, `${reached.status} — ${reached.body?.message}`);
    const row = await models.DebitNote.findByPk(theirs.id);
    check('...and their note is untouched', row?.status === 'pending_approval');
  }

  console.log('\n── An overpayment raises its own note ──────────────────────────');
  {
    const { raiseOverpaymentNote } = require('../services/finance-service/src/services/overpaymentNoteService');
    const invoice = { id: 77, invoice_id: 'INV-0077', client_id: 901, company_id: 1 };

    const raised = await raiseOverpaymentNote(null, {
      sequelize, invoice, plan: { id: 5 }, surplusMinor: naira(150_000),
      paymentId: 4242, companyId: 1,
    });
    check('The surplus becomes a debit note', Boolean(raised?.id), raised?.reference);

    const row = await models.DebitNote.findByPk(raised.id);
    check('...raised against the client who overpaid',
      Number(row?.client_id) === 901 && row?.party_type === 'client');
    check('...for exactly the surplus', Number(row?.amount) === 150_000, String(row?.amount));
    check('...waiting for an approver, like every other note',
      row?.status === 'pending_approval', row?.status);
    check('...and says what to do about it in the reason',
      /Approve to refund it/.test(row?.reason || ''), row?.reason);

    /**
     * The one that protects the client's money twice over: an approval that is
     * retried, or two admins approving the same receipt at the same moment,
     * must not produce two refunds of one overpayment.
     */
    const repeat = await raiseOverpaymentNote(null, {
      sequelize, invoice, plan: { id: 5 }, surplusMinor: naira(150_000),
      paymentId: 4242, companyId: 1,
    });
    check('Raising it again for the same payment does nothing', repeat === null);

    const [{ total }] = await sequelize.query(
      'SELECT COUNT(*) AS total FROM debit_notes WHERE source_payment_id = 4242',
      { type: QueryTypes.SELECT },
    );
    check('...and there is still exactly one note', Number(total) === 1, `${total} row(s)`);

    const none = await raiseOverpaymentNote(null, {
      sequelize, invoice, plan: { id: 5 }, surplusMinor: 0, paymentId: 4243, companyId: 1,
    });
    check('A payment with no surplus raises nothing', none === null);
  }

  console.log('\n── The approver gets one queue, not two lists ──────────────────');
  {
    const queue = await call(notes.pending, asAdmin({}));
    const rows = queue.body?.data || [];
    check('Both kinds appear in the pending queue',
      rows.some((r) => r.kind === 'credit') && rows.some((r) => r.kind === 'debit'),
      rows.map((r) => `${r.kind} ${r.reference}`).join(', '));
    check('Approved, refused and settled notes are not in it',
      rows.every((r) => r.reference !== 'CN-0001'),
      `${rows.length} waiting`);
    check('...and another company\'s note is not in it',
      rows.every((r) => r.reference !== 'DN-OTHER-1'));
  }

  await sequelize.close();
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error('\n  Harness error:', error);
  process.exit(1);
});

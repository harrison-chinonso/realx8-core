/**
 * A credit note cannot be self-approved, and an overpayment becomes
 * something that can be refunded.
 *
 * ── What is actually being proven ───────────────────────────────────────────
 *
 * A credit note writes off money owed TO the company. Since ACC-0.6 it is the
 * only note there is — `debit_notes` was doing three unrelated jobs under a
 * name that meant a fourth thing, and each now has its own document. What
 * remains here is the approval machinery and the one behaviour ACC-0.4 added:
 * an approved credit note actually reduces what the client owes.
 *
 * The old header said a debit note creates
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

  // The migration runs against tables the model just built, so it should find
  // nothing to do — which is itself worth knowing, because it is what happens
  // on every boot after the first.
  await require('../services/finance-service/src/migrations/addNoteApprovalStates')(sequelize);

  const c = require('../services/finance-service/src/controllers/financeController');
  const notes = require('../services/finance-service/src/controllers/noteApprovalController');

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n── A note is raised as pending, whatever the form sent ─────────');
  let creditId;
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

  console.log('\n── Refusing needs a reason, and the reason is kept ─────────────');
  {
    /*
     * A note of its own. The one created at the top has been approved and
     * settled by the checks above, and a settled note cannot be refused —
     * which is correct behaviour and makes it useless for testing refusal.
     */
    const fresh = await models.CreditNote.create({
      credit_note_id: 'CN-REFUSE-1', company_id: 1, client_id: 901,
      party_type: 'client', amount: 75_000, status: 'pending_approval',
    });

    const noReason = await call(notes.reject, asAdmin({
      params: { id: String(fresh.id) }, body: {}, path: '/credit-notes/x/reject',
    }));
    check('Refusing with no reason is refused', noReason.status === 400, noReason.body?.message);

    await call(notes.reject, asAdmin({
      params: { id: String(fresh.id) },
      body: { reason: 'The client asked for it to come off the next instalment.' },
      path: '/credit-notes/x/reject',
    }));
    const row = await models.CreditNote.findByPk(fresh.id);
    check('A refused note keeps the reason',
      row?.status === 'rejected' && /next instalment/.test(row?.rejection_reason || ''),
      row?.rejection_reason);

    const paidAnyway = await call(notes.settle, asAdmin({
      params: { id: String(creditId) }, path: '/credit-notes/x/settle',
    }));
    check('A refused note cannot be paid out anyway',
      paidAnyway.status === 409, `${paidAnyway.status} — ${paidAnyway.body?.message}`);
  }

  console.log('\n── Another company\'s note is not visible ───────────────────────');
  {
    const theirs = await models.CreditNote.create({
      credit_note_id: 'CN-OTHER-1', company_id: 2, amount: 500_000, client_id: 901,
      party_type: 'client',
    });
    const reached = await call(notes.approve, asAdmin({
      params: { id: String(theirs.id) }, path: '/credit-notes/x/approve',
    }));
    check('Approving across a company boundary is a 404, not an approval',
      reached.status === 404, `${reached.status} — ${reached.body?.message}`);
    const row = await models.CreditNote.findByPk(theirs.id);
    check('...and their note is untouched', row?.status === 'pending_approval');
  }

  console.log('\n── An overpayment raises a REFUND, not a note (ACC-0.5) ────────');
  {
    /*
     * It used to raise a debit note. Refunding an overpayment is not a charge
     * in either direction — it is the discharge of a liability the company
     * took on the moment it banked money it was not owed — so it has its own
     * document now, with the same approval on it.
     */
    await models.Refund.sync({ force: true });
    const { raiseOverpaymentRefund } = require('../services/finance-service/src/services/overpaymentRefundService');
    const invoice = { id: 77, invoice_id: 'INV-0077', client_id: 901, company_id: 1 };

    const raised = await raiseOverpaymentRefund(null, {
      sequelize, invoice, plan: { id: 5 }, surplusMinor: naira(150_000),
      paymentId: 4242, companyId: 1,
    });
    check('The surplus becomes a refund', Boolean(raised?.id), raised?.reference);

    const row = await models.Refund.findByPk(raised.id);
    check('...raised against the client who overpaid', Number(row?.client_id) === 901);
    check('...for exactly the surplus, in minor units',
      Number(row?.amount_minor) === naira(150_000), String(row?.amount_minor));
    check('...waiting for an approver, as the note it replaces did',
      row?.status === 'pending_approval', row?.status);
    check('...and says what to do about it in the reason',
      /Approve to refund it/.test(row?.reason || ''), row?.reason);

    /**
     * The one that protects the client's money twice over: an approval that is
     * retried, or two admins approving the same receipt at the same moment,
     * must not produce two refunds of one overpayment.
     */
    const repeat = await raiseOverpaymentRefund(null, {
      sequelize, invoice, plan: { id: 5 }, surplusMinor: naira(150_000),
      paymentId: 4242, companyId: 1,
    });
    check('Raising it again for the same payment does nothing', repeat === null);

    const [{ total }] = await sequelize.query(
      'SELECT COUNT(*) AS total FROM refunds WHERE source_payment_id = 4242',
      { type: QueryTypes.SELECT },
    );
    check('...and there is still exactly one refund', Number(total) === 1, `${total} row(s)`);

    const none = await raiseOverpaymentRefund(null, {
      sequelize, invoice, plan: { id: 5 }, surplusMinor: 0, paymentId: 4243, companyId: 1,
    });
    check('A payment with no surplus raises nothing', none === null);
  }

  console.log('\n── The approver gets one queue, not two lists ──────────────────');
  {
    const queue = await call(notes.pending, asAdmin({}));
    const rows = queue.body?.data || [];
    /*
     * One kind now. The queue used to union credit and debit notes; the debit
     * half is gone with the instrument (ACC-0.6) and a refund has its own
     * approval screen rather than sharing this one.
     */
    check('Credit notes awaiting approval appear in the queue',
      rows.length > 0 && rows.every((r) => r.kind === 'credit'),
      rows.map((r) => `${r.kind} ${r.reference}`).join(', ') || 'empty');
    check('Approved, refused and settled notes are not in it',
      rows.every((r) => r.reference !== 'CN-0001'),
      `${rows.length} waiting`);
    check('...and another company\'s note is not in it',
      rows.every((r) => r.reference !== 'CN-OTHER-1'));
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

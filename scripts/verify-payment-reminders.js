/**
 * When a buyer is reminded, and — more importantly — when they are not.
 *
 * ── The rule everything else serves ─────────────────────────────────────────
 *
 * A reminder is a request for money. Asking somebody for money they have
 * already sent is the fastest way to make them ignore every later message, so
 * an installment that has been paid produces no reminder at any offset. Every
 * other rule here is about not being annoying in some narrower way: not
 * repeating a reminder, not firing four at once after an outage, not sending
 * one for an offset that has not arrived.
 *
 * Pure resolution and pure date arithmetic, so each case is a literal input and
 * a literal expected answer. The persistence half — that a company editing the
 * platform default gets its own row — is driven against a real database.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { QueryTypes } = require('sequelize');
const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_reminders`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifyreminders';

const {
  BUILT_IN_OFFSETS, offsetsDueToday, describeOffset, scheduleForInvoice,
} = require('../shared/src/reminderSchedule');

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

const naira = (amount) => Math.round(amount * 100);
/** A date N days from the due date, for readable cases. */
const DUE = '2026-06-15T00:00:00Z';
const dayOffset = (days) => new Date(Date.UTC(2026, 5, 15 + days, 9, 0, 0));

const call = (handler, req) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { resolve({ status: this.statusCode, body }); return this; },
  };
  Promise.resolve(handler(req, res, reject)).catch(reject);
});

(async () => {
  console.log('\n── Nothing is sent for an installment that has been paid ───────');
  {
    const paid = offsetsDueToday({
      offsets: BUILT_IN_OFFSETS, dueDate: DUE, outstandingMinor: 0, now: dayOffset(2),
    });
    check('An installment settled in full produces no reminder, even when late',
      paid.send.length === 0 && paid.supersede.length === 0, `got ${JSON.stringify(paid)}`);

    const partly = offsetsDueToday({
      offsets: BUILT_IN_OFFSETS, dueDate: DUE, outstandingMinor: naira(1), now: dayOffset(2),
    });
    /**
     * One kobo still owed is still owed. The alternative — a tolerance — means
     * choosing an amount below which a debt is forgiven silently, which is a
     * decision for a company and not for a reminder job.
     */
    check('...but a single kobo still outstanding is still chased',
      partly.send.length === 1, `got ${JSON.stringify(partly.send)}`);
  }

  console.log('\n── The configured days, and only once each ─────────────────────');
  {
    const outstanding = naira(500_000);
    const at = (days, alreadySent = []) => offsetsDueToday({
      offsets: BUILT_IN_OFFSETS, dueDate: DUE, outstandingMinor: outstanding,
      alreadySent, now: dayOffset(days),
    }).send;

    check('Ten days out, nothing is due yet', at(-10).length === 0, JSON.stringify(at(-10)));
    check('A week out, the first reminder fires', JSON.stringify(at(-7)) === '[-7]', JSON.stringify(at(-7)));
    check('Two days out, the second fires', JSON.stringify(at(-2, [-7])) === '[-2]', JSON.stringify(at(-2, [-7])));
    check('On the day, the third fires', JSON.stringify(at(0, [-7, -2])) === '[0]', JSON.stringify(at(0, [-7, -2])));
    check('Two days late, the chase fires', JSON.stringify(at(2, [-7, -2, 0])) === '[2]', JSON.stringify(at(2, [-7, -2, 0])));

    check('A reminder already sent is never sent again',
      at(-7, [-7]).length === 0, JSON.stringify(at(-7, [-7])));
    check('...and once the last offset has been sent, nothing more follows',
      at(30, [-7, -2, 0, 2]).length === 0, JSON.stringify(at(30, [-7, -2, 0, 2])));
  }

  console.log('\n── An outage does not become four emails ───────────────────────');
  {
    /**
     * The job did not run for nine days and comes back two days after the due
     * date, with nothing sent. Three offsets are technically "reached". Sending
     * all three at once is how a buyer learns to filter the sender.
     */
    const caughtUp = offsetsDueToday({
      offsets: BUILT_IN_OFFSETS, dueDate: DUE, outstandingMinor: naira(500_000),
      alreadySent: [], now: dayOffset(2),
    });
    check('A job that missed a week sends ONE reminder, not four',
      caughtUp.send.length === 1, JSON.stringify(caughtUp.send));
    check('...and it is the most recent one, not the oldest',
      caughtUp.send[0] === 2, `got ${caughtUp.send[0]} — the buyer needs today's news, not last week's`);

    /**
     * The half that is easy to miss. The three offsets the window passed over
     * have to be CLOSED, not merely left unsent — otherwise the next run finds
     * them still reached and still unsent, picks the next one down, and emails
     * the buyer again. A sweep run twice in a day would send two reminders for
     * one due date.
     */
    check('...and the three it skipped are closed rather than left pending',
      JSON.stringify(caughtUp.supersede) === '[-7,-2,0]', JSON.stringify(caughtUp.supersede));

    const second = offsetsDueToday({
      offsets: BUILT_IN_OFFSETS, dueDate: DUE, outstandingMinor: naira(500_000),
      alreadySent: [...caughtUp.supersede, ...caughtUp.send], now: dayOffset(2),
    });
    check('...so running the sweep again the same day sends nothing',
      second.send.length === 0 && second.supersede.length === 0, JSON.stringify(second));
  }

  console.log('\n── A company can ask for something quite different ─────────────');
  {
    const quiet = offsetsDueToday({
      offsets: [0], dueDate: DUE, outstandingMinor: naira(100), now: dayOffset(-5),
    });
    check('A single-reminder schedule sends nothing early', quiet.send.length === 0, JSON.stringify(quiet));

    const persistent = offsetsDueToday({
      offsets: [-1, 0, 1, 3, 7, 14, 30], dueDate: DUE, outstandingMinor: naira(100),
      alreadySent: [-1, 0, 1, 3], now: dayOffset(9),
    });
    check('A seven-reminder schedule reaches its late offsets',
      JSON.stringify(persistent.send) === '[7]', JSON.stringify(persistent.send));
  }

  console.log('\n── What a reminder calls itself ────────────────────────────────');
  {
    check('A week out reads as days before', describeOffset(-7) === '7 days before it is due', describeOffset(-7));
    check('The day before is singular', describeOffset(-1) === 'the day before it is due', describeOffset(-1));
    check('The due date says so plainly', describeOffset(0) === 'on the day it is due', describeOffset(0));
    check('One day late is singular too', describeOffset(1) === 'a day late', describeOffset(1));
    check('Later is plural', describeOffset(5) === '5 days late', describeOffset(5));
  }

  // ── the persistence half ─────────────────────────────────────────────────
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  const models = require('../services/finance-service/src/models');
  const { sequelize } = models;
  await models.ReminderSchedule.sync({ force: true });
  await models.Tax.sync({ force: true });
  await models.Invoice.sync({ force: true });
  await require('../services/finance-service/src/migrations/seedReminderSchedules')(sequelize);

  const ctl = require('../services/finance-service/src/controllers/reminderScheduleController');
  const asCompanyAdmin = (extra = {}) => ({
    user: { id: 900, type: 'admin', company_id: 7 }, params: {}, body: {}, query: {}, ...extra,
  });
  const asPlatformAdmin = (extra = {}) => ({
    user: { id: 1, type: 'superior_admin', company_id: null }, params: {}, body: {}, query: {}, ...extra,
  });

  console.log('\n── The platform default exists, and is what a company sees ─────');
  {
    const seeded = await ctl ? await call(ctl.getDefault, asCompanyAdmin()) : null;
    check('A company with no schedule of its own sees the platform default',
      seeded.body?.data?.source === 'platform', `source ${seeded.body?.data?.source}`);
    check('...which is a week before, two days before, the day, and two days late',
      JSON.stringify(seeded.body?.data?.offsets) === JSON.stringify(BUILT_IN_OFFSETS),
      JSON.stringify(seeded.body?.data?.offsets));
    check('...and the screen is told it cannot edit that row in place',
      seeded.body?.data?.editable_in_place === false, '');
  }

  console.log('\n── Editing the default gives the company its own ───────────────');
  {
    const saved = await call(ctl.saveDefault, asCompanyAdmin({
      body: { name: 'Our reminders', offsets: [-14, -3, 0] },
    }));
    check('The first save creates a company schedule rather than updating the platform\'s',
      saved.body?.data?.source === 'company' && saved.body?.data?.company_id === 7,
      `company ${saved.body?.data?.company_id}`);

    const platform = await sequelize.query(
      'SELECT offsets FROM reminder_schedules WHERE company_id IS NULL AND is_default IS TRUE',
      { type: QueryTypes.SELECT },
    );
    /**
     * The check this whole design exists for. Without copy-on-write the first
     * company to change its reminders changes them for every other company on
     * the platform, and neither party can tell.
     */
    const platformOffsets = typeof platform[0].offsets === 'string'
      ? JSON.parse(platform[0].offsets) : platform[0].offsets;
    check('...and the platform default is untouched',
      JSON.stringify(platformOffsets) === JSON.stringify(BUILT_IN_OFFSETS),
      JSON.stringify(platformOffsets));

    const again = await call(ctl.saveDefault, asCompanyAdmin({
      body: { name: 'Our reminders', offsets: [-14, -3, 0, 5] },
    }));
    check('A second save updates the company\'s row instead of making another',
      again.body?.data?.id === saved.body?.data?.id, `${saved.body?.data?.id} then ${again.body?.data?.id}`);

    const count = await sequelize.query(
      'SELECT COUNT(*) AS n FROM reminder_schedules WHERE company_id = 7 AND is_default IS TRUE',
      { type: QueryTypes.SELECT },
    );
    check('...so the company has exactly one default', Number(count[0].n) === 1, `${count[0].n} row(s)`);

    const nowSees = await call(ctl.getDefault, asCompanyAdmin());
    check('...and that is what it now sees', nowSees.body?.data?.source === 'company'
      && JSON.stringify(nowSees.body?.data?.offsets) === '[-14,-3,0,5]',
      JSON.stringify(nowSees.body?.data?.offsets));
  }

  console.log('\n── A platform admin still edits the platform\'s own ─────────────');
  {
    await call(ctl.saveDefault, asPlatformAdmin({ body: { name: 'Standard reminders', offsets: [-7, 0] } }));
    const [row] = await sequelize.query(
      'SELECT offsets FROM reminder_schedules WHERE company_id IS NULL AND is_default IS TRUE',
      { type: QueryTypes.SELECT },
    );
    const offsets = typeof row.offsets === 'string' ? JSON.parse(row.offsets) : row.offsets;
    check('The platform row is edited in place', JSON.stringify(offsets) === '[-7,0]', JSON.stringify(offsets));

    const other = await call(ctl.getDefault, asCompanyAdmin());
    check('...and a company that already chose its own is unaffected',
      JSON.stringify(other.body?.data?.offsets) === '[-14,-3,0,5]',
      JSON.stringify(other.body?.data?.offsets));
  }

  console.log('\n── Putting particular invoices on their own schedule ────────────');
  {
    // Through the model, so the columns it actually has are the ones filled.
    await models.Invoice.bulkCreate([
      { id: 1, invoice_id: 'INV-1', client_id: 50, amount: 1000, status: 'sent', company_id: 7 },
      { id: 2, invoice_id: 'INV-2', client_id: 50, amount: 2000, status: 'sent', company_id: 7 },
      { id: 3, invoice_id: 'INV-3', client_id: 51, amount: 3000, status: 'sent', company_id: 9 },
    ]);

    const named = await call(ctl.createSchedule, asCompanyAdmin({
      body: { name: 'Corporate — no chasing', offsets: [-30, -7] },
    }));
    const scheduleId = named.body?.data?.id;
    check('A named schedule can be created alongside the default', Boolean(scheduleId), named.body?.data?.name);

    const assigned = await call(ctl.assignToInvoices, asCompanyAdmin({
      body: { invoice_ids: [1, 2, 3], schedule_id: scheduleId },
    }));
    /**
     * Invoice 3 belongs to another company. It must not be reassigned, and the
     * count has to say so — "3 chosen, 2 updated" is the only honest answer.
     */
    check('Only the company\'s own invoices are reassigned',
      assigned.body?.data?.updated === 2 && assigned.body?.data?.requested === 3,
      `${assigned.body?.data?.updated} of ${assigned.body?.data?.requested}`);

    const resolved = await scheduleForInvoice(sequelize, { invoiceId: 1, companyId: 7 });
    check('...and that invoice now resolves to the named schedule',
      resolved.source === 'invoice' && JSON.stringify(resolved.offsets) === '[-30,-7]',
      `${resolved.source} ${JSON.stringify(resolved.offsets)}`);

    const untouched = await scheduleForInvoice(sequelize, { invoiceId: 3, companyId: 9 });
    check('...while the other company\'s invoice falls back to the platform default',
      untouched.source === 'platform' && JSON.stringify(untouched.offsets) === '[-7,0]',
      `${untouched.source} ${JSON.stringify(untouched.offsets)}`);

    const cleared = await call(ctl.assignToInvoices, asCompanyAdmin({
      body: { invoice_ids: [1], schedule_id: null },
    }));
    check('Clearing the override is an explicit action', cleared.body?.data?.updated === 1, '');
    const back = await scheduleForInvoice(sequelize, { invoiceId: 1, companyId: 7 });
    check('...and the invoice returns to the company default',
      back.source === 'company' && JSON.stringify(back.offsets) === '[-14,-3,0,5]',
      `${back.source} ${JSON.stringify(back.offsets)}`);
  }

  console.log('\n── A schedule with nothing usable in it does not silence reminders ──');
  {
    /**
     * The column is JSON, so genuinely malformed text cannot get in — the
     * database refuses it. What CAN get in is valid JSON that is not a usable
     * set of offsets: an empty list, or entries that are not numbers.
     *
     * Falling back is the point. A broken schedule must not mean "remind
     * nobody" — the buyer is not the one who broke it, and silence is
     * indistinguishable from a company that chose silence.
     */
    for (const [label, value] of [
      ['an empty list', []],
      ['entries that are not days', ['soon', null]],
      ['an object instead of a list', { days: 3 }],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await sequelize.query(
        'UPDATE reminder_schedules SET offsets = :value WHERE company_id = 7 AND is_default IS TRUE',
        { replacements: { value: JSON.stringify(value) } },
      );
      // eslint-disable-next-line no-await-in-loop
      // Invoice 1, which was put back on the company default above — invoice 2
      // is still on the named schedule and would never reach this level.
      const resolved = await scheduleForInvoice(sequelize, { invoiceId: 1, companyId: 7 });
      check(`A schedule holding ${label} falls back to the built-in`,
        JSON.stringify(resolved.offsets) === JSON.stringify(BUILT_IN_OFFSETS),
        JSON.stringify(resolved.offsets));
    }
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

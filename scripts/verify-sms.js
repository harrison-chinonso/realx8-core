/**
 * Sending an SMS on a company's own account.
 *
 * ── What this proves ───────────────────────────────────────────────────────
 *
 *   * a number typed any of the ways a person types it reaches the provider in
 *     the one format it accepts;
 *   * a company's own credentials beat the platform's, and beat the
 *     environment — and the three never mix, because a company's sender name
 *     on the platform's account bills the wrong party under the wrong name;
 *   * sending is OFF until somebody switches it on, whatever credentials exist;
 *   * the API key is never readable back out of the settings endpoint;
 *   * saving the form without retyping the key does not erase it;
 *   * the provider's error strings arrive as something a person can act on;
 *   * an SMS failure never breaks the notification that carried it.
 *
 * The provider is stubbed at the HTTP boundary — this must not send real
 * messages or spend anybody's units — but everything on THIS side of that
 * boundary is the real code.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_sms`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifysms';

// The environment fallback, set before anything reads it.
delete process.env.EBULKSMS_USERNAME;
delete process.env.EBULKSMS_API_KEY;
delete process.env.EBULKSMS_SENDER;
process.env.EBULKSMS_BASE_URL = 'https://sms.invalid';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

/** Every request the stubbed provider was given, so the wire format is assertable. */
const sent = [];
let nextResponse = { status: 'SUCCESS', totalsent: '1', cost: '1' };
let lastBalanceUrl = '';

const stubProvider = () => {
  const real = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/balance/')) {
      lastBalanceUrl = target;
      // Decoded the way any server would, so the stub cannot pass a request
      // the real provider would reject — or reject one it would accept.
      const [username, apikey] = target.split('/balance/')[1].split('/').map(decodeURIComponent);
      const ok = username === 'ops@acme.test' && apikey === 'acme-key';
      return { ok: true, status: 200, text: async () => (ok ? '1450' : 'AUTH_FAILURE') };
    }
    sent.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ response: nextResponse }) };
  };
  return () => { global.fetch = real; };
};

(async () => {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  const restore = stubProvider();

  const models = require('../services/user-service/src/models');
  const { sequelize, Setting, Company, User } = models;
  await sequelize.sync({ force: true });

  const {
    sendCompanySms, smsCredentialsFor, maskedSmsSettings, toInternational, SMS_KEYS,
  } = require('../shared/src/sms');
  const smsSettings = require('../services/user-service/src/controllers/smsSettingsController');

  const run = (handler, req) => new Promise((resolve) => {
    let code = 200;
    const res = {
      status(c) { code = c; return res; },
      json(body) { resolve({ code, body }); return res; },
    };
    Promise.resolve(handler(req, res, (err) => resolve({ code: 500, body: { error: err } })))
      .catch((err) => resolve({ code: 500, body: { error: err } }));
  });

  await Company.create({ id: 1, name: 'Acme Homes', slug: 'acme', email: 'a@example.test' });
  await Company.create({ id: 2, name: 'Beta Realty', slug: 'beta', email: 'b@example.test' });
  const acme = { id: 10, company_id: 1, type: 'admin', isSuperiorAdmin: false };

  const put = (key, value, companyId) => Setting.create({ key, value, group: 'sms', company_id: companyId });

  console.log('\n── A number, however somebody typed it ──────────────────────────');
  {
    const cases = [
      ['08031234567', '2348031234567'],
      ['+234 803 123 4567', '2348031234567'],
      ['234-803-123-4567', '2348031234567'],
      ['8031234567', '2348031234567'],
    ];
    const wrong = cases.filter(([input, want]) => toInternational(input) !== want);
    check('Every shape reaches the one format the provider accepts',
      wrong.length === 0, wrong.map(([i]) => i).join(', '));
    check('...and something that is not a number is refused rather than guessed',
      toInternational('12345') === null && toInternational('') === null, '');
  }

  console.log('\n── Nothing sends until somebody switches it on ──────────────────');
  {
    await put(SMS_KEYS.username, 'ops@acme.test', 1);
    await put(SMS_KEYS.apikey, 'acme-key', 1);
    await put(SMS_KEYS.sender, 'ACME', 1);

    const before = sent.length;
    const out = await sendCompanySms(sequelize, { companyId: 1, to: '08031234567', body: 'hello' });
    check('Full credentials are not consent to start sending',
      out.skipped === true && sent.length === before, out.reason);

    await put(SMS_KEYS.enabled, '1', 1);
    const on = await sendCompanySms(sequelize, { companyId: 1, to: '08031234567', body: 'hello' });
    check('...and once it is on, it sends', on.ok === true && sent.length === before + 1,
      `status ${on.status}`);
  }

  console.log('\n── The wire format is what the provider documents ───────────────');
  {
    const body = sent[sent.length - 1];
    check('Credentials, sender and text are where eBulkSMS expects them',
      body.SMS.auth.username === 'ops@acme.test'
        && body.SMS.auth.apikey === 'acme-key'
        && body.SMS.message.sender === 'ACME'
        && body.SMS.message.messagetext === 'hello',
      JSON.stringify(body.SMS.message));
    check('...the number is international and unpunctuated',
      body.SMS.recipients.gsm[0].msidn === '2348031234567', body.SMS.recipients.gsm[0].msidn);
    /*
     * msgid is what a delivery report is matched on. One per REQUEST would make
     * every recipient's report indistinguishable.
     */
    const many = await sendCompanySms(sequelize, {
      companyId: 1, to: ['08031234567', '08069998888'], body: 'two',
    });
    const ids = sent[sent.length - 1].SMS.recipients.gsm.map((g) => g.msgid);
    check('...and each recipient carries its own message id',
      ids.length === 2 && new Set(ids).size === 2 && many.ok, ids.join(', '));
  }

  console.log('\n── A company pays on its own account, never a mixture ───────────');
  {
    // The platform's shared account, which Beta will fall back to.
    await put(SMS_KEYS.username, 'platform@realx8.test', null);
    await put(SMS_KEYS.apikey, 'platform-key', null);
    await put(SMS_KEYS.sender, 'REALX8', null);
    await put(SMS_KEYS.enabled, '1', null);

    const beta = await smsCredentialsFor(sequelize, 2);
    check("A company with none of its own uses the platform's",
      beta.username === 'platform@realx8.test' && beta.sender === 'REALX8' && beta.source === 'platform',
      `${beta.username} / ${beta.sender}`);

    const own = await smsCredentialsFor(sequelize, 1);
    /*
     * The combination that must never happen: Acme's sender on the platform's
     * key. It would bill the platform for Acme's messages and put a sender ID
     * on them that the platform has not registered — which is how an ID gets
     * blocked for every other company on the account too.
     */
    check('...and a company with its own uses all of its own',
      own.username === 'ops@acme.test' && own.apikey === 'acme-key'
        && own.sender === 'ACME' && own.source === 'company',
      `${own.username} / ${own.sender}`);

    /*
     * The case a complete set cannot test.
     *
     * A company that has typed ONLY a sender name has not set up an account —
     * it has half-filled a form. Merging field by field would hand it the
     * platform's key with its own sender on top, which is the forbidden mix
     * arriving by accident rather than by design: the platform pays, and a
     * sender ID it has never registered goes out on its account, which is how
     * an ID gets blocked for every company sharing it.
     *
     * Measured: without the all-or-nothing rule this check is the only one
     * that fails, because every other company in this fixture has a full set.
     */
    await Company.create({ id: 3, name: 'Gamma Ltd', slug: 'gamma', email: 'g@example.test' });
    await put(SMS_KEYS.sender, 'GAMMA', 3);
    const partial = await smsCredentialsFor(sequelize, 3);
    check('A half-filled form does NOT borrow the platform’s account',
      partial.sender === 'REALX8' && partial.source === 'platform',
      `would have sent as "${partial.sender}" on ${partial.username}`);
  }

  console.log('\n── The key goes in and does not come back ───────────────────────');
  {
    const masked = await maskedSmsSettings(sequelize, 1);
    const serialised = JSON.stringify(masked);
    check('The settings view never carries the key',
      !serialised.includes('acme-key'), serialised);
    check('...only that one is saved, and its last four characters',
      masked.api_key_set === true && masked.api_key_hint === '••••-key', masked.api_key_hint);

    const out = await run(smsSettings.getSmsSettings, { user: acme, query: {} });
    check('...and neither does the endpoint', !JSON.stringify(out.body).includes('acme-key'), '');
    check('...which still says whether a message would go out',
      out.body?.data?.ready === true, JSON.stringify(out.body?.data?.reason));
  }

  console.log('\n── Saving the form does not erase the key ───────────────────────');
  {
    /*
     * The screen never receives the key, so a form that posts what it was given
     * posts an empty one. Without the guard, changing a sender name would wipe
     * a working credential and SMS would stop with nothing in any log.
     */
    const out = await run(smsSettings.saveSmsSettings, {
      user: acme, body: { sender: 'ACMEHOMES', api_key: '' },
    });
    const after = await smsCredentialsFor(sequelize, 1);
    check('Changing the sender leaves the key alone',
      out.code === 200 && after.apikey === 'acme-key', `key is now "${after.apikey}"`);
    check('...and the sender did change', after.sender === 'ACMEHOMES', after.sender);

    const bad = await run(smsSettings.saveSmsSettings, {
      user: acme, body: { sender: 'WAYTOOLONGSENDERNAME' },
    });
    check('A sender the provider would reject is refused here first',
      bad.code === 400, bad.body?.message);
  }

  console.log('\n── The provider’s errors arrive as something to act on ──────────');
  {
    const cases = [
      ['AUTH_FAILURE', /rejected the username and API key/i],
      ['INSUFFICIENT_CREDIT', /out of credit/i],
      ['INVALID_SENDER', /11 letters or 14 digits/i],
    ];
    const wrong = [];
    for (const [status, expected] of cases) {
      nextResponse = { status };
      const out = await sendCompanySms(sequelize, { companyId: 1, to: '08031234567', body: 'x' });
      if (out.ok || !expected.test(out.message)) wrong.push(`${status} → ${out.message}`);
    }
    check('Each bare status token becomes a sentence', wrong.length === 0, wrong.join('; '));

    nextResponse = { status: 'INSUFFICIENT_CREDIT' };
    const credit = await sendCompanySms(sequelize, { companyId: 1, to: '08031234567', body: 'x' });
    check('...and the ones worth retrying say so', credit.retryable === true, '');
    nextResponse = { status: 'SUCCESS', totalsent: '1', cost: '1' };
  }

  console.log('\n── A failing SMS never breaks the notification ──────────────────');
  {
    await sequelize.query(`CREATE TABLE notifications (
      id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, sent_by INT NULL, title VARCHAR(255),
      body TEXT, type VARCHAR(80), is_read TINYINT DEFAULT 0, data TEXT NULL,
      company_id INT NULL, created_at DATETIME)`);
    await User.create({
      id: 77, name: 'Ada Obi', email: 'ada@example.test', password: 'x',
      type: 'client', company_id: 1, phone: '08031234567',
    });

    const { createNotifier } = require('../shared/src/notifier');
    const { notifyUser } = createNotifier(sequelize);

    nextResponse = { status: 'AUTH_FAILURE' };
    const result = await notifyUser({
      userId: 77, title: 'Payment approved', body: 'Your payment was approved.',
      type: 'payment_approved', companyId: 1, channel: 'in_app,sms',
    });
    const [row] = await sequelize.query('SELECT title FROM notifications WHERE user_id = 77',
      { type: sequelize.constructor.QueryTypes.SELECT });
    check('The in-app row is written even though the SMS failed',
      result.inApp === true && row?.title === 'Payment approved', JSON.stringify(result.sms?.status));

    nextResponse = { status: 'SUCCESS', totalsent: '1', cost: '1' };
    await notifyUser({
      userId: 77, title: 'Payment approved', body: 'Your payment was approved.',
      type: 'payment_approved', companyId: 1, channel: 'sms',
    });
    const text = sent[sent.length - 1].SMS.message.messagetext;
    /*
     * Title first: it is the part that says what happened, and a text is billed
     * by the 160-character page.
     */
    check('The text leads with the title, not the email body',
      text.startsWith('Payment approved'), text);
    check('...and carries no sign-in link', !/http/i.test(text), text);
  }

  console.log('\n── Credentials can be checked before they are saved ─────────────');
  {
    const good = await run(smsSettings.testSmsCredentials, {
      user: acme, body: { username: 'ops@acme.test', api_key: 'acme-key' },
    });
    check('A working pair reports the balance',
      good.code === 200 && /1450/.test(good.body?.message || ''), good.body?.message);
    /*
     * The '@' reaches the provider as itself. Percent-encoding it would rely
     * on the provider decoding the path before comparing, and if it does not,
     * a perfectly good key reads as AUTH_FAILURE.
     */
    check('...with the email unescaped in the path',
      lastBalanceUrl.includes('ops@acme.test') && !lastBalanceUrl.includes('%40'),
      lastBalanceUrl);

    const bad = await run(smsSettings.testSmsCredentials, {
      user: acme, body: { username: 'ops@acme.test', api_key: 'wrong' },
    });
    check('...and a wrong one says what the provider said',
      bad.code === 400 && /AUTH_FAILURE/.test(bad.body?.message || ''), bad.body?.message);
  }

  restore();
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await sequelize.close();
  await admin.query(`DROP DATABASE \`${DB}\``);
  await admin.end();
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

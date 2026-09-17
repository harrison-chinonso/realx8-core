/**
 * Sending an SMS on a company's own account, through the provider it chose.
 *
 * ── What this proves ───────────────────────────────────────────────────────
 *
 *   * all four providers are reachable, each posting the body ITS OWN
 *     documentation specifies — the whole point of a registry;
 *   * a company switches provider by changing one setting, and the credentials
 *     of the others are left where they are;
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

/** Every request a stubbed provider was given, so each wire format is assertable. */
const sent = [];
let nextResponse = { status: 'SUCCESS', totalsent: '1', cost: '1' };
let lastBalanceUrl = '';

/**
 * All four providers, stubbed at the HTTP boundary.
 *
 * Nothing real is sent and nobody's units are spent — but everything on THIS
 * side of fetch is the real code, including each provider's own request
 * builder and response reader, which is the part a registry can get wrong.
 */
const stubProvider = () => {
  const real = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const record = (provider, body) => sent.push({ provider, url: target, options, body });

    // ── eBulkSMS ───────────────────────────────────────────────────────────
    if (target.includes('/balance/')) {
      lastBalanceUrl = target;
      const [username, apikey] = target.split('/balance/')[1].split('/').map(decodeURIComponent);
      const ok = username === 'ops@acme.test' && apikey === 'acme-key';
      return { ok: true, status: 200, text: async () => (ok ? '1450' : 'AUTH_FAILURE') };
    }
    if (target.includes('sendsms.json')) {
      record('ebulksms', JSON.parse(options.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ response: nextResponse }) };
    }

    // ── Termii ─────────────────────────────────────────────────────────────
    if (target.includes('/api/get-balance')) {
      lastBalanceUrl = target;
      const ok = target.includes('api_key=termii-key');
      return {
        ok: true,
        status: ok ? 200 : 401,
        text: async () => JSON.stringify(ok
          ? { application: 'Acme', balance: 785.57, currency: 'NGN', user: 'Acme' }
          : { message: 'Invalid API key' }),
      };
    }
    if (target.includes('/api/sms/send')) {
      record('termii', JSON.parse(options.body));
      const fail = nextResponse.status && nextResponse.status !== 'SUCCESS';
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(fail
          ? { code: 400, message: 'Insufficient balance' }
          : { code: 'ok', balance: 780, message_id: 'tm-1', message: 'Successfully Sent' }),
      };
    }

    // ── Sendchamp ──────────────────────────────────────────────────────────
    if (target.includes('/api/v1/sms/send')) {
      const body = JSON.parse(options.body);
      if (!body.to) {
        // The credential probe: a deliberately empty request.
        const authorised = (options.headers || {}).Authorization === 'Bearer sendchamp-key';
        return {
          ok: authorised, status: authorised ? 422 : 401,
          text: async () => JSON.stringify({ status: 'failed', message: 'Message required' }),
        };
      }
      record('sendchamp', body);
      const fail = nextResponse.status && nextResponse.status !== 'SUCCESS';
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(fail
          ? { code: 400, status: 'failed', errors: { message: ['required'] }, message: 'Message required' }
          : { code: 200, status: 'success', message: 'processing', data: { reference: 'sc-1', status: 'processing' } }),
      };
    }

    // ── SmartSMS ───────────────────────────────────────────────────────────
    if (target.includes('smartsms')) {
      const fields = Object.fromEntries(new URLSearchParams(options.body));
      if (fields.checkbalance) {
        lastBalanceUrl = target;
        return { ok: true, status: 200, text: async () => (fields.token === 'smart-token' ? '2300' : '2905') };
      }
      record('smartsms', fields);
      const fail = nextResponse.status && nextResponse.status !== 'SUCCESS';
      return { ok: true, status: 200, text: async () => (fail ? '2906||Credit exhausted' : '1000||Sent') };
    }

    throw new Error(`the stub was not taught about ${target}`);
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
    sendCompanySms, smsCredentialsFor, maskedSmsSettings, toInternational, SMS_KEYS, providerFor,
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
    await put('ebulksms_username', 'ops@acme.test', 1);
    await put('ebulksms_api_key', 'acme-key', 1);
    await put('ebulksms_sender', 'ACME', 1);

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
    const body = sent[sent.length - 1].body;
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
    const ids = sent[sent.length - 1].body.SMS.recipients.gsm.map((g) => g.msgid);
    check('...and each recipient carries its own message id',
      ids.length === 2 && new Set(ids).size === 2 && many.ok, ids.join(', '));
  }

  console.log('\n── A company pays on its own account, never a mixture ───────────');
  {
    // The platform's shared account, which Beta will fall back to.
    await put('ebulksms_username', 'platform@realx8.test', null);
    await put('ebulksms_api_key', 'platform-key', null);
    await put('ebulksms_sender', 'REALX8', null);
    await put(SMS_KEYS.enabled, '1', null);

    const beta = await smsCredentialsFor(sequelize, 2);
    check("A company with none of its own uses the platform's",
      beta.credentials.username === 'platform@realx8.test' && beta.credentials.sender === 'REALX8'
        && beta.source === 'platform',
      `${beta.credentials.username} / ${beta.credentials.sender}`);

    const own = await smsCredentialsFor(sequelize, 1);
    /*
     * The combination that must never happen: Acme's sender on the platform's
     * key. It would bill the platform for Acme's messages and put a sender ID
     * on them that the platform has not registered — which is how an ID gets
     * blocked for every other company on the account too.
     */
    check('...and a company with its own uses all of its own',
      own.credentials.username === 'ops@acme.test' && own.credentials.api_key === 'acme-key'
        && own.credentials.sender === 'ACME' && own.source === 'company',
      `${own.credentials.username} / ${own.credentials.sender}`);

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
    await put('ebulksms_sender', 'GAMMA', 3);
    const partial = await smsCredentialsFor(sequelize, 3);
    check('A half-filled form does NOT borrow the platform’s account',
      partial.credentials.sender === 'REALX8' && partial.source === 'platform',
      `would have sent as "${partial.credentials.sender}" on ${partial.credentials.username}`);
  }

  console.log('\n── The key goes in and does not come back ───────────────────────');
  {
    const masked = await maskedSmsSettings(sequelize, 1);
    const serialised = JSON.stringify(masked);
    check('The settings view never carries the key',
      !serialised.includes('acme-key'), serialised);
    const ebulk = masked.providers.find((entry) => entry.key === 'ebulksms');
    check('...only that one is saved, and its last four characters',
      ebulk.secrets_set.api_key === true && ebulk.values.api_key_hint === '••••-key',
      ebulk.values.api_key_hint);
    /*
     * A provider nobody has configured reports so, rather than looking half
     * ready — the picker greys it out on that.
     */
    const termiiEntry = masked.providers.find((entry) => entry.key === 'termii');
    check('...and an unconfigured provider says it is not configured',
      termiiEntry.configured === false && termiiEntry.secrets_set.api_key === false, '');

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
      user: acme, body: { credentials: { ebulksms: { sender: 'ACMEHOMES', api_key: '' } } },
    });
    const after = await smsCredentialsFor(sequelize, 1);
    check('Changing the sender leaves the key alone',
      out.code === 200 && after.credentials.api_key === 'acme-key',
      `key is now "${after.credentials.api_key}"`);
    check('...and the sender did change', after.credentials.sender === 'ACMEHOMES', after.credentials.sender);

    const bad = await run(smsSettings.saveSmsSettings, {
      user: acme, body: { credentials: { ebulksms: { sender: 'WAYTOOLONGSENDERNAME' } } },
    });
    check('A sender the provider would reject is refused here first',
      bad.code === 400, bad.body?.message);

    const nonsense = await run(smsSettings.saveSmsSettings, {
      user: acme, body: { credentials: { carrierpigeon: { api_key: 'x' } } },
    });
    check('...as is a provider this platform does not have',
      nonsense.code === 400, nonsense.body?.message);
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
    const text = sent[sent.length - 1].body.SMS.message.messagetext;
    /*
     * Title first: it is the part that says what happened, and a text is billed
     * by the 160-character page.
     */
    check('The text leads with the title, not the email body',
      text.startsWith('Payment approved'), text);
    check('...and carries no sign-in link', !/http/i.test(text), text);
  }

  console.log('\n── Each provider posts what ITS OWN documentation says ──────────');
  {
    /*
     * The point of a registry. Four providers, four request shapes, and a
     * single switched setting decides which one a company's messages go
     * through. Getting one of these wrong is invisible until real messages
     * stop arriving, because every provider answers 200 to something.
     */
    await put('termii_api_key', 'termii-key', 1);
    await put('termii_sender', 'ACME', 1);
    await put('sendchamp_api_key', 'sendchamp-key', 1);
    await put('sendchamp_sender', 'ACME', 1);
    await put('smartsms_api_key', 'smart-token', 1);
    await put('smartsms_sender', 'ACME', 1);

    const switchTo = async (key) => {
      await run(smsSettings.saveSmsSettings, { user: acme, body: { provider: key } });
      return sendCompanySms(sequelize, { companyId: 1, to: '08031234567', body: 'hello' });
    };

    /*
     * No sms_dnd_sender row anywhere in this fixture — which is the common
     * case, and the one that used to pick the promotional route.
     */
    const termii = await switchTo('termii');
    const tBody = sent[sent.length - 1];
    check('Termii takes api_key, to, from, sms and a channel',
      termii.ok && tBody.provider === 'termii'
        && tBody.body.api_key === 'termii-key' && tBody.body.from === 'ACME'
        && tBody.body.sms === 'hello' && tBody.body.type === 'plain',
      JSON.stringify({ ...tBody.body, api_key: '…' }));
    /*
     * `dnd`, not `generic`. Everything this application sends is transactional,
     * and the promotional route will not reach a number on the Do-Not-Disturb
     * register — which in Nigeria is most of them. It would look like it worked
     * and quietly not arrive.
     */
    check('...on the dnd channel BY DEFAULT, because these are transactional',
      tBody.body.channel === 'dnd', tBody.body.channel);
    check('...and one number goes to /sms/send, not the bulk endpoint',
      tBody.url.endsWith('/api/sms/send'), tBody.url);

    const sendchamp = await switchTo('sendchamp');
    const sBody = sent[sent.length - 1];
    check('Sendchamp takes a Bearer key, sender_name and a route',
      sendchamp.ok && sBody.provider === 'sendchamp'
        && sBody.options.headers.Authorization === 'Bearer sendchamp-key'
        && sBody.body.sender_name === 'ACME' && sBody.body.route === 'dnd',
      JSON.stringify(sBody.body));
    /*
     * Their schema says `to` is an array even for one number. A bare string is
     * the kind of thing that works in a sandbox and fails in production.
     */
    check('...with `to` as an array even for a single number',
      Array.isArray(sBody.body.to) && sBody.body.to.length === 1, JSON.stringify(sBody.body.to));

    const smart = await switchTo('smartsms');
    const smBody = sent[sent.length - 1];
    check('SmartSMS takes a form-encoded token, sender, to and message',
      smart.ok && smBody.provider === 'smartsms'
        && smBody.body.token === 'smart-token' && smBody.body.sender === 'ACME'
        && smBody.body.message === 'hello' && smBody.body.to === '2348031234567',
      JSON.stringify({ ...smBody.body, token: '…' }));
    check('...on the DND-capable route',
      smBody.body.routing === '3', smBody.body.routing);
    /*
     * SmartSMS answers `1000||Sent` rather than JSON on some accounts. The
     * reader takes JSON, pipe-delimited and a bare code, because all three are
     * attested and picking one would work until it did not.
     */
    check('...and its pipe-delimited reply is understood as success',
      smart.status === 'SUCCESS', smart.message);

    const back = await switchTo('ebulksms');
    check('Switching back uses eBulkSMS again',
      back.ok && sent[sent.length - 1].provider === 'ebulksms', sent[sent.length - 1].provider);
  }

  console.log('\n── Switching provider leaves the others where they are ──────────');
  {
    /*
     * The reason credentials are stored per provider rather than in one set of
     * fields: a company can fill in two and move between them. If switching
     * overwrote the previous provider's credentials, changing back would mean
     * re-keying — and nobody would move during an outage, which is when they
     * most need to.
     */
    await run(smsSettings.saveSmsSettings, { user: acme, body: { provider: 'termii' } });
    const now = await smsCredentialsFor(sequelize, 1);
    check('The live provider changed', now.provider === 'termii', now.provider);

    const masked = await maskedSmsSettings(sequelize, 1);
    const ebulk = masked.providers.find((e) => e.key === 'ebulksms');
    check("...and eBulkSMS's credentials are untouched",
      ebulk.configured === true && ebulk.values.sender === 'ACMEHOMES',
      `${ebulk.values.username} / ${ebulk.values.sender}`);
    check('...with all four offered to the picker',
      masked.providers.length === 4, masked.providers.map((e) => e.key).join(', '));

    await run(smsSettings.saveSmsSettings, { user: acme, body: { provider: 'ebulksms' } });
  }

  console.log('\n── An unknown provider degrades rather than going silent ────────');
  {
    /*
     * A settings row written by a newer version of the platform, or a typo.
     * Falling back to a provider that exists is the only behaviour that does
     * not take every notification in the company down with it.
     */
    await put('sms_provider', 'carrier-pigeon', 1);
    const out = await smsCredentialsFor(sequelize, 1);
    check('It falls back to a provider that exists', out.provider === 'ebulksms', out.provider);

    /*
     * Asserted directly as well as through the settings path, because the two
     * are separate guards and only one of them is on that path:
     * activeProviderKey validates the stored value, so providerFor's own
     * fallback is never reached from there. It is a public export, though —
     * anything may call it with anything — and a `undefined.FIELDS` a layer
     * further in is a much worse error than a default.
     */
    check('...and providerFor degrades on its own too',
      providerFor('carrier-pigeon')?.key === 'ebulksms' && providerFor(null)?.key === 'ebulksms',
      '');
    await run(smsSettings.saveSmsSettings, { user: acme, body: { provider: 'ebulksms' } });
  }

  console.log('\n── Credentials can be checked before they are saved ─────────────');
  {
    const good = await run(smsSettings.testSmsCredentials, {
      user: acme, body: { provider: 'ebulksms', username: 'ops@acme.test', api_key: 'acme-key' },
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
      user: acme, body: { provider: 'ebulksms', username: 'ops@acme.test', api_key: 'wrong' },
    });
    check('...and a wrong one says what the provider said',
      bad.code === 400 && /AUTH_FAILURE/.test(bad.body?.message || ''), bad.body?.message);

    // Each provider is checked its own way: eBulkSMS and Termii have balance
    // endpoints, Sendchamp has none and says so rather than implying one.
    const termii = await run(smsSettings.testSmsCredentials, {
      user: acme, body: { provider: 'termii', api_key: 'termii-key' },
    });
    check('Termii reports its balance and currency',
      termii.code === 200 && /785\.57 NGN/.test(termii.body?.message || ''), termii.body?.message);

    const champ = await run(smsSettings.testSmsCredentials, {
      user: acme, body: { provider: 'sendchamp', api_key: 'sendchamp-key' },
    });
    check('Sendchamp accepts the key and is honest that it has no balance endpoint',
      champ.code === 200 && /no balance endpoint/i.test(champ.body?.message || ''), champ.body?.message);

    const champBad = await run(smsSettings.testSmsCredentials, {
      user: acme, body: { provider: 'sendchamp', api_key: 'nope' },
    });
    check('...and rejects a key it does not know', champBad.code === 400, champBad.body?.message);

    const smart = await run(smsSettings.testSmsCredentials, {
      user: acme, body: { provider: 'smartsms', api_key: 'smart-token' },
    });
    check('SmartSMS reports its unit balance',
      smart.code === 200 && /2300/.test(smart.body?.message || ''), smart.body?.message);
  }

  restore();
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await sequelize.close();
  await admin.query(`DROP DATABASE \`${DB}\``);
  await admin.end();
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

const asyncHandler = require('../utils/asyncHandler');
const { Setting, sequelize } = require('../models');
const { evictSettings } = require('../../../../shared/src/cacheEvict');
const {
  maskedSmsSettings, smsCredentialsFor, checkSmsCredentials, sendCompanySms,
  SMS_KEYS, SMS_GROUP,
} = require('../../../../shared/src/sms');
const { senderIsValid, toInternational } = require('../../../../shared/src/sms/ebulksms');

/**
 * A company's own eBulkSMS credentials.
 *
 * ── Per company, because the units are bought per company ──────────────────
 *
 * Every company buys its own SMS credit and registers its own sender name.
 * Storing one platform-wide credential would bill one company for another's
 * messages and put the wrong name on a stranger's phone, so these are
 * `settings` rows scoped by company — the same shape the payment gateway keys
 * already use, read through shared/src/sms/smsSettings.js.
 *
 * A platform administrator may administer a named company's credentials with
 * ?company_id=, and a company administrator is pinned to their own by
 * targetCompany below. That is the same rule every other settings group here
 * follows.
 */

/** Whose settings this request is about. A company admin never chooses. */
const isSuperior = (req) => Boolean(req.user?.isSuperiorAdmin);
const targetCompany = (req, explicit) => {
  if (isSuperior(req)) {
    const value = explicit === undefined ? null : explicit;
    return value === null || value === '' ? null : Number(value);
  }
  return req.user?.company_id ?? null;
};

const write = async (key, value, companyId) => {
  const cid = companyId === null || companyId === undefined ? null : Number(companyId);
  const where = cid !== null ? { key, company_id: cid } : { key, company_id: null };
  const existing = await Setting.findOne({ where, order: [['id', 'DESC']] });
  if (existing) {
    await existing.update({ value, group: SMS_GROUP });
    return existing;
  }
  return Setting.create({ key, value, group: SMS_GROUP, company_id: cid });
};

const getSmsSettings = asyncHandler(async (req, res) => {
  const companyId = targetCompany(req, req.query.company_id);
  const data = await maskedSmsSettings(sequelize, companyId);
  const credentials = await smsCredentialsFor(sequelize, companyId);

  res.json({
    data: {
      ...data,
      company_id: companyId,
      /*
       * Whether a message sent right now would actually go out, and if not
       * why. An administrator who has filled the form in and turned nothing on
       * otherwise discovers the switch by wondering why nobody got a text.
       */
      ready: credentials.ready,
      reason: credentials.ready ? null : credentials.reason,
      // Whose account would pay: this company's, the platform's, or the
      // deployment's environment variables.
      source: credentials.source,
    },
  });
});

const saveSmsSettings = asyncHandler(async (req, res) => {
  const companyId = targetCompany(req, req.body.company_id);
  const body = req.body || {};

  const sender = body.sender === undefined ? undefined : String(body.sender).trim();
  if (sender !== undefined && sender && !senderIsValid(sender)) {
    return res.status(400).json({
      message: 'A sender name is at most 11 letters, or 14 digits if it is a number.',
    });
  }

  const written = [];
  const set = async (key, value) => { await write(key, value, companyId); written.push(key); };

  if (body.username !== undefined) await set(SMS_KEYS.username, String(body.username).trim());
  if (sender !== undefined) await set(SMS_KEYS.sender, sender);
  if (body.enabled !== undefined) await set(SMS_KEYS.enabled, body.enabled ? '1' : '0');
  if (body.dnd !== undefined) await set(SMS_KEYS.dnd, body.dnd ? '1' : '0');

  /**
   * The key is written only when a new one is actually supplied.
   *
   * It is never read back out — the screen sees four trailing characters and
   * nothing more — so a form that posts what it was given would send an empty
   * string and erase a working credential the moment somebody changed the
   * sender name. An explicit empty string still clears it, for an
   * administrator who means to.
   */
  if (typeof body.api_key === 'string' && body.api_key.trim()) {
    await set(SMS_KEYS.apikey, body.api_key.trim());
  } else if (body.api_key === null) {
    await set(SMS_KEYS.apikey, '');
  }

  await evictSettings(SMS_GROUP, companyId ?? null).catch(() => {});

  const data = await maskedSmsSettings(sequelize, companyId);
  const credentials = await smsCredentialsFor(sequelize, companyId);
  res.json({
    data: { ...data, company_id: companyId, ready: credentials.ready, reason: credentials.ready ? null : credentials.reason, source: credentials.source },
    saved: written,
  });
});

/**
 * Are these credentials good?
 *
 * Asked against the provider's balance endpoint rather than by sending a
 * message: checking a key by using it charges for the check and puts a real
 * text on somebody's phone. The payment gateway credential probe makes the
 * same choice for the same reason.
 *
 * Accepts credentials in the body so they can be checked BEFORE they are
 * saved — the moment an administrator most wants to know.
 */
const testSmsCredentials = asyncHandler(async (req, res) => {
  const companyId = targetCompany(req, req.body?.company_id);
  const supplied = {
    username: String(req.body?.username || '').trim(),
    apikey: String(req.body?.api_key || '').trim(),
  };

  let { username, apikey } = supplied;
  if (!username || !apikey) {
    const saved = await smsCredentialsFor(sequelize, companyId);
    // smsCredentialsFor refuses when SMS is switched off, but a credential is
    // worth checking before it is switched on.
    if (!username) username = saved.username || '';
    if (!apikey) apikey = saved.apikey || '';
  }

  const result = await checkSmsCredentials({ username, apikey });
  res.status(result.ok ? 200 : 400).json(result);
});

/**
 * One real message, to a number the administrator names.
 *
 * Separate from the credential check and never called by it, because this one
 * spends a unit and rings somebody's phone. Worth having: a valid key and a
 * registered sender still will not deliver if the sender ID has not been
 * approved by the networks, and only an actual message finds that out.
 */
const sendTestSms = asyncHandler(async (req, res) => {
  const companyId = targetCompany(req, req.body?.company_id);
  const to = String(req.body?.to || '').trim();
  if (!to) return res.status(400).json({ message: 'Enter the number to send the test to.' });
  if (!toInternational(to)) {
    return res.status(400).json({ message: `${to} does not look like a mobile number.` });
  }

  const result = await sendCompanySms(sequelize, {
    companyId,
    to,
    body: String(req.body?.body || '').trim()
      || 'Test message from your Realx8 account. If you can read this, SMS is working.',
    reference: `test-${req.user?.id ?? 0}`,
  });

  if (result.skipped) return res.status(409).json({ message: result.reason });
  return res.status(result.ok ? 200 : 502).json({
    ok: result.ok,
    message: result.ok ? `Sent to ${result.recipients.join(', ')}.` : result.message,
    status: result.status,
    cost: result.cost,
    sent: result.sent,
  });
});

module.exports = { getSmsSettings, saveSmsSettings, testSmsCredentials, sendTestSms };

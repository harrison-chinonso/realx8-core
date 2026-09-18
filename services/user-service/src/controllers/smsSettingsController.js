const asyncHandler = require('../utils/asyncHandler');
const { Setting, sequelize } = require('../models');
const { evictSettings } = require('../../../../shared/src/cacheEvict');
const { checkOutboundUrl, smsAllowedHosts } = require('../../../../shared/src/safeUrl');
const {
  maskedSmsSettings, smsCredentialsFor, checkSmsCredentials, sendCompanySms,
  providerFor, providerCatalogue, toInternational, senderIsValid,
  PROVIDER_KEYS, SMS_KEYS, SMS_GROUP, smsFieldKey, smsSecretFields,
} = require('../../../../shared/src/sms');

/**
 * A company's SMS providers, and which one is live.
 *
 * ── Per company, because the units are bought per company ──────────────────
 *
 * Every company buys its own SMS credit and registers its own sender name.
 * One platform-wide credential would bill one company for another's messages
 * and put the wrong name on a stranger's phone, so these are `settings` rows
 * scoped by company — the same shape the payment gateway keys already use.
 *
 * ── Several configured, one active ─────────────────────────────────────────
 *
 * Credentials are stored per provider, so a company can fill in two and switch
 * between them. That is what makes changing provider a choice rather than a
 * re-keying exercise, and what makes moving off one during an outage possible
 * at all.
 *
 * A platform administrator may administer a named company's with ?company_id=,
 * and a company administrator is pinned to their own — the same rule every
 * other settings group here follows.
 */

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

/** The full picture: the catalogue, what is saved, and whether it would send. */
const present = async (companyId) => {
  const masked = await maskedSmsSettings(sequelize, companyId);
  const credentials = await smsCredentialsFor(sequelize, companyId);
  return {
    ...masked,
    company_id: companyId,
    /*
     * Whether a message sent right now would actually go out, and if not why.
     * An administrator who has filled the form in and turned nothing on
     * otherwise discovers the switch by wondering why nobody got a text.
     */
    ready: credentials.ready,
    reason: credentials.ready ? null : credentials.reason,
    // Whose account would pay: this company's, the platform's, or the
    // deployment's environment variables.
    source: credentials.source,
  };
};

const getSmsSettings = asyncHandler(async (req, res) => {
  res.json({ data: await present(targetCompany(req, req.query.company_id)) });
});

const saveSmsSettings = asyncHandler(async (req, res) => {
  const companyId = targetCompany(req, req.body.company_id);
  const body = req.body || {};
  const written = [];
  const set = async (key, value) => { await write(key, value, companyId); written.push(key); };

  if (body.provider !== undefined) {
    const chosen = String(body.provider || '').trim().toLowerCase();
    if (!PROVIDER_KEYS.includes(chosen)) {
      return res.status(400).json({
        message: `Choose one of: ${PROVIDER_KEYS.join(', ')}.`,
      });
    }
    await set(SMS_KEYS.provider, chosen);
  }

  if (body.enabled !== undefined) await set(SMS_KEYS.enabled, body.enabled ? '1' : '0');
  if (body.dnd !== undefined) await set(SMS_KEYS.dnd, body.dnd ? '1' : '0');

  /**
   * Credentials arrive as { credentials: { termii: { api_key, sender } } }.
   *
   * Keyed by provider so a company can fill in more than one, and so saving
   * Termii's sender name cannot touch eBulkSMS's.
   */
  const supplied = body.credentials && typeof body.credentials === 'object' ? body.credentials : {};
  for (const [providerKey, values] of Object.entries(supplied)) {
    if (!PROVIDER_KEYS.includes(providerKey)) {
      return res.status(400).json({ message: `${providerKey} is not a provider this platform supports.` });
    }
    const provider = providerFor(providerKey);
    const secrets = smsSecretFields(provider);

    for (const field of provider.FIELDS) {
      if (!(field.key in values)) continue;
      const raw = values[field.key];

      if (secrets.includes(field.key)) {
        /**
         * A secret is written only when a new one is actually supplied.
         *
         * It is never read back out — the screen sees four trailing characters
         * and nothing more — so a form that posts what it was given would send
         * an empty string and erase a working credential the moment somebody
         * changed the sender name. An explicit null still clears it, for an
         * administrator who means to.
         */
        if (typeof raw === 'string' && raw.trim()) await set(smsFieldKey(providerKey, field.key), raw.trim());
        else if (raw === null) await set(smsFieldKey(providerKey, field.key), '');
        continue;
      }

      const value = String(raw ?? '').trim();
      /**
       * A base URL is an address this SERVER will fetch, not a string it
       * stores. Unchecked, it turned settings.sms.manage — a permission a
       * company administrator legitimately holds — into the ability to make
       * the API issue requests anywhere it can reach and read the answer back.
       * See shared/src/safeUrl.js.
       */
      if (field.key === 'base_url' && value) {
        // eslint-disable-next-line no-await-in-loop
        const verdict = await checkOutboundUrl(value, { allowedHosts: smsAllowedHosts() });
        if (!verdict.ok) {
          return res.status(400).json({ message: `${provider.label} base URL: ${verdict.reason}` });
        }
      }
      if (field.key === 'sender' && value && !senderIsValid(value)) {
        return res.status(400).json({
          message: `A ${provider.label} sender name is at most 11 letters, or 14 digits if it is a number.`,
        });
      }
      if (field.options && value && !field.options.includes(value)) {
        return res.status(400).json({
          message: `${field.label} must be one of: ${field.options.join(', ')}.`,
        });
      }
      await set(smsFieldKey(providerKey, field.key), value);
    }
  }

  await evictSettings(SMS_GROUP, companyId ?? null).catch(() => {});
  return res.json({ data: await present(companyId), saved: written });
});

/**
 * Are these credentials good?
 *
 * Asked the cheapest way the chosen provider offers — a balance read where
 * there is one — never by sending: checking a key by using it charges for the
 * check and puts a real text on somebody's phone.
 *
 * Accepts credentials in the body so they can be checked BEFORE they are
 * saved, which is the moment an administrator most wants to know.
 */
const testSmsCredentials = asyncHandler(async (req, res) => {
  const companyId = targetCompany(req, req.body?.company_id);
  const requested = String(req.body?.provider || '').trim().toLowerCase();

  const saved = await smsCredentialsFor(sequelize, companyId);
  const providerKey = PROVIDER_KEYS.includes(requested) ? requested : saved.provider;
  const stored = providerKey === saved.provider ? (saved.credentials || {}) : {};

  /*
   * Checked here as well as on save, because this endpoint accepts credentials
   * — and a base URL — in the body so they can be tried BEFORE they are
   * stored. Validating only the stored copy would leave the unstored path,
   * which is the one an attacker would use.
   */
  const suppliedBaseUrl = String(req.body?.base_url || '').trim();
  if (suppliedBaseUrl) {
    const verdict = await checkOutboundUrl(suppliedBaseUrl, { allowedHosts: smsAllowedHosts() });
    if (!verdict.ok) return res.status(400).json({ ok: false, message: `Base URL: ${verdict.reason}` });
  }

  const result = await checkSmsCredentials({
    provider: providerKey,
    username: String(req.body?.username || '').trim() || stored.username,
    apikey: String(req.body?.api_key || '').trim() || stored.api_key,
    baseUrl: suppliedBaseUrl || stored.base_url || null,
  });

  res.status(result.ok ? 200 : 400).json(result);
});

/**
 * One real message, to a number the administrator names.
 *
 * Separate from the credential check and never called by it, because this one
 * spends a unit and rings somebody's phone. Worth having: a valid key and a
 * saved sender still will not deliver if the sender ID has not been approved
 * by the networks, and only an actual message finds that out.
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
    provider: result.provider,
    message: result.ok ? `Sent to ${result.recipients.join(', ')} via ${result.provider}.` : result.message,
    status: result.status,
    cost: result.cost,
    sent: result.sent,
  });
});

/** The providers this platform supports, and what each one needs typed in. */
const listSmsProviders = asyncHandler(async (req, res) => {
  res.json({ data: providerCatalogue() });
});

module.exports = {
  getSmsSettings, saveSmsSettings, testSmsCredentials, sendTestSms, listSmsProviders,
};

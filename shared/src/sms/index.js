const { providerFor, providerCatalogue, PROVIDER_KEYS, DEFAULT_PROVIDER } = require('./providers');
const {
  smsCredentialsFor, maskedSmsSettings, smsSettingsFor, activeProviderKey,
  KEYS, GROUP, fieldKey, secretFields,
} = require('./smsSettings');
const { toInternational, senderIsValid } = require('./phone');

/**
 * Sending a text on a company's behalf, through whichever provider it chose.
 *
 * The one function the rest of the application calls. It resolves which
 * provider is live and whose account pays, hands that provider what it wants,
 * and answers with something a caller can log — never an exception, because
 * every caller is a notification path and a notification must not take down
 * the thing it reports.
 */

/**
 * @param sequelize   any service's connection — settings is one table
 * @param {object} args
 *   companyId  whose account pays, and whose sender name appears
 *   to         one number or several, in any shape a person types them
 *   body       the message
 *   reference  a stable prefix for the per-recipient message ids
 *
 * @returns {Promise<{ok, skipped?, reason?, status?, sent?, cost?, provider?}>}
 */
const sendCompanySms = async (sequelize, { companyId = null, to, body, reference = null, flash = false } = {}) => {
  const resolved = await smsCredentialsFor(sequelize, companyId).catch((error) => ({
    ready: false, reason: `Could not read the SMS settings: ${error.message}`,
  }));

  /*
   * Not configured is SKIPPED, not failed.
   *
   * Most companies will never turn SMS on, and every notification they send
   * would otherwise log an error about a feature they have not asked for. A
   * caller that cares can tell the two apart; one that does not sees ok:false
   * either way.
   */
  if (!resolved.ready) {
    return { ok: false, skipped: true, reason: resolved.reason, provider: resolved.provider };
  }

  const provider = providerFor(resolved.provider);
  const credentials = resolved.credentials || {};

  const result = await provider.sendSms({
    // Every provider takes apikey and sender; the rest are its own.
    apikey: credentials.api_key,
    username: credentials.username,
    sender: credentials.sender,
    baseUrl: credentials.base_url || null,
    route: credentials.route || null,
    dnd: resolved.dnd,
    to,
    body,
    reference,
    flash,
  });

  if (!result.ok) {
    /*
     * Logged here rather than at the call site. An SMS failure is invisible by
     * design — nobody is waiting on a response — so the log line is the only
     * evidence it happened, and it names the company AND the provider because
     * both are per company and either can be the fault.
     */
    console.error(`[sms] company ${companyId ?? 'platform'} via ${provider.key}: ${result.status} — ${result.message}`);
  }

  return { ...result, skipped: false, provider: provider.key, source: resolved.source };
};

/**
 * Whether a set of credentials works, asked the cheapest way that provider
 * offers — a balance read where there is one, never a send.
 */
const checkSmsCredentials = async ({ provider: providerKey, username, apikey, baseUrl } = {}) => {
  const provider = providerFor(providerKey);
  const result = await provider.checkCredentials({ username, apikey, baseUrl });
  return { ...result, provider: provider.key, providerLabel: provider.label };
};

module.exports = {
  sendCompanySms,
  checkSmsCredentials,
  smsCredentialsFor,
  maskedSmsSettings,
  smsSettingsFor,
  activeProviderKey,
  providerFor,
  providerCatalogue,
  toInternational,
  senderIsValid,
  PROVIDER_KEYS,
  DEFAULT_PROVIDER,
  SMS_KEYS: KEYS,
  SMS_GROUP: GROUP,
  smsFieldKey: fieldKey,
  smsSecretFields: secretFields,
};

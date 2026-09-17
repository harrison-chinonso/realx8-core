const { sendSms: sendViaEbulk, checkCredentials, toInternational } = require('./ebulksms');
const { smsCredentialsFor, maskedSmsSettings, smsSettingsFor, KEYS, GROUP } = require('./smsSettings');

/**
 * Sending a text on a company's behalf.
 *
 * The one function the rest of the application calls. It resolves whose
 * account pays, hands the provider what it wants, and answers with something a
 * caller can log — never an exception, because every caller is a notification
 * path and a notification must not take down the thing it reports.
 *
 * ── Why the provider is behind two files ───────────────────────────────────
 *
 * ebulksms.js knows one provider's wire format and nothing about companies;
 * smsSettings.js knows whose credentials to use and nothing about HTTP. A
 * second provider is a third file and a branch here, rather than an edit
 * threaded through the notifier.
 */

/**
 * @param sequelize   any service's connection — settings is one table
 * @param {object} args
 *   companyId  whose account pays, and whose sender name appears
 *   to         one number or several, in any shape a person types them
 *   body       the message
 *   reference  a stable prefix for the per-recipient message ids
 *
 * @returns {Promise<{ok, skipped?, reason?, status?, sent?, cost?}>}
 */
const sendCompanySms = async (sequelize, { companyId = null, to, body, reference = null, flash = false } = {}) => {
  const credentials = await smsCredentialsFor(sequelize, companyId).catch((error) => ({
    ready: false, reason: `Could not read the SMS settings: ${error.message}`,
  }));

  /*
   * Not configured is SKIPPED, not failed.
   *
   * Most companies will never turn SMS on, and every notification they send
   * would otherwise log an error about a feature they have not asked for.
   * A caller that cares can tell the two apart; a caller that does not sees
   * ok:false either way.
   */
  if (!credentials.ready) {
    return { ok: false, skipped: true, reason: credentials.reason };
  }

  const result = await sendViaEbulk({
    username: credentials.username,
    apikey: credentials.apikey,
    sender: credentials.sender,
    dnd: credentials.dnd,
    to,
    body,
    reference,
    flash,
  });

  if (!result.ok) {
    /*
     * Logged here rather than at the call site. An SMS failure is invisible by
     * design — nobody is waiting on a response — so the log line is the only
     * evidence it happened, and it names the company because the credentials
     * are per company and so is the fault.
     */
    console.error(`[sms] company ${companyId ?? 'platform'}: ${result.status} — ${result.message}`);
  }

  return { ...result, skipped: false, source: credentials.source };
};

module.exports = {
  sendCompanySms,
  checkSmsCredentials: checkCredentials,
  smsCredentialsFor,
  maskedSmsSettings,
  smsSettingsFor,
  toInternational,
  SMS_KEYS: KEYS,
  SMS_GROUP: GROUP,
};

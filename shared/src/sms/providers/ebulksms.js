/**
 * The eBulkSMS JSON API, and nothing else.
 *
 * ── What lives here and what does not ──────────────────────────────────────
 *
 * This file knows one provider's wire format: the shape it wants, the shape it
 * answers with, and what its error strings mean. It does NOT know where
 * credentials come from, which company is sending, or what the message is
 * about. That separation is the point — swapping provider, or adding a second
 * one, should be a new file beside this rather than an edit threaded through
 * the notifier.
 *
 * Contract, from https://www.ebulksms.com/pages/json-api:
 *
 *   POST https://api.ebulksms.com/sendsms.json
 *   { SMS: { auth: { username, apikey },
 *            message: { sender, messagetext, flash },
 *            recipients: { gsm: [{ msidn, msgid }] },
 *            dndsender } }
 *
 *   → { response: { status: 'SUCCESS', totalsent, cost } }
 *
 * Balance, from https://www.ebulksms.com/pages/get-api:
 *
 *   GET https://api.ebulksms.com/balance/{username}/{apikey}   → plain text
 *
 * ── Never throws ───────────────────────────────────────────────────────────
 *
 * Every function returns a result object. An SMS is a notification, and a
 * notification failure must not roll back the thing it reports — the same rule
 * notifier.js and the dispatcher already follow.
 */
const { toInternational, senderIsValid, request, fitMessage } = require('../phone');

const DEFAULT_BASE_URL = process.env.EBULKSMS_BASE_URL || 'https://api.ebulksms.com';

/** Sender name limits, from the provider's own documentation. */
const SENDER_MAX_ALPHA = 11;
const SENDER_MAX_NUMERIC = 14;
/** One page is 160 characters and the provider accepts four. */
const MESSAGE_MAX = 612;

/**
 * What each status string means to a person.
 *
 * The provider answers with a bare token — AUTH_FAILURE, INSUFFICIENT_CREDIT —
 * and an administrator reading "AUTH_FAILURE" in a log has to go and look it
 * up. `retryable` separates "this will work later" (their service, our credit)
 * from "this will never work until somebody changes something", which is what
 * decides whether a failure is worth surfacing to a human.
 */
const STATUS = {
  SUCCESS: { ok: true, message: 'Sent.' },
  INVALID_JSON: { message: 'The provider rejected the request as malformed.' },
  MISSING_USERNAME: { message: 'No eBulkSMS username is configured.' },
  MISSING_APIKEY: { message: 'No eBulkSMS API key is configured.' },
  AUTH_FAILURE: { message: 'eBulkSMS rejected the username and API key.' },
  MISSING_SENDER: { message: 'No sender name is configured.' },
  MISSING_MESSAGE: { message: 'The message was empty.' },
  MISSING_RECIPIENT: { message: 'No recipient was given.' },
  INVALID_RECIPIENT: { message: 'The phone number was not accepted.' },
  INVALID_MESSAGE: { message: 'The message was not accepted.' },
  INVALID_SENDER: { message: 'The sender name was not accepted — 11 letters or 14 digits at most.' },
  INSUFFICIENT_CREDIT: { message: 'The eBulkSMS account is out of credit.', retryable: true },
  UNKNOWN_CONTENTTYPE: { message: 'The provider did not recognise the content type.' },
  UNKNOWN_ERROR: { message: 'eBulkSMS reported an unspecified error.', retryable: true },
};

/**
 * Send one message to one or more numbers.
 *
 * @param {object} args
 *   username, apikey, sender  the company's credentials
 *   to        a number or an array of them, in any shape a person types
 *   body      the message text
 *   flash     display-only, not saved to the handset
 *   dnd       attempt delivery to numbers on the Do-Not-Disturb register
 *   reference a stable id prefix, so a delivery report can be matched back
 *
 * @returns {Promise<{ok, status, message, sent, cost, recipients, skipped}>}
 */
const sendSms = async ({
  username, apikey, sender, to, body,
  flash = false, dnd = false, reference = null, baseUrl = null,
} = {}) => {
  const fail = (status, message, extra = {}) => ({
    ok: false, status, message, sent: 0, cost: 0, recipients: [], skipped: [], ...extra,
  });

  if (!username) return fail('MISSING_USERNAME', STATUS.MISSING_USERNAME.message);
  if (!apikey) return fail('MISSING_APIKEY', STATUS.MISSING_APIKEY.message);
  if (!senderIsValid(sender, { alpha: SENDER_MAX_ALPHA, numeric: SENDER_MAX_NUMERIC })) {
    return fail('INVALID_SENDER', STATUS.INVALID_SENDER.message);
  }

  const text = String(body ?? '').trim();
  if (!text) return fail('MISSING_MESSAGE', STATUS.MISSING_MESSAGE.message);

  /*
   * Truncated rather than refused. A notification body is written for an email
   * and an in-app row, where length is free; silently dropping the whole
   * message because it ran past four pages would be the wrong trade for the
   * person waiting to be told something.
   */
  const messagetext = fitMessage(text, MESSAGE_MAX);

  const wanted = (Array.isArray(to) ? to : [to]).filter(Boolean);
  const recipients = [];
  const skipped = [];
  wanted.forEach((raw) => {
    const msidn = toInternational(raw);
    if (msidn) recipients.push(msidn); else skipped.push(String(raw));
  });
  if (!recipients.length) return fail('INVALID_RECIPIENT', STATUS.INVALID_RECIPIENT.message, { skipped });

  const stamp = reference || `rx${Date.now().toString(36)}`;
  const payload = {
    SMS: {
      auth: { username, apikey },
      message: { sender: String(sender).trim(), messagetext, flash: flash ? '1' : '0' },
      recipients: {
        // msgid is what a delivery report is matched on, so it has to be
        // unique per recipient rather than per request.
        gsm: recipients.map((msidn, index) => ({ msidn, msgid: `${stamp}-${index}` })),
      },
      dndsender: dnd ? '1' : '0',
    },
  };

  let response;
  try {
    response = await request(`${baseUrl || DEFAULT_BASE_URL}/sendsms.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    // Network, DNS or the deadline above. Retryable by nature: nothing about
    // the request was wrong.
    return fail('UNREACHABLE', `Could not reach eBulkSMS: ${error.message}`, { retryable: true, recipients, skipped });
  }

  const parsed = response.json;

  if (!parsed?.response) {
    /*
     * The provider answers 500 with an unformatted string for some malformed
     * requests, and its own documentation says so. Carrying the first part of
     * the body is what makes that diagnosable at all.
     */
    return fail('UNPARSEABLE',
      `eBulkSMS returned an unexpected response (HTTP ${response.httpStatus}): `
      + `${String(response.text || '').slice(0, 120)}`,
      { retryable: true, recipients, skipped });
  }

  const status = String(parsed.response.status || 'UNKNOWN_ERROR').toUpperCase();
  const known = STATUS[status] || STATUS.UNKNOWN_ERROR;

  return {
    ok: Boolean(known.ok),
    status,
    message: known.message,
    retryable: Boolean(known.retryable),
    sent: Number(parsed.response.totalsent) || 0,
    cost: Number(parsed.response.cost) || 0,
    recipients,
    skipped,
  };
};

/**
 * Whether these credentials work, asked the cheapest way the provider offers.
 *
 * The balance endpoint rather than a send: checking a key by sending a message
 * charges for the check and puts a real SMS on somebody's phone. Same reasoning
 * as the payment gateways' credential probe.
 */
const checkCredentials = async ({ username, apikey, baseUrl = null } = {}) => {
  if (!username || !apikey) {
    return { ok: false, message: 'Enter both the eBulkSMS username and API key.' };
  }

  /*
   * The username is an email and goes in a PATH segment, so '@' is left as
   * itself: RFC 3986 lists it among the characters a path segment may carry
   * unescaped, and percent-encoding it to %40 relies on the provider decoding
   * before it compares — which, if it does not, reads as AUTH_FAILURE against
   * a key that is perfectly good. Anything structural is still escaped.
   */
  const segment = (value) => encodeURIComponent(value).replace(/%40/g, '@');
  try {
    const res = await request(`${baseUrl || DEFAULT_BASE_URL}/balance/${segment(username)}/${segment(apikey)}`);
    const text = String(res.text || '').trim();

    /*
     * The balance endpoint answers in plain text. A number means the
     * credentials were accepted; anything else is the provider's own error
     * string, which is more use to an administrator than "invalid".
     */
    const units = Number(text.replace(/[^\d.]/g, ''));
    if (res.ok && text && Number.isFinite(units) && /\d/.test(text)) {
      return { ok: true, units, message: `Credentials accepted. ${units} unit(s) available.` };
    }
    return { ok: false, message: text ? `eBulkSMS said: ${text.slice(0, 120)}` : 'eBulkSMS rejected the credentials.' };
  } catch (error) {
    return { ok: false, message: `Could not reach eBulkSMS: ${error.message}` };
  }
};

/**
 * What an administrator has to type, and what the settings screen renders.
 *
 * Declared by the provider rather than hardcoded in the UI, because the four
 * providers do not want the same things: Termii's base URL is per account,
 * Sendchamp has a route, and only eBulkSMS has a username.
 */
const FIELDS = [
  { key: 'username', label: 'Username', hint: 'The email you sign in to eBulkSMS with', required: true },
  { key: 'api_key', label: 'API key', secret: true, required: true, hint: 'Generated in your eBulkSMS dashboard' },
  { key: 'sender', label: 'Sender name', required: true, hint: 'Up to 11 letters, or 14 digits if numeric' },
];

module.exports = {
  key: 'ebulksms',
  label: 'eBulkSMS',
  docs: 'https://www.ebulksms.com/pages/json-api',
  FIELDS,
  sendSms,
  checkCredentials,
  MESSAGE_MAX,
  SENDER_MAX_ALPHA,
  SENDER_MAX_NUMERIC,
  STATUS,
};

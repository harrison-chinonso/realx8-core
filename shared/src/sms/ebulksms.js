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
const BASE_URL = process.env.EBULKSMS_BASE_URL || 'https://api.ebulksms.com';
const TIMEOUT_MS = Number(process.env.EBULKSMS_TIMEOUT_MS || 15000);

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
 * A Nigerian mobile number in the international format the provider wants.
 *
 * Numbers reach this application in every shape a person can type one:
 * 08031234567, +234 803 123 4567, 234-803-123-4567. The provider accepts only
 * the last of those without punctuation, and answers INVALID_RECIPIENT for the
 * rest — which reads as "the number is wrong" when the number is fine and only
 * the formatting is not.
 *
 * Returns null for anything that cannot be made into one, so the caller can
 * say so rather than paying to send into nowhere.
 */
const toInternational = (value, countryCode = process.env.SMS_COUNTRY_CODE || '234') => {
  const digits = String(value ?? '').replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (!digits) return null;

  // Already international for this country: 234XXXXXXXXXX
  if (digits.startsWith(countryCode)) {
    const rest = digits.slice(countryCode.length);
    return rest.length >= 9 && rest.length <= 11 ? `${countryCode}${rest.replace(/^0/, '')}` : null;
  }
  // Local trunk form: 0803…
  if (digits.startsWith('0')) {
    const rest = digits.slice(1);
    return rest.length >= 9 && rest.length <= 10 ? `${countryCode}${rest}` : null;
  }
  // Bare national number, no trunk prefix.
  if (digits.length >= 9 && digits.length <= 10) return `${countryCode}${digits}`;

  /*
   * Anything else is left alone rather than guessed at. A number from another
   * country is not this function's business to mangle, and a 7-digit string is
   * not a mobile number at all.
   */
  return digits.length >= 11 && digits.length <= 15 ? digits : null;
};

/** The provider's own sender-name rule, checked before spending a request on it. */
const senderIsValid = (sender) => {
  const value = String(sender ?? '').trim();
  if (!value) return false;
  return /^\d+$/.test(value) ? value.length <= SENDER_MAX_NUMERIC : value.length <= SENDER_MAX_ALPHA;
};

/**
 * One HTTP call, with a deadline.
 *
 * A provider that accepts the connection and then never answers would
 * otherwise hold a request open for as long as the socket survives — and this
 * is called from a notification path, behind somebody waiting for a page.
 */
const post = async (url, payload) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    return { httpStatus: res.status, text };
  } finally {
    clearTimeout(timer);
  }
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
  flash = false, dnd = false, reference = null,
} = {}) => {
  const fail = (status, message, extra = {}) => ({
    ok: false, status, message, sent: 0, cost: 0, recipients: [], skipped: [], ...extra,
  });

  if (!username) return fail('MISSING_USERNAME', STATUS.MISSING_USERNAME.message);
  if (!apikey) return fail('MISSING_APIKEY', STATUS.MISSING_APIKEY.message);
  if (!senderIsValid(sender)) return fail('INVALID_SENDER', STATUS.INVALID_SENDER.message);

  const text = String(body ?? '').trim();
  if (!text) return fail('MISSING_MESSAGE', STATUS.MISSING_MESSAGE.message);

  /*
   * Truncated rather than refused. A notification body is written for an email
   * and an in-app row, where length is free; silently dropping the whole
   * message because it ran past four pages would be the wrong trade for the
   * person waiting to be told something.
   */
  const messagetext = text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX - 1)}…` : text;

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
    response = await post(`${BASE_URL}/sendsms.json`, payload);
  } catch (error) {
    // Network, DNS or the deadline above. Retryable by nature: nothing about
    // the request was wrong.
    return fail('UNREACHABLE', `Could not reach eBulkSMS: ${error.message}`, { retryable: true, recipients, skipped });
  }

  let parsed = null;
  try { parsed = JSON.parse(response.text); } catch { /* handled below */ }

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
const checkCredentials = async ({ username, apikey } = {}) => {
  if (!username || !apikey) {
    return { ok: false, message: 'Enter both the eBulkSMS username and API key.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    /*
     * The username is an email and goes in a PATH segment, so '@' is left as
     * itself: RFC 3986 lists it among the characters a path segment may carry
     * unescaped, and percent-encoding it to %40 relies on the provider
     * decoding before it compares — which, if it does not, reads as
     * AUTH_FAILURE against a key that is perfectly good. Anything genuinely
     * structural ('/', '?', '#', a space) is still escaped, because those
     * would change which endpoint is being called.
     */
    const segment = (value) => encodeURIComponent(value).replace(/%40/g, '@');
    const url = `${BASE_URL}/balance/${segment(username)}/${segment(apikey)}`;
    const res = await fetch(url, { signal: controller.signal });
    const text = (await res.text()).trim();

    /*
     * The balance endpoint answers in plain text. A number means the
     * credentials were accepted; anything else is the provider's own error
     * string, which is more use to an administrator than "invalid".
     */
    const units = Number(String(text).replace(/[^\d.]/g, ''));
    if (res.ok && text && Number.isFinite(units) && /\d/.test(text)) {
      return { ok: true, units, message: `Credentials accepted. ${units} unit(s) available.` };
    }
    return { ok: false, message: text ? `eBulkSMS said: ${text.slice(0, 120)}` : 'eBulkSMS rejected the credentials.' };
  } catch (error) {
    return { ok: false, message: `Could not reach eBulkSMS: ${error.message}` };
  } finally {
    clearTimeout(timer);
  }
};

module.exports = {
  sendSms, checkCredentials, toInternational, senderIsValid,
  BASE_URL, MESSAGE_MAX, SENDER_MAX_ALPHA, SENDER_MAX_NUMERIC, STATUS,
};

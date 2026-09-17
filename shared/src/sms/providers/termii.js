const { toInternational, senderIsValid, request, fitMessage } = require('../phone');

/**
 * Termii, from https://developers.termii.com/messaging-api
 *
 *   POST {base}/api/sms/send
 *   { api_key, to, from, sms, type: 'plain', channel: 'generic' | 'dnd' }
 *   → { code: 'ok', balance, message_id, message: 'Successfully Sent' }
 *
 *   GET {base}/api/get-balance?api_key=…
 *   → { application, balance, currency, user }
 *
 * ── The base URL is a credential, not a constant ───────────────────────────
 *
 * Termii assigns each account its own base URL and says so in their own
 * documentation: it routes the request to the right regulatory region.
 * api.ng.termii.com is the Nigerian one and the default here, but a company
 * whose dashboard shows something else must be able to say so — hardcoding it
 * would work for most accounts and fail inexplicably for the rest.
 *
 * ── channel, and why the default is `dnd` ──────────────────────────────────
 *
 * Termii splits routes into `generic` (promotional) and `dnd` (transactional).
 * Everything this application sends is transactional — a payment approved, an
 * inspection confirmed — and a promotional route will not reach a number on
 * the Do-Not-Disturb register, which in Nigeria is most of them. Defaulting to
 * generic would look like it worked and quietly not arrive.
 */
const DEFAULT_BASE_URL = process.env.TERMII_BASE_URL || 'https://api.ng.termii.com';

/** Termii's sender IDs are 3–11 alphanumeric characters. */
const SENDER_MAX_ALPHA = 11;
const SENDER_MAX_NUMERIC = 14;
const SENDER_MIN = 3;
const MESSAGE_MAX = 918;

const sendSms = async ({
  apikey, sender, to, body, dnd = true, baseUrl = null, channel = null,
  // Accepted and ignored: the facade passes a reference to every provider, and
  // Termii documents no field for a caller-supplied one. It returns its own
  // message_id instead, which is what a delivery report would be matched on.
  reference: _reference = null,
} = {}) => {
  const fail = (status, message, extra = {}) => ({
    ok: false, status, message, sent: 0, cost: 0, recipients: [], skipped: [], ...extra,
  });

  if (!apikey) return fail('MISSING_APIKEY', 'No Termii API key is configured.');
  const from = String(sender ?? '').trim();
  if (!senderIsValid(from, { alpha: SENDER_MAX_ALPHA, numeric: SENDER_MAX_NUMERIC }) || from.length < SENDER_MIN) {
    return fail('INVALID_SENDER', 'A Termii sender ID is 3 to 11 characters.');
  }

  const text = fitMessage(body, MESSAGE_MAX);
  if (!text) return fail('MISSING_MESSAGE', 'The message was empty.');

  const wanted = (Array.isArray(to) ? to : [to]).filter(Boolean);
  const recipients = [];
  const skipped = [];
  wanted.forEach((raw) => {
    const number = toInternational(raw);
    if (number) recipients.push(number); else skipped.push(String(raw));
  });
  if (!recipients.length) return fail('INVALID_RECIPIENT', 'The phone number was not accepted.', { skipped });

  const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  /*
   * One number posts to /sms/send; several post to /sms/send/bulk, which is
   * what Termii documents for an array. Sending an array to the single
   * endpoint is accepted by some accounts and not others.
   */
  const bulk = recipients.length > 1;
  const payload = {
    api_key: apikey,
    to: bulk ? recipients : recipients[0],
    from,
    sms: text,
    type: 'plain',
    channel: channel || (dnd ? 'dnd' : 'generic'),
  };

  let response;
  try {
    response = await request(`${base}/api/sms/send${bulk ? '/bulk' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return fail('UNREACHABLE', `Could not reach Termii: ${error.message}`, { retryable: true, recipients, skipped });
  }

  const data = response.json;
  if (!data) {
    return fail('UNPARSEABLE',
      `Termii returned an unexpected response (HTTP ${response.httpStatus}): ${String(response.text || '').slice(0, 120)}`,
      { retryable: true, recipients, skipped });
  }

  /*
   * Success is `code: 'ok'`. Everything else carries a `message` written for a
   * person, so it is passed through rather than replaced with a guess —
   * Termii's failures are specific ("Insufficient balance", "Sender ID not
   * found") and more useful than anything this file could invent.
   */
  if (String(data.code).toLowerCase() === 'ok') {
    return {
      ok: true,
      status: 'SUCCESS',
      message: data.message || 'Sent.',
      sent: recipients.length,
      // Termii reports the balance REMAINING, not the cost of this message.
      cost: 0,
      balance: Number(data.balance) || null,
      messageId: data.message_id || data.message_id_str || null,
      recipients,
      skipped,
    };
  }

  const message = String(data.message || data.error || 'Termii rejected the message.');
  return fail(String(data.code || 'ERROR').toUpperCase(), message, {
    retryable: /balance|insufficient|timeout|unavailable/i.test(message),
    recipients,
    skipped,
  });
};

const checkCredentials = async ({ apikey, baseUrl = null } = {}) => {
  if (!apikey) return { ok: false, message: 'Enter the Termii API key.' };
  const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  try {
    const res = await request(`${base}/api/get-balance?api_key=${encodeURIComponent(apikey)}`);
    const data = res.json;
    if (res.ok && data && data.balance !== undefined) {
      return {
        ok: true,
        units: Number(data.balance),
        message: `Credentials accepted. ${data.balance} ${data.currency || ''} on ${data.user || 'the account'}.`.trim(),
      };
    }
    return {
      ok: false,
      message: data?.message
        ? `Termii said: ${String(data.message).slice(0, 120)}`
        : `Termii rejected the key (HTTP ${res.httpStatus}).`,
    };
  } catch (error) {
    return { ok: false, message: `Could not reach Termii: ${error.message}` };
  }
};

const FIELDS = [
  { key: 'api_key', label: 'API key', secret: true, required: true, hint: 'From your Termii dashboard' },
  { key: 'sender', label: 'Sender ID', required: true, hint: '3 to 11 characters, registered with Termii' },
  {
    key: 'base_url',
    label: 'Base URL',
    required: false,
    placeholder: DEFAULT_BASE_URL,
    // Said here because it is the one field an administrator will not expect.
    hint: 'Termii gives each account its own base URL — check your dashboard. Leave blank for Nigeria.',
  },
];

module.exports = {
  key: 'termii',
  label: 'Termii',
  docs: 'https://developers.termii.com/messaging-api',
  FIELDS,
  sendSms,
  checkCredentials,
  MESSAGE_MAX,
  SENDER_MAX_ALPHA,
  SENDER_MAX_NUMERIC,
};

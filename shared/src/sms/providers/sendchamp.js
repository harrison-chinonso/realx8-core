const { toInternational, senderIsValid, request, fitMessage } = require('../phone');

/**
 * Sendchamp, from https://sendchamp.readme.io/reference/send-sms-api
 *
 *   POST https://api.sendchamp.com/api/v1/sms/send
 *   Authorization: Bearer <public/secret key>
 *   { to: ['2348134844186'], message, sender_name, route: 'dnd' }
 *   → { code: 200, status: 'success', message, data: { id, reference, status } }
 *   → { code: 400, status: 'failed', errors, message }
 *
 * ── `to` is an array even for one number ───────────────────────────────────
 *
 * Their schema says so explicitly, and a bare string is the kind of thing that
 * works in a sandbox and fails in production. It is always sent as an array
 * here, whatever the caller passed.
 *
 * ── route defaults to `dnd` ────────────────────────────────────────────────
 *
 * Everything this application sends is transactional. `non_dnd` will not reach
 * a number on the Do-Not-Disturb register, which in Nigeria is most of them —
 * it would look like it worked and quietly not arrive.
 *
 * ── Why the response is read twice ─────────────────────────────────────────
 *
 * Sendchamp answers HTTP 200 with `status: 'failed'` for some rejections, so
 * the HTTP code alone is not the answer. The body's own `status` is.
 */
const DEFAULT_BASE_URL = process.env.SENDCHAMP_BASE_URL || 'https://api.sendchamp.com';

const SENDER_MAX_ALPHA = 11;
const SENDER_MAX_NUMERIC = 14;
const MESSAGE_MAX = 918;
const ROUTES = ['dnd', 'non_dnd', 'international'];

const sendSms = async ({
  apikey, sender, to, body, dnd = true, route = null, baseUrl = null,
  // Accepted and ignored — see the note in termii.js. Sendchamp returns its
  // own `data.reference`, which is the one that matters to them.
  reference: _reference = null,
} = {}) => {
  const fail = (status, message, extra = {}) => ({
    ok: false, status, message, sent: 0, cost: 0, recipients: [], skipped: [], ...extra,
  });

  if (!apikey) return fail('MISSING_APIKEY', 'No Sendchamp API key is configured.');
  const senderName = String(sender ?? '').trim();
  if (!senderIsValid(senderName, { alpha: SENDER_MAX_ALPHA, numeric: SENDER_MAX_NUMERIC })) {
    return fail('INVALID_SENDER', 'A Sendchamp sender name is at most 11 letters, or 14 digits.');
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

  const chosen = ROUTES.includes(String(route)) ? String(route) : (dnd ? 'dnd' : 'non_dnd');
  const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');

  let response;
  try {
    response = await request(`${base}/api/v1/sms/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apikey}`,
      },
      // Always an array, even for one — see the note above.
      body: JSON.stringify({ to: recipients, message: text, sender_name: senderName, route: chosen }),
    });
  } catch (error) {
    return fail('UNREACHABLE', `Could not reach Sendchamp: ${error.message}`, { retryable: true, recipients, skipped });
  }

  const data = response.json;
  if (!data) {
    return fail('UNPARSEABLE',
      `Sendchamp returned an unexpected response (HTTP ${response.httpStatus}): ${String(response.text || '').slice(0, 120)}`,
      { retryable: true, recipients, skipped });
  }

  // The body's own status, not the HTTP code — see the note above.
  if (String(data.status).toLowerCase() === 'success') {
    return {
      ok: true,
      status: 'SUCCESS',
      message: data.message || 'Sent.',
      sent: recipients.length,
      cost: 0,
      messageId: data.data?.reference || data.data?.id || null,
      recipients,
      skipped,
    };
  }

  /*
   * `errors` is sometimes a string and sometimes an object of field errors.
   * Flattened rather than JSON.stringify'd, because an administrator reading
   * {"message":["required"]} has to decode it before they can act.
   */
  const errors = data.errors && typeof data.errors === 'object'
    ? Object.entries(data.errors).map(([field, why]) => `${field}: ${[].concat(why).join(', ')}`).join('; ')
    : data.errors;
  const message = String(errors || data.message || 'Sendchamp rejected the message.');

  return fail(String(data.code || response.httpStatus || 'ERROR'), message, {
    retryable: /balance|insufficient|timeout|unavailable|try again/i.test(message),
    recipients,
    skipped,
  });
};

/**
 * Sendchamp documents no balance endpoint, so the credential check is the
 * cheapest authenticated call that is NOT a send: a deliberately invalid
 * request. An accepted key answers with a validation complaint; a bad one
 * answers 401 or 403, and those two are distinguishable without spending a
 * unit or ringing a phone.
 */
const checkCredentials = async ({ apikey, baseUrl = null } = {}) => {
  if (!apikey) return { ok: false, message: 'Enter the Sendchamp API key.' };
  const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  try {
    const res = await request(`${base}/api/v1/sms/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apikey}`,
      },
      // No recipients and no message: this cannot send anything even if the
      // key is good, which is the point.
      body: JSON.stringify({}),
    });

    if (res.httpStatus === 401 || res.httpStatus === 403) {
      return { ok: false, message: 'Sendchamp rejected the API key.' };
    }
    if (res.httpStatus >= 500) {
      return { ok: false, message: `Sendchamp is unavailable (HTTP ${res.httpStatus}).` };
    }
    /*
     * Anything else means the key got far enough to be told the REQUEST was
     * wrong, which is what we wanted to learn. Said plainly, because "valid"
     * here is a weaker statement than eBulkSMS's balance check.
     */
    return {
      ok: true,
      message: 'The API key was accepted. Sendchamp publishes no balance endpoint, '
        + 'so send a test message to confirm your sender name is approved.',
    };
  } catch (error) {
    return { ok: false, message: `Could not reach Sendchamp: ${error.message}` };
  }
};

const FIELDS = [
  { key: 'api_key', label: 'API key', secret: true, required: true, hint: 'Your Sendchamp public or secret key' },
  { key: 'sender', label: 'Sender name', required: true, hint: 'Must be approved in your Sendchamp dashboard' },
  {
    key: 'route',
    label: 'Route',
    required: false,
    options: ROUTES,
    placeholder: 'dnd',
    hint: 'dnd reaches numbers on the Do-Not-Disturb register — usually what you want for alerts.',
  },
];

module.exports = {
  key: 'sendchamp',
  label: 'Sendchamp',
  docs: 'https://sendchamp.readme.io/reference/send-sms-api',
  FIELDS,
  sendSms,
  checkCredentials,
  MESSAGE_MAX,
  ROUTES,
};

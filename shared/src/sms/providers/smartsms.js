const { toInternational, senderIsValid, request, fitMessage } = require('../phone');

/**
 * SmartSMSSolutions (API-x).
 *
 *   POST {base}   form-encoded
 *   token, sender, to, message, type=0, routing=3
 *   balance: token, checkbalance=1
 *
 * ── This one is documented least well, and the code reflects that ──────────
 *
 * Their current documentation host was unreachable while this was written, so
 * the contract here comes from their published integration packages: the
 * parameter names and the `type`/`routing` values are taken from
 * github.com/abdulmatinsanni/api-x, and the numeric error codes from
 * github.com/jcobhams/SmartSMSSolutions-API.
 *
 * The consequence is deliberate tolerance rather than a guess dressed up as
 * certainty. The response is parsed THREE ways — JSON, their pipe-delimited
 * `code||detail`, and a bare numeric code — because all three are attested in
 * different versions of their API and picking one would work until it did
 * not. An unrecognised shape reports what actually came back rather than
 * claiming success.
 *
 * Verify against a live account before relying on this in production; the
 * other three providers were checked against their own published contracts.
 */
const DEFAULT_BASE_URL = process.env.SMARTSMS_BASE_URL
  || 'https://app.smartsmssolutions.com/io/api/client/v1/sms/';

const SENDER_MAX_ALPHA = 11;
const SENDER_MAX_NUMERIC = 14;
const MESSAGE_MAX = 918;

/** Their numeric codes, from the published wrapper's error map. */
const CODES = {
  1000: { ok: true, message: 'Sent.' },
  2904: { message: 'SmartSMS could not send the message.', retryable: true },
  2905: { message: 'SmartSMS rejected the API token.' },
  2906: { message: 'The SmartSMS account is out of credit.', retryable: true },
  2907: { message: 'The SmartSMS gateway is unavailable.', retryable: true },
  2908: { message: 'The schedule date was not in a format SmartSMS accepts.' },
  2909: { message: 'SmartSMS could not schedule the message.' },
  2910: { message: 'No SmartSMS username was given.' },
  2911: { message: 'No SmartSMS password was given.' },
  2912: { message: 'No recipient was given.' },
  2913: { message: 'The message was empty.' },
  2914: { message: 'No sender name was given.' },
  2915: { message: 'A required field was missing.' },
  2916: { message: 'That sender name is not allowed on this SmartSMS account.' },
};

/**
 * Whatever SmartSMS answered, as { code, detail }.
 *
 * Three shapes, all attested — see the note at the top of this file.
 */
const readResponse = (response) => {
  const data = response.json;
  if (data && typeof data === 'object') {
    const code = Number(data.code ?? data.status ?? NaN);
    return {
      code: Number.isFinite(code) ? code : null,
      detail: data.simple_message || data.message || data.comment || null,
      successful: data.successful ?? null,
    };
  }

  const text = String(response.text || '').trim();
  if (text.includes('||')) {
    const [code, ...rest] = text.split('||');
    return { code: Number(code), detail: rest.join('||') || null, successful: null };
  }
  const bare = Number(text);
  if (Number.isFinite(bare) && text !== '') return { code: bare, detail: null, successful: null };
  return { code: null, detail: text.slice(0, 120) || null, successful: null };
};

const form = (fields) => new URLSearchParams(
  Object.entries(fields).filter(([, value]) => value !== undefined && value !== null),
).toString();

const sendSms = async ({
  apikey, sender, to, body, dnd = true, baseUrl = null, reference = null,
} = {}) => {
  const fail = (status, message, extra = {}) => ({
    ok: false, status, message, sent: 0, cost: 0, recipients: [], skipped: [], ...extra,
  });

  if (!apikey) return fail('MISSING_APIKEY', 'No SmartSMS API token is configured.');
  const from = String(sender ?? '').trim();
  if (!senderIsValid(from, { alpha: SENDER_MAX_ALPHA, numeric: SENDER_MAX_NUMERIC })) {
    return fail('INVALID_SENDER', 'A SmartSMS sender name is at most 11 letters, or 14 digits.');
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

  let response;
  try {
    response = await request((baseUrl || DEFAULT_BASE_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        token: apikey,
        sender: from,
        // Comma-separated, which is what their wrapper sends for several.
        to: recipients.join(','),
        message: text,
        // 0 is a plain text message; routing 3 is the DND-capable route, which
        // is what a transactional alert needs to arrive in Nigeria at all.
        type: 0,
        routing: dnd ? 3 : 2,
        ref_id: reference || undefined,
      }),
    });
  } catch (error) {
    return fail('UNREACHABLE', `Could not reach SmartSMS: ${error.message}`, { retryable: true, recipients, skipped });
  }

  const { code, detail, successful } = readResponse(response);
  const known = code === null ? null : CODES[code];

  if (known?.ok || String(successful).toLowerCase() === 'true') {
    return {
      ok: true,
      status: 'SUCCESS',
      message: detail || 'Sent.',
      sent: Number(successful) || recipients.length,
      cost: 0,
      recipients,
      skipped,
    };
  }

  if (known) {
    return fail(String(code), detail ? `${known.message} (${detail})` : known.message, {
      retryable: Boolean(known.retryable), recipients, skipped,
    });
  }

  /*
   * An unrecognised shape reports what came back rather than claiming
   * anything. Given how thin the published documentation is, an honest
   * "SmartSMS said X" is worth more than a confident mapping that is wrong.
   */
  return fail('UNPARSEABLE',
    `SmartSMS returned something unrecognised (HTTP ${response.httpStatus}): `
    + `${detail || String(response.text || '').slice(0, 120)}`,
    { retryable: true, recipients, skipped });
};

const checkCredentials = async ({ apikey, baseUrl = null } = {}) => {
  if (!apikey) return { ok: false, message: 'Enter the SmartSMS API token.' };
  try {
    const res = await request((baseUrl || DEFAULT_BASE_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ token: apikey, checkbalance: 1 }),
    });
    const { code, detail } = readResponse(res);

    // A balance query answers with the balance, not a status code.
    const units = Number(String(detail ?? res.text ?? '').replace(/[^\d.]/g, ''));
    if (code && CODES[code] && !CODES[code].ok) {
      return { ok: false, message: CODES[code].message };
    }
    if (Number.isFinite(units) && /\d/.test(String(detail ?? res.text ?? ''))) {
      return { ok: true, units, message: `Credentials accepted. ${units} unit(s) available.` };
    }
    return { ok: false, message: `SmartSMS said: ${String(res.text || '').slice(0, 120) || 'nothing'}` };
  } catch (error) {
    return { ok: false, message: `Could not reach SmartSMS: ${error.message}` };
  }
};

const FIELDS = [
  { key: 'api_key', label: 'API token', secret: true, required: true, hint: 'From Developer Tools → API Tokens' },
  { key: 'sender', label: 'Sender name', required: true, hint: 'Must be approved on your SmartSMS account' },
  {
    key: 'base_url',
    label: 'API URL',
    required: false,
    placeholder: DEFAULT_BASE_URL,
    hint: 'Leave blank unless SmartSMS have given you a different one.',
  },
];

module.exports = {
  key: 'smartsms',
  label: 'SmartSMS Solutions',
  docs: 'https://docs.smartsmssolutions.com/',
  FIELDS,
  sendSms,
  checkCredentials,
  MESSAGE_MAX,
  CODES,
};

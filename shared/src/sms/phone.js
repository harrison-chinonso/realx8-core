/**
 * A mobile number in the international format every provider wants.
 *
 * Extracted from the eBulkSMS client when a second provider arrived: all four
 * want 2348031234567 and none of them accept 08031234567, so normalising in
 * one place is what stops "the number is wrong" being reported for a number
 * that is fine and only typed differently.
 *
 * Returns null for anything that cannot be made into one, so a caller can say
 * so rather than paying to send into nowhere.
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

/** The provider's own sender-name rule: letters are shorter than digits. */
const senderIsValid = (sender, { alpha = 11, numeric = 14 } = {}) => {
  const value = String(sender ?? '').trim();
  if (!value) return false;
  return /^\d+$/.test(value) ? value.length <= numeric : value.length <= alpha;
};

/**
 * One HTTP call with a deadline, shared by every provider.
 *
 * A provider that accepts the connection and never answers would otherwise
 * hold a request open for as long as the socket survives — and these are
 * called from a notification path, behind somebody waiting for a page.
 */
const TIMEOUT_MS = Number(process.env.SMS_TIMEOUT_MS || process.env.EBULKSMS_TIMEOUT_MS || 15000);

const request = async (url, { method = 'GET', headers = {}, body = null } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not every provider answers JSON */ }
    return { httpStatus: res.status, ok: res.ok, text, json };
  } finally {
    clearTimeout(timer);
  }
};

/** The message truncated to what a provider will take, with a visible ellipsis. */
const fitMessage = (body, max) => {
  const text = String(body ?? '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

module.exports = { toInternational, senderIsValid, request, fitMessage, TIMEOUT_MS };

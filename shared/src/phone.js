/**
 * Comparing phone numbers that were never stored consistently.
 *
 * The same person's number appears in this database as "08138601115",
 * "0814 543 9255 " (spaces and a trailing space) and "234". Login matched the
 * phone column with `=`, so anyone whose row carried a stray space could never
 * sign in with it, and nobody could sign in with the +234 form of a number
 * stored in the 0-prefixed form.
 *
 * So numbers are compared by their SIGNIFICANT DIGITS rather than their text.
 */

/** Digits only. "0814 543 9255 " -> "08145439255". */
const digitsOf = (value) => String(value ?? '').replace(/\D+/g, '');

/**
 * The last `length` digits — the national significant number.
 *
 * Comparing on the tail is what makes the three ways of writing one Nigerian
 * mobile equivalent:
 *
 *   08138601115      -> 8138601115
 *   +2348138601115   -> 8138601115
 *   8138601115       -> 8138601115
 *
 * Ten digits because that is the significant length for the numbering plans in
 * use here; a shorter tail would start colliding between unrelated numbers.
 */
const significantDigits = (value, length = 10) => {
  const digits = digitsOf(value);
  return digits.length <= length ? digits : digits.slice(-length);
};

/**
 * Is this plausibly a phone number rather than an email or a typo?
 *
 * Guards the lookup: "234" is in the data as somebody's phone, and treating a
 * 3-digit string as a login identifier would match it against the tail of every
 * number ending in 234.
 */
const isPlausiblePhone = (value) => digitsOf(value).length >= 7;

/**
 * The canonical form to STORE.
 *
 * Trims and collapses to digits, keeping a leading + when one was given, so new
 * rows are consistent even though the historic ones are not.
 */
const normalisePhone = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const digits = digitsOf(raw);
  if (!digits) return null;
  return raw.startsWith('+') ? `+${digits}` : digits;
};

/**
 * A SQL fragment comparing a phone column by significant digits.
 *
 * REGEXP_REPLACE strips the punctuation the column accumulated; RIGHT takes the
 * significant tail. Unindexed by necessity — the column holds text that has to
 * be cleaned before it can be compared — which is acceptable on a per-login
 * lookup over a user table, and is why it is guarded by isPlausiblePhone.
 */
const phoneMatchSql = (column = 'phone', bind = ':phoneDigits') => (
  `RIGHT(REGEXP_REPLACE(COALESCE(${column}, ''), '[^0-9]', ''), 10) = RIGHT(${bind}, 10)`
  + ` AND LENGTH(REGEXP_REPLACE(COALESCE(${column}, ''), '[^0-9]', '')) >= 7`
);

module.exports = { digitsOf, significantDigits, isPlausiblePhone, normalisePhone, phoneMatchSql };

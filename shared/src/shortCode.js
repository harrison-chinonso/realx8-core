const crypto = require('crypto');

/**
 * The alphabet every share code in this application is drawn from.
 *
 * No 0/O and no 1/I/L. These codes get read aloud down a phone, written on the
 * back of a card and retyped from a photograph, and those are the pairs people
 * get wrong. Thirty characters over seven positions is about 2x10^10 codes,
 * which is far more than this will ever need and long enough that guessing one
 * at random is not a way to find a live link.
 *
 * It lives here rather than in the controller that first needed it because a
 * SECOND kind of link now uses it — a shared property — and the two must draw
 * from one namespace. They are stored in one table and resolved by one lookup,
 * so an alphabet that drifted between them would mean a code that is valid to
 * mint and impossible to resolve.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 7;

const randomCode = () => Array.from(crypto.randomBytes(CODE_LENGTH))
  .map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length])
  .join('');

/**
 * Anything this short and from this alphabet is a code, not a sealed token.
 *
 * Deliberately loose on the alphabet — it accepts 0/O/1/I so that a code
 * someone mistyped reaches the resolver and gets a "this link is not valid"
 * answer, rather than being mistaken for a legacy sealed token and failing
 * with a different message for the same mistake.
 */
const looksLikeShortCode = (value) => typeof value === 'string'
  && value.length <= 12
  && /^[0-9A-Z]+$/i.test(value);

/** Codes are stored and compared upper-cased: they get retyped by hand. */
const normalizeCode = (value) => String(value || '').trim().toUpperCase();

module.exports = { CODE_ALPHABET, CODE_LENGTH, randomCode, looksLikeShortCode, normalizeCode };

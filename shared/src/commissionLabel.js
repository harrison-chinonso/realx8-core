/**
 * What a commission says it is FOR: the buyer, and what they bought.
 *
 * ── Why a deal reference was not enough ─────────────────────────────────────
 *
 * Commission lines identified themselves by `INV-412`, or by "Commission —
 * Favour City Epe". Neither answers the question a realtor actually has, which
 * is not "which invoice" but "which of my clients, on which property". An
 * invoice number is a key; it is meaningful to the system and to nobody else,
 * and a realtor with four sales on the same estate cannot tell their lines
 * apart by it at all.
 *
 * "Kelvin — Favour City Epe" is readable across a table at a glance, sorts
 * sensibly, and is the same phrase the realtor would use out loud.
 *
 * ── One builder, because it appears in four places ──────────────────────────
 *
 * The stored title on a flat-rate commission, the realtor's statement, the
 * administrator's approval queue, and the payout advice. Composed separately
 * in each, they would drift — and two screens naming the same commission
 * differently is the kind of thing that makes somebody doubt both.
 */

/** Everything between words, collapsed, so a ragged name does not widen a column. */
const tidy = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/**
 * Cut to `max`, on a word boundary where there is one nearby.
 *
 * Breaking mid-word ("Favour Cit…") reads as corruption; breaking at the last
 * space before the limit reads as an abbreviation. The boundary is only used
 * when it is within a third of the limit, because a very long first word would
 * otherwise cut the string to almost nothing.
 */
const clip = (value, max) => {
  const text = tidy(value);
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.66 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

/**
 * The property as a person would name it.
 *
 * The city is appended only when the name does not already carry it — most do
 * here ("Favour City Epe"), and "Favour City Epe, Epe" is the sort of detail
 * that makes a screen look automated.
 */
const placeOf = ({ propertyName, city }) => {
  const name = tidy(propertyName);
  const where = tidy(city);
  if (!name) return where;
  if (!where) return name;
  return new RegExp(`\\b${where.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(name)
    ? name
    : `${name}, ${where}`;
};

/**
 * Build the label.
 *
 * @param {object} parts
 *   clientName    the buyer
 *   propertyName  what they bought
 *   city          appended when the name does not already say it
 *   fallback      used when neither party is known — the deal or invoice ref,
 *                 which is still better than an empty cell
 *   max           total length; the default suits a table column
 *
 * ── What gets shortened first ───────────────────────────────────────────────
 *
 * The property, then the client. The buyer's name is what distinguishes one of
 * a realtor's lines from another — two sales on the same estate differ only
 * there — so it is the last thing to lose characters, and it keeps at least
 * enough to stay recognisable.
 */
const commissionLabel = ({
  clientName, propertyName, city, fallback = null, max = 48,
} = {}) => {
  const client = tidy(clientName);
  const place = placeOf({ propertyName, city });

  if (!client && !place) return tidy(fallback) || '—';
  if (!client) return clip(place, max);
  if (!place) return clip(client, max);

  const separator = ' — ';
  const full = `${client}${separator}${place}`;
  if (full.length <= max) return full;

  // Give the client its name and whatever is left to the place, never letting
  // either fall below something a person can still read.
  const room = max - separator.length;
  const forClient = Math.min(client.length, Math.max(Math.ceil(room * 0.4), 12));
  const forPlace = room - forClient;

  return `${clip(client, forClient)}${separator}${clip(place, Math.max(forPlace, 10))}`;
};

module.exports = { commissionLabel, clip, placeOf };

const { toMinor } = require('../money');

/**
 * One CSV pipeline, used by everything that reads a spreadsheet (ACC-6.1, ACC-9.1).
 *
 * ── Why one and not three ───────────────────────────────────────────────────
 *
 * A bank statement, a chart of accounts, a set of opening balances and a list
 * of open invoices are the same problem wearing four hats: somebody exported a
 * file from a system that names its columns differently, and it has to be read
 * without guessing. The PRD is explicit that we build ONE import and reuse it,
 * because three imports means three places to fix the day a bank puts its
 * amounts in two columns instead of one.
 *
 * What differs between them is column names and vocabulary. What does not is
 * splitting the file, matching the header, reading an amount, collecting every
 * problem rather than the first, and refusing to commit half of anything.
 *
 * ── Every import is a dry run first ─────────────────────────────────────────
 *
 * Nobody imports correctly the first time. A half-committed import is worse
 * than a refused one — it leaves a company deciding which rows went in — so
 * the shape below always produces a preview that can be looked at before
 * anything is written.
 */

/**
 * A CSV line, split on commas but respecting quotes.
 *
 * Hand-written rather than pulled in, because the alternative is a dependency
 * for one function and this format is fixed: an accountant's export, comma
 * separated, occasionally quoted where a field contains a comma. Anything
 * stranger than that is a file somebody should look at rather than a file we
 * should guess at.
 */
const splitLine = (line) => {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cell += '"'; i += 1; } else { quoted = !quoted; }
    } else if (ch === ',' && !quoted) {
      cells.push(cell); cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
};

/** The header row and the data rows, with blank lines dropped. */
const readRows = (text) => {
  const rows = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (rows.length < 2) return { header: [], rows: [] };
  return { header: splitLine(rows[0]), rows: rows.slice(1).map(splitLine) };
};

/**
 * Which column index holds each thing, given the spellings we know.
 *
 * Returns a plain object of field → index or null. Null is not an error here:
 * what is REQUIRED differs per import, so the caller decides which absences
 * matter and says so in its own words.
 */
/**
 * A column heading reduced to the word it actually is.
 *
 * Banks decorate: "Amount (NGN)", "Debit (₦)", "Withdrawals  ", "Value Date*".
 * Matching those literally would need an alias per bank per decoration, so the
 * decoration is stripped instead — anything bracketed, any currency symbol,
 * any trailing punctuation — leaving "amount", "debit", "withdrawals",
 * "value_date".
 */
const normaliseHeading = (name) => String(name ?? '')
  .toLowerCase()
  .replace(/\([^)]*\)/g, ' ')
  .replace(/[₦$£€*:.#]/g, ' ')
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '');

/**
 * Which column holds each thing.
 *
 * ── Exact matches everywhere first, then the loose pass ─────────────────────
 *
 * The two passes are separated, rather than each field trying exact-then-loose
 * in turn, because a column already claimed EXACTLY by one field must not be
 * grabbed loosely by another. "Value Date" is exactly a date column; it also
 * contains "value", which is an amount alias — so a per-field loop had the
 * amount and the date reading the same column, and a statement's amounts came
 * out as dates.
 *
 * A column can therefore be claimed once. Exact wins; among loose matches,
 * whichever field is declared first wins, which is why the alias object lists
 * the specific fields before the general ones.
 */
const mapHeader = (header, aliases, pinned = {}) => {
  const lower = header.map(normaliseHeading);
  const claimed = new Set();
  const found = {};

  /*
   * What somebody has actually SAID, before anything is guessed.
   *
   * ── Why a person's answer has to beat the aliases outright ────────────────
   *
   * The passes below claim each column once, which is right for guessing: two
   * fields cannot both be the column called "Amount". But it is wrong for an
   * answer. On a statement headed Trans Date, Narration, Inflow, Outflow, the
   * narration column is where the reference lives too — and somebody choosing
   * it for BOTH is describing their file correctly. Left to the passes,
   * description claimed it first and the reference came back empty, so the
   * screen asked a question it had already been given the answer to.
   *
   * A pinned column is therefore not claimed exclusively, and is matched on
   * the heading itself rather than on an alias. It stays available to a field
   * whose alias matches that heading EXACTLY — "Narration" is still the
   * narration after being pinned as the reference — but not to the loose pass
   * below, which would otherwise wander into it.
   */
  const pinnedAt = new Set();
  Object.entries(pinned).forEach(([key, column]) => {
    if (!column || !aliases[key]) return;
    const index = lower.indexOf(normaliseHeading(column));
    // Not found means the file no longer has that column — a bank renamed it.
    // Falling through to the guesses is better than pinning it to nothing.
    if (index !== -1) { found[key] = index; pinnedAt.add(index); }
  });

  Object.entries(aliases).forEach(([key, names]) => {
    if (found[key] !== undefined) return;
    const index = lower.findIndex(
      (name, at) => !claimed.has(at) && names.includes(name),
    );
    if (index !== -1) { found[key] = index; claimed.add(index); }
  });

  /*
   * Then containment, on what is left: "transaction_amount_ngn" is an amount
   * column and no reasonable list of aliases covers every bank's phrasing.
   * A pinned column is off limits to it — a guess this loose has no business
   * landing on a column somebody has already spoken for.
   */
  pinnedAt.forEach((index) => claimed.add(index));
  Object.entries(aliases).forEach(([key, names]) => {
    if (found[key] !== undefined) return;
    const index = lower.findIndex((name, at) => !claimed.has(at) && name && names.some(
      (candidate) => candidate.length >= 3 && name.includes(candidate),
    ));
    if (index !== -1) { found[key] = index; claimed.add(index); }
  });

  return Object.fromEntries(
    Object.keys(aliases).map((key) => [key, found[key] ?? null]),
  );
};

/**
 * The decoration a bank puts around a number, removed.
 *
 * ── What real statements actually contain ───────────────────────────────────
 *
 * Almost never a bare "250000.00". In the wild: "NGN 250,000.00",
 * "N250,000.00", "250,000.00 CR", "250,000.00Dr", "(250,000.00)",
 * "250,000.00-", "1 500 000.00" with non-breaking spaces, and a lone dash
 * where the column is nil. A parser that accepts only digits and commas
 * rejects every one of them — and then reports "the amount could not be read"
 * once per row, which says nothing about which part it could not read.
 *
 * @returns {{ digits, negative, marker }} — marker is 'CR', 'DR' or null.
 */
const stripDecoration = (raw) => {
  let text = String(raw ?? '').trim();
  if (!text) return { digits: '', negative: false, marker: null, blank: true };

  /*
   * A lone dash is how a statement writes "nothing in this column". Every
   * dash character is included, because a PDF turns a hyphen into an en dash
   * as often as not.
   */
  if (/^[-\u2010-\u2015\u2212]+$/.test(text)) {
    return { digits: '', negative: false, marker: null, blank: true };
  }

  let negative = false;
  let marker = null;

  // "250,000.00 CR" / "DR250,000.00" — which side of the account it moved.
  const markerMatch = text.match(/\b(CR|DR)\b/i) || text.match(/(CR|DR)$/i);
  if (markerMatch) {
    marker = markerMatch[1].toUpperCase();
    text = text.replace(/\b(CR|DR)\b/ig, ' ').replace(/(CR|DR)$/i, ' ');
  }

  if (/^\(.*\)$/.test(text.trim())) { negative = true; text = text.trim().slice(1, -1); }

  // Currency, by symbol, by ISO code, and by the bare N Nigerian banks print.
  text = text
    .replace(/\b(NGN|USD|GBP|EUR|ZAR|GHS|KES)\b/ig, ' ')
    .replace(/[₦$£€]/g, ' ')
    .replace(/(^|\s)N(?=[\d.,])/g, ' ');

  text = text.trim();
  // A minus either side, ASCII or the Unicode one a PDF is fond of.
  if (/^[-\u2212]/.test(text)) { negative = true; text = text.slice(1); }
  if (/[-\u2212]$/.test(text)) { negative = true; text = text.slice(0, -1); }

  // Separators: commas, apostrophes, and every kind of space.
  const digits = text.replace(/[,'\s\u00a0\u202f]/g, '');
  return { digits, negative, marker, blank: digits === '' };
};

/**
 * A positive amount from a spreadsheet cell.
 *
 * Parentheses are NOT read as a negative — in a two-column debit/credit layout
 * a bracketed figure is ambiguous, and guessing at the sign of somebody's
 * journal is the one thing this must never do. It refuses instead, and the
 * caller reports the row.
 */
const parseAmount = (raw) => {
  const text = String(raw ?? '').trim();
  if (/[()]/.test(text)) return null;
  const { digits, negative, blank } = stripDecoration(raw);
  if (blank) return 0;
  if (negative) return null;
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isFinite(value) ? toMinor(value) : null;
};

/**
 * An amount that may legitimately be negative — a bank statement line.
 *
 * ── Where the bracket rule flips, and why ───────────────────────────────────
 *
 * A bank statement has ONE amount column and money goes both ways, so a
 * bracketed figure is not ambiguous there: every bank that prints brackets
 * means a withdrawal by them, and there is no second column it could have
 * belonged to instead. Refusing it would reject most Nigerian bank exports.
 *
 * A trailing minus — "1,200.00-" — and a trailing "DR" are the other two
 * spellings, and all three mean the same thing.
 */
const parseSignedAmount = (raw) => {
  const {
    digits, negative, marker, blank,
  } = stripDecoration(raw);
  if (blank) return 0;
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  // DR is money leaving the account; CR is money arriving.
  const out = negative || marker === 'DR';
  return out ? -toMinor(value) : toMinor(value);
};

/**
 * A cell that is a label rather than a figure.
 *
 * ── Why a statement contains rows that are not transactions ─────────────────
 *
 * Almost every bank opens its statement with a balance brought forward, and
 * plenty close with a carried-forward line or a page total. Those rows carry a
 * word where the amount belongs — "B/F", "BALANCE C/F", "TOTAL" — and they are
 * not movements: importing them invents a transaction, and refusing the whole
 * file because of them rejects a statement that is perfectly good. Two rows
 * out of a hundred failing with "an amount could not be read" is almost always
 * this.
 *
 * They are recognised, left out, and REPORTED, which is the part that makes it
 * safe: the screen says which rows were passed over and what was in them,
 * rather than quietly importing a shorter statement than the one handed over.
 *
 * A cell carrying digits is never a marker, whatever words sit beside them.
 * "B/F 1,500,000" has a figure in it, and a figure is the one thing that must
 * not be dropped on the strength of the words around it.
 */
const NON_MOVEMENT = [
  'bf', 'cf', 'bbf', 'bcf', 'bd', 'cd', 'balbf', 'balcf', 'balancebf', 'balancecf',
  'broughtforward', 'carriedforward', 'broughtdown', 'carrieddown',
  'balancebroughtforward', 'balancecarriedforward',
  'balbroughtforward', 'balcarriedforward',
  'openingbalance', 'closingbalance', 'balance', 'opening', 'closing',
  'total', 'totals', 'subtotal', 'grandtotal',
  'nil', 'na', 'none', 'null', 'void',
];

const isNonMovement = (raw) => {
  const text = String(raw ?? '').trim();
  // Blank is not a marker; it is simply the other column's turn.
  if (!text) return false;
  /*
   * Only these words, and only a row of stars standing in for a masked
   * figure. An earlier version counted ANY cell without letters or digits —
   * so a stray ":" or "!" from a narration that had bled into the amount
   * column made the row "not a transaction", and four real payments were
   * quietly left out of an import on the strength of a punctuation mark. A
   * row that cannot be read must be reported, not passed over: the only rows
   * worth passing over are the ones that SAY what they are.
   */
  if (/^\*+$/.test(text)) return true;
  if (/\d/.test(text)) return false;
  return NON_MOVEMENT.includes(text.toLowerCase().replace(/[^a-z]/g, ''));
};

/**
 * The transaction reference, pulled out of a narration.
 *
 * ── Why this is a SUGGESTION and never an answer ────────────────────────────
 *
 * Plenty of statements — most Nigerian ones — have no reference column at all.
 * The reference is inside the narration, in front of the words describing the
 * payment: "110059260803172345612201921111 3LINE FINANCE EXPENSE OKOTA".
 *
 * Asking somebody to copy those out into a spreadsheet column is not a fix
 * when the file is a PDF, so this makes the best reading it can — and then the
 * screen shows every one of them beside its narration for a person to correct
 * before anything is imported. That is the whole safeguard: the guess is never
 * used unless somebody has looked at it. A reference invented in silence is
 * worse than none, because it matches something.
 *
 * The readings, in the order they are tried:
 *   1. a labelled one — "REF: 88213", "RRN 0091234"
 *   2. a long run of digits — the NIP session id a transfer carries
 *   3. a coded one — INV-9, POS/8811, COT-8
 *   4. anything else with letters and digits in it, long enough to be an id
 */
const REFERENCE_PATTERNS = [
  /\b(?:ref|rrn|reference|txn|trans(?:action)?\s*(?:id|no|ref)?)\b[:\s#-]*([A-Za-z0-9][A-Za-z0-9/-]{3,})/i,
  /\b(\d{10,})\b/,
  /\b([A-Z]{2,6}[-/]\d{3,}(?:[-/]\d+)?)\b/,
  /\b([A-Za-z]*\d[A-Za-z0-9]{5,})\b/,
];

const referenceFrom = (text) => {
  const narration = String(text ?? '').trim();
  if (!narration) return null;
  for (let i = 0; i < REFERENCE_PATTERNS.length; i += 1) {
    const found = narration.match(REFERENCE_PATTERNS[i]);
    if (found && found[1]) return found[1].replace(/[.,;:]+$/, '');
  }
  return null;
};

/**
 * Which way a transaction went, from a column that says so.
 *
 * ── The third shape a statement comes in ────────────────────────────────────
 *
 * Two columns — money in and money out — is one. A single signed column is
 * another. The third is a single amount column beside a separate column
 * holding CR or DR, and it is common enough that ignoring it means reading
 * those statements as if every line were the same direction.
 *
 * Every spelling seen in the wild is accepted, because this is exactly the
 * field a bank feels free to label however it likes: CR, Cr, C, CREDIT,
 * INFLOW, DEPOSIT, +, and their opposites.
 */
const parseDirection = (raw) => {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return null;
  if (/^(cr|c|credit|inflow|in|deposit|lodgement|received|\+)$/.test(text)) return 'in';
  if (/^(dr|d|debit|outflow|out|withdrawal|withdrawn|paid|payment|-)$/.test(text)) return 'out';
  // A longer phrase — "Credit Transfer", "Debit Adjustment" — reads by prefix.
  if (/^cr|^credit|^inflow|^deposit/.test(text)) return 'in';
  if (/^dr|^debit|^outflow|^withdraw/.test(text)) return 'out';
  return null;
};

/**
 * A date from a spreadsheet cell, as ISO.
 *
 * ── The one genuinely dangerous field ───────────────────────────────────────
 *
 * 03/04/2026 is the third of April to a Nigerian bank and the fourth of March
 * to an American one, and both are plausible dates. Guessing silently puts
 * transactions in the wrong month, which survives every reconciliation until
 * a period close finds it a quarter later.
 *
 * So: an unambiguous ISO date is read; a slash-separated date is read as
 * day-first, which is the convention everywhere this system operates; and a
 * date whose first part is above 12 confirms the reading rather than changing
 * it. What is NOT done is inferring the format from whichever rows happen to
 * be unambiguous, because a file can be consistent and still be read the
 * wrong way round when every day in it is below the thirteenth.
 *
 * `dayFirst: false` is offered for an export that is known to be American,
 * and the caller is expected to have asked somebody rather than assumed.
 */
const parseDate = (raw, { dayFirst = true } = {}) => {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const parts = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (parts) {
    let [, first, second, year] = parts;
    if (year.length === 2) year = `20${year}`;
    // A first part above 12 can only be a day, whichever convention was meant.
    const dayIsFirst = Number(first) > 12 ? true : (Number(second) > 12 ? false : dayFirst);
    const day = dayIsFirst ? first : second;
    const month = dayIsFirst ? second : first;
    if (Number(month) < 1 || Number(month) > 12) return null;
    if (Number(day) < 1 || Number(day) > 31) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  /*
   * "12 Mar 2026" and friends. Date.parse is safe on the AMBIGUITY here,
   * because the month is named — but not on the timezone.
   *
   * Date.parse reads a bare date as LOCAL midnight, and toISOString then
   * converts to UTC. Anywhere east of Greenwich that lands on the previous
   * day: "12 Mar 2026" arrives as 2026-03-11 in Lagos. A statement line dated
   * one day early crosses a month boundary once a month, every month, and
   * lands in a period that may already be closed.
   *
   * So the parts are read back out in LOCAL terms and reassembled, which is
   * what the file meant: a date with no time and no zone is a calendar date.
   */
  if (/[a-z]/i.test(text)) {
    const parsed = new Date(text);
    if (Number.isFinite(parsed.getTime())) {
      return [
        parsed.getFullYear(),
        String(parsed.getMonth() + 1).padStart(2, '0'),
        String(parsed.getDate()).padStart(2, '0'),
      ].join('-');
    }
  }
  return null;
};

/**
 * Read a file into records, collecting every problem.
 *
 * @param text       the CSV
 * @param aliases    field → the spellings that mean it
 * @param options.required  fields whose absence refuses the file outright
 * @param options.row       (cells, at, rowNumber) => record | { error } | null
 *
 * Errors are COLLECTED rather than thrown on the first one. Somebody fixing a
 * four-hundred-row file needs every problem at once; returning the first and
 * making them upload again to find the second is how an import becomes a
 * thing people avoid using.
 */
const readFile = (text, aliases, { required = [], row: readRow, pinned = {} } = {}) => {
  const { header, rows } = readRows(text);
  if (!rows.length) {
    return { records: [], errors: ['The file has no rows beneath its header.'], header, mapping: {} };
  }

  const at = mapHeader(header, aliases, pinned);

  const missing = required.filter((field) => at[field] === null || at[field] === undefined);
  if (missing.length) {
    return {
      records: [],
      header,
      mapping: at,
      errors: missing.map((field) => (
        `No ${field.replace(/_/g, ' ')} column — expected one named ${aliases[field].join(', ')}.`
      )),
    };
  }

  const records = [];
  const errors = [];
  rows.forEach((cells, index) => {
    const rowNumber = index + 2; // 1-indexed, plus the header
    const result = readRow(cells, at, rowNumber);
    if (!result) return;
    if (result.error) { errors.push(`Row ${rowNumber}: ${result.error}`); return; }
    records.push({ ...result, row_number: rowNumber });
  });

  return { records, errors, header, mapping: at };
};

/**
 * Whether a date could honestly be read two ways.
 *
 * ── Why this exists rather than a setting somebody always has to answer ─────
 *
 * Only an all-numeric date with both leading parts at twelve or below is
 * ambiguous: 03/08/2026 is the third of August or the eighth of March and
 * nothing in the file says which. "03 Aug 2026" — which is what Stanbic and
 * several others print — says which. So does an ISO date, and so does 25/04,
 * where a day above twelve settles it.
 *
 * Asking about the format regardless makes a reader answer a question about
 * their file that their file has already answered, in wording that describes
 * neither of the formats in front of them. Asking only when it MATTERS means
 * the question, when it appears, is worth reading.
 */
const isAmbiguousDate = (raw) => {
  const text = String(raw ?? '').trim();
  if (!text) return false;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return false;
  if (/[a-z]/i.test(text)) return false;

  const parts = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (!parts) return false;
  return Number(parts[1]) <= 12 && Number(parts[2]) <= 12;
};

module.exports = {
  isAmbiguousDate,
  normaliseHeading,
  stripDecoration,
  parseDirection,
  isNonMovement,
  referenceFrom,
  splitLine,
  readRows,
  mapHeader,
  parseAmount,
  parseSignedAmount,
  parseDate,
  readFile,
};

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
const mapHeader = (header, aliases) => {
  const lower = header.map((name) => String(name).toLowerCase().replace(/\s+/g, '_'));
  const find = (names) => {
    const index = lower.findIndex((name) => names.includes(name));
    return index === -1 ? null : index;
  };
  return Object.fromEntries(
    Object.entries(aliases).map(([key, names]) => [key, find(names)]),
  );
};

/**
 * A positive amount from a spreadsheet cell.
 *
 * Handles the three things an export actually contains: thousands separators,
 * a currency symbol, and a blank meaning zero. Parentheses are NOT read as a
 * negative — in a two-column debit/credit layout a bracketed figure is
 * ambiguous, and guessing at the sign of somebody's journal is the one thing
 * this must never do. It refuses instead, and the caller reports the row.
 */
const parseAmount = (raw) => {
  const text = String(raw ?? '').trim();
  if (!text) return 0;
  if (/[()]/.test(text)) return null;
  const cleaned = text.replace(/[₦$£€,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return toMinor(value);
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
 * A trailing minus — "1,200.00-" — is the other spelling, and it means the
 * same thing.
 */
const parseSignedAmount = (raw) => {
  let text = String(raw ?? '').trim();
  if (!text) return 0;

  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  if (/-$/.test(text)) { negative = true; text = text.slice(0, -1); }
  if (/^-/.test(text)) { negative = true; text = text.slice(1); }

  const cleaned = text.replace(/[₦$£€,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return negative ? -toMinor(value) : toMinor(value);
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
const readFile = (text, aliases, { required = [], row: readRow } = {}) => {
  const { header, rows } = readRows(text);
  if (!rows.length) {
    return { records: [], errors: ['The file has no rows beneath its header.'], header, mapping: {} };
  }

  const at = mapHeader(header, aliases);

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

module.exports = {
  splitLine,
  readRows,
  mapHeader,
  parseAmount,
  parseSignedAmount,
  parseDate,
  readFile,
};

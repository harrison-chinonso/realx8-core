const { asMinor } = require('../money');
const { splitLine, mapHeader, parseAmount } = require('./csvImport');

/**
 * Reading a journal out of a CSV (ACC-4.6).
 *
 * ── Why this is three days of work rather than two quarters ─────────────────
 *
 * Book of record means the accounts cannot simply omit payroll or
 * depreciation — accounts that are missing a module are not accounts. Building
 * payroll and fixed assets properly is two quarters. A payroll bureau already
 * produces a monthly journal summary and an externally-kept depreciation
 * schedule already produces one, and both of them are a list of accounts with
 * debits and credits.
 *
 * So this is the honest answer to the completeness obligation: the books can
 * be complete before the modules exist, by importing what somebody else
 * already calculated. It is not a shortcut around building them — it is what
 * keeps a tenant filing from this system while they are being built.
 *
 * ── Parsed here, posted by the same door as a manual journal ────────────────
 *
 * Nothing in this file writes anything. It turns text into the shape
 * `ledger.post` already takes, which means the balance rule, the idempotency
 * key and the append-only guarantee apply to an imported journal exactly as
 * they do to one somebody typed — there is no second, laxer path into the
 * ledger.
 */

/** Columns we understand, and the spellings a spreadsheet is likely to use. */
const COLUMNS = {
  account: ['account', 'account_code', 'code', 'gl', 'gl_code'],
  debit: ['debit', 'dr', 'debit_amount'],
  credit: ['credit', 'cr', 'credit_amount'],
  date: ['date', 'entry_date', 'transaction_date'],
  memo: ['memo', 'description', 'narrative', 'details'],
  reference: ['reference', 'ref', 'source'],
};

/**
 * Turn CSV text into lines a journal can be posted from.
 *
 * @returns {{ lines, errors, debit_minor, credit_minor, balanced, date, memo }}
 *
 * Errors are COLLECTED rather than thrown on the first one. Somebody fixing a
 * four-hundred-row payroll journal needs every problem at once; returning the
 * first and making them re-upload to find the second is how an import becomes
 * a thing people avoid using.
 */
const parseJournalCsv = (text, { defaultDate = null } = {}) => {
  const rows = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (rows.length < 2) {
    return {
      lines: [], errors: ['The file has no rows beneath its header.'], balanced: false,
    };
  }

  const header = splitLine(rows[0]);
  const at = mapHeader(header, COLUMNS);

  const errors = [];
  if (at.account === null) errors.push('No account column — expected one named account, account_code or code.');
  if (at.debit === null && at.credit === null) {
    errors.push('No debit or credit column — expected columns named debit and credit.');
  }
  if (errors.length) return { lines: [], errors, balanced: false };

  const lines = [];
  let date = defaultDate;
  let memo = null;

  rows.slice(1).forEach((row, index) => {
    const cells = splitLine(row);
    const rowNumber = index + 2; // 1-indexed, plus the header

    const code = at.account === null ? '' : String(cells[at.account] ?? '').trim();
    if (!code) { errors.push(`Row ${rowNumber}: no account.`); return; }

    const debit = at.debit === null ? 0 : parseAmount(cells[at.debit]);
    const credit = at.credit === null ? 0 : parseAmount(cells[at.credit]);
    if (debit === null || credit === null) {
      errors.push(`Row ${rowNumber}: an amount could not be read. Use plain numbers; a bracketed figure is ambiguous.`);
      return;
    }
    if (debit > 0 && credit > 0) {
      errors.push(`Row ${rowNumber}: a line is a debit or a credit, never both.`);
      return;
    }
    if (debit === 0 && credit === 0) return; // a blank line is not an error

    if (!date && at.date !== null && cells[at.date]) date = String(cells[at.date]).trim();
    if (!memo && at.memo !== null && cells[at.memo]) memo = String(cells[at.memo]).trim();

    lines.push({
      code,
      debit_minor: debit,
      credit_minor: credit,
      memo: at.memo === null ? null : (String(cells[at.memo] ?? '').trim() || null),
    });
  });

  const debits = lines.reduce((total, line) => total + asMinor(line.debit_minor), 0);
  const credits = lines.reduce((total, line) => total + asMinor(line.credit_minor), 0);

  if (lines.length && lines.length < 2) {
    errors.push('A journal needs at least two lines.');
  }
  if (lines.length >= 2 && debits !== credits) {
    errors.push(
      `The file does not balance: debits ${debits / 100}, credits ${credits / 100}, `
      + `difference ${Math.abs(debits - credits) / 100}.`,
    );
  }

  return {
    lines,
    errors,
    debit_minor: debits,
    credit_minor: credits,
    balanced: lines.length >= 2 && debits === credits,
    date,
    memo,
  };
};

/*
 * parseAmount and splitLine are re-exported rather than defined here: they
 * moved to csvImport.js so the bank statement and migration imports read a
 * file exactly the way this one does (ACC-6.1, ACC-9.1). Callers that already
 * import them from here keep working.
 */
module.exports = {
  parseJournalCsv, parseAmount, splitLine, COLUMNS,
};

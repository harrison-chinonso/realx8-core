const test = require('node:test');
const assert = require('node:assert/strict');

const {
  splitLine, readRows, mapHeader, parseAmount, parseSignedAmount, parseDate, readFile,
  parseDirection, isNonMovement, referenceFrom,
} = require('../../shared/src/accounting/csvImport');

/**
 * The one CSV pipeline (ACC-6.1, ACC-9.1).
 *
 * ── Where the money actually goes wrong ─────────────────────────────────────
 *
 * Not in the splitting. In the two fields where a file can be read
 * successfully and mean something different from what it says: an amount whose
 * sign is implied by formatting, and a date whose order is implied by the
 * country the software was written in. Both produce a clean import and wrong
 * books, which is why most of this file is about those two.
 */

test('a quoted field keeps its commas', () => {
  assert.deepEqual(
    splitLine('2026-03-01,"Transfer, part payment","50,000.00"'),
    ['2026-03-01', 'Transfer, part payment', '50,000.00'],
  );
});

test('a doubled quote is one quote', () => {
  assert.deepEqual(splitLine('a,"he said ""yes""",b'), ['a', 'he said "yes"', 'b']);
});

test('blank lines are not rows', () => {
  const { header, rows } = readRows('a,b\n\n1,2\n\n\n3,4\n');
  assert.deepEqual(header, ['a', 'b']);
  assert.equal(rows.length, 2);
});

test('a file with only a header has no rows', () => {
  assert.deepEqual(readRows('a,b').rows, []);
});

test('the header is matched case- and space-insensitively', () => {
  const at = mapHeader(['Value Date', 'NARRATION', 'Money In'], {
    date: ['date', 'value_date'],
    description: ['narration', 'description'],
    credit: ['money_in', 'credit'],
    debit: ['money_out', 'debit'],
  });
  assert.equal(at.date, 0);
  assert.equal(at.description, 1);
  assert.equal(at.credit, 2);
  assert.equal(at.debit, null); // absent is null, not an error
});

// ── Amounts ────────────────────────────────────────────────────────────────

test('thousands separators and a currency symbol are read', () => {
  assert.equal(parseAmount('₦1,234,567.89'), 123456789);
  assert.equal(parseAmount(' 1 000.50 '), 100050);
});

test('a blank amount is zero, not a failure', () => {
  assert.equal(parseAmount(''), 0);
  assert.equal(parseAmount(null), 0);
});

test('a bracketed amount in a TWO-column layout is refused as ambiguous', () => {
  /*
   * In a debit/credit layout a bracketed figure could be a negative debit or a
   * positive credit, and guessing at the sign of somebody's journal is the one
   * thing this must never do.
   */
  assert.equal(parseAmount('(1,200.00)'), null);
});

test('nonsense is refused rather than turned into a number', () => {
  assert.equal(parseAmount('n/a'), null);
  assert.equal(parseAmount('12.34.56'), null);
});

test('a bracketed amount in a ONE-column layout is money out', () => {
  /*
   * A bank statement has one amount column and money goes both ways, so a
   * bracket is not ambiguous there — there is no second column it could have
   * belonged to instead.
   */
  assert.equal(parseSignedAmount('(1,200.00)'), -120000);
  assert.equal(parseSignedAmount('1,200.00-'), -120000);
  assert.equal(parseSignedAmount('-1,200.00'), -120000);
  assert.equal(parseSignedAmount('1,200.00'), 120000);
});

// ── Dates ──────────────────────────────────────────────────────────────────

test('an ISO date is read as itself', () => {
  assert.equal(parseDate('2026-04-03'), '2026-04-03');
  assert.equal(parseDate('2026-04-03T10:00:00Z'), '2026-04-03');
});

test('a slash date is day-first by default', () => {
  // Which is the convention everywhere this system operates.
  assert.equal(parseDate('03/04/2026'), '2026-04-03');
});

test('...and month-first when the source is known to be American', () => {
  assert.equal(parseDate('03/04/2026', { dayFirst: false }), '2026-03-04');
});

test('a first part above twelve settles it whichever convention was meant', () => {
  assert.equal(parseDate('25/04/2026', { dayFirst: false }), '2026-04-25');
  assert.equal(parseDate('04/25/2026', { dayFirst: true }), '2026-04-25');
});

test('a two-digit year is this century', () => {
  assert.equal(parseDate('03/04/26'), '2026-04-03');
});

test('a named month is unambiguous and is read', () => {
  assert.equal(parseDate('12 Mar 2026'), '2026-03-12');
});

test('an impossible date is refused', () => {
  assert.equal(parseDate('45/13/2026'), null);
  assert.equal(parseDate('not a date'), null);
  assert.equal(parseDate(''), null);
});

// ── The reader ─────────────────────────────────────────────────────────────

const ALIASES = {
  date: ['date'],
  amount: ['amount'],
  memo: ['memo', 'description'],
};

test('a missing required column refuses the file and names what it wanted', () => {
  const result = readFile('memo,amount\nrent,100', ALIASES, {
    required: ['date'],
    row: () => ({}),
  });
  assert.equal(result.records.length, 0);
  assert.match(result.errors[0], /No date column/);
});

test('every problem is collected, not just the first', () => {
  const result = readFile(
    'date,amount\nbad,100\n2026-01-02,rubbish\nbad2,also rubbish',
    ALIASES,
    {
      required: ['date'],
      row: (cells, at) => {
        if (!parseDate(cells[at.date])) return { error: 'the date could not be read.' };
        if (parseAmount(cells[at.amount]) === null) return { error: 'the amount could not be read.' };
        return { ok: true };
      },
    },
  );
  /*
   * Somebody fixing a four-hundred-row file needs every problem at once.
   * Returning the first and making them upload again to find the second is how
   * an import becomes a thing people avoid using.
   */
  assert.equal(result.errors.length, 3);
  assert.equal(result.records.length, 0);
});

test('a row the reader skips is not an error', () => {
  const result = readFile('date,amount\n2026-01-01,0\n2026-01-02,100', ALIASES, {
    required: ['date'],
    row: (cells, at) => (parseAmount(cells[at.amount]) ? { kept: true } : null),
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.records.length, 1);
});

test('records carry the row number, so an error can be pointed at', () => {
  const result = readFile('date,amount\n2026-01-01,100', ALIASES, {
    required: ['date'],
    row: () => ({ ok: true }),
  });
  assert.equal(result.records[0].row_number, 2);
});

/* ── What somebody said, against what we would have guessed ──────────────── */

const STATEMENT = {
  date: ['date', 'trans_date'],
  description: ['description', 'narration'],
  reference: ['reference', 'ref'],
  debit: ['debit', 'outflow'],
  credit: ['credit', 'inflow'],
};

test('a pinned column wins over the field that would have claimed it', () => {
  const header = ['Trans Date', 'Narration', 'Inflow', 'Outflow'];
  const at = mapHeader(header, STATEMENT, { reference: 'Narration' });
  assert.equal(at.reference, 1);
  // ...and the narration is still the narration. The column holds both,
  // which is exactly the statement that made this necessary.
  assert.equal(at.description, 1);
});

test('a pinned column is not taken by the loose pass', () => {
  const header = ['Date', 'Transaction Reference Narration'];
  const at = mapHeader(header, STATEMENT, { description: 'Transaction Reference Narration' });
  assert.equal(at.description, 1);
  assert.equal(at.reference, null);
});

test('a pin at a column the file no longer has falls back to guessing', () => {
  const header = ['Trans Date', 'Narration', 'Inflow', 'Outflow'];
  const at = mapHeader(header, STATEMENT, { reference: 'Cheque No' });
  assert.equal(at.reference, null);
  assert.equal(at.description, 1);
});

test('a pin is matched however the heading is decorated', () => {
  const at = mapHeader(['Date', 'Amount (NGN)'], { date: ['date'], credit: ['credit'] }, { credit: 'Amount (NGN)' });
  assert.equal(at.credit, 1);
});

/* ── The column that says which way the money went ───────────────────────── */

test('CR and DR are read, in every spelling banks use', () => {
  ['CR', 'cr', 'Credit', 'C', 'Inflow', 'Deposit', '+'].forEach((word) => {
    assert.equal(parseDirection(word), 'in', word);
  });
  ['DR', 'dr', 'Debit', 'D', 'Outflow', 'Withdrawal', '-'].forEach((word) => {
    assert.equal(parseDirection(word), 'out', word);
  });
});

test('a direction cell that says neither is refused, not assumed', () => {
  // Assuming one of them is how a statement imports cleanly and backwards.
  [null, '', 'TRANSFER', '0', 'N/A'].forEach((word) => {
    assert.equal(parseDirection(word), null, String(word));
  });
});

/* ── The rows on a statement that are not transactions ───────────────────── */

test('a brought-forward or total marker is recognised, in the spellings banks use', () => {
  ['B/F', 'BALANCE B/F', 'Bal C/F', 'B/D', 'Balance Brought Forward', 'Opening Balance',
    'TOTAL', 'Sub-total', 'NIL', 'N/A', '***'].forEach((word) => {
    assert.equal(isNonMovement(word), true, word);
  });
});

test('punctuation from a narration does not make a row a non-transaction', () => {
  /*
   * The bug this replaced: any cell without letters or digits counted as a
   * marker, so a ":" or "!" that had bled out of a narration into the amount
   * column made the whole row "not a transaction" — and four real payments
   * were left out of an import without anybody being told why.
   */
  [':', '!', '.', ',', '-', '()', '/', '|'].forEach((mark) => {
    assert.equal(isNonMovement(mark), false, mark);
  });
});

test('anything carrying a figure is never a marker', () => {
  // The whole risk of skipping rows: a real movement dropped because of the
  // words printed beside it.
  ['B/F 1,500,000', '1,500,000.00', '0.00', '(250.00)', '250,000.00 CR'].forEach((word) => {
    assert.equal(isNonMovement(word), false, word);
  });
});

test('an empty cell is not a marker, and neither is a narration', () => {
  ['', '   ', null, undefined, 'TRF FRM KELVIN OBI', 'POS PURCHASE LEKKI'].forEach((word) => {
    assert.equal(isNonMovement(word), false, String(word));
  });
});

/* ── The reference, read out of a narration ──────────────────────────────── */

test('a transfer\'s session id is read out of the narration it opens', () => {
  assert.equal(
    referenceFrom('110059260803172345612201921111 3LINE FINANCE EXPENSE OKOTA 3lineltdPH12026'),
    '110059260803172345612201921111',
  );
  assert.equal(referenceFrom('NIP/TRF/091823110422/KELVIN OBI FOR RENT'), '091823110422');
});

test('a labelled reference wins over anything else on the line', () => {
  assert.equal(referenceFrom('REF: 88213 TRANSFER FROM ADA 0022412558'), '88213');
});

test('a coded reference is read where there is no long number', () => {
  assert.equal(referenceFrom('POS/8811/PURCHASE AT SHOPRITE LEKKI'), 'POS/8811');
});

test('a narration with nothing reference-shaped in it gives nothing', () => {
  // Better than a guess: the screen shows an empty box for a person to fill
  // or leave, rather than inventing something that will match a payment.
  [null, '', 'COMMISSION ON TURNOVER', 'ACCOUNT MAINTENANCE FEE'].forEach((text) => {
    assert.equal(referenceFrom(text), null, String(text));
  });
});

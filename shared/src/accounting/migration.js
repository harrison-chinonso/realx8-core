const { readFile, parseAmount, parseDate } = require('./csvImport');
const { TYPE } = require('./chart');

/**
 * Moving a company's books in (ACC-9).
 *
 * ── A launch requirement, not a later convenience ───────────────────────────
 *
 * Realx8 is the book of record. A company moving its statutory books here
 * arrives with balances and open items, and without somewhere to put them it
 * simply cannot start — so this is not tooling for an eventual migration
 * project, it is the front door.
 *
 * ── One import, four files ──────────────────────────────────────────────────
 *
 * The chart, the opening balances, the open invoices and the open bills. All
 * four are read by the same pipeline (csvImport.js), because every package on
 * the market exports CSV and what differs between them is column names and
 * vocabulary, not semantics.
 *
 * ── Historical transactions are NOT imported ────────────────────────────────
 *
 * A year of comparatives is entered as one summary journal per month. Say no
 * to this politely and often: importing three years of somebody else's
 * transaction history means importing three years of their data quality, and
 * every reconciliation afterwards is against figures nobody here can defend.
 *
 * ── Nothing here writes ─────────────────────────────────────────────────────
 *
 * Every function returns what WOULD happen. The dry run is not a mode, it is
 * the shape: nobody imports correctly the first time, and a half-committed
 * import is worse than a refused one because it leaves a company deciding
 * which rows went in.
 */

// ── ACC-9.2: the chart of accounts ──────────────────────────────────────────

const CHART_COLUMNS = {
  code: ['code', 'account_code', 'nominal', 'nominal_code', 'account_no', 'number', 'account'],
  name: ['name', 'account_name', 'description', 'title'],
  type: ['type', 'account_type', 'category', 'class'],
  parent: ['parent', 'parent_code', 'parent_account', 'group'],
};

/**
 * What each package calls the five types we have.
 *
 * ACC-9.6: vocabularies genuinely differ — QuickBooks says "Other Current
 * Asset", Sage classifies by nominal range, a spreadsheet says whatever the
 * bookkeeper typed. Unmatched types are REPORTED rather than guessed, because
 * an account classified wrongly puts a liability in the assets and a balance
 * sheet that balances while describing a different company.
 */
const TYPE_WORDS = {
  [TYPE.ASSET]: [
    'asset', 'assets', 'current asset', 'other current asset', 'fixed asset',
    'bank', 'cash', 'accounts receivable', 'stock', 'inventory', 'debtors',
  ],
  [TYPE.LIABILITY]: [
    'liability', 'liabilities', 'current liability', 'other current liability',
    'long term liability', 'accounts payable', 'creditors', 'loan',
  ],
  [TYPE.EQUITY]: ['equity', 'capital', 'capital and reserves', 'share capital', 'reserves'],
  [TYPE.INCOME]: ['income', 'revenue', 'sales', 'other income', 'turnover'],
  [TYPE.EXPENSE]: [
    'expense', 'expenses', 'cost of sales', 'cost of goods sold', 'cogs',
    'overhead', 'overheads', 'direct costs', 'administrative expenses',
  ],
};

/** Our type for a word the source used, or null where nobody can be sure. */
const typeFromWord = (word, extra = {}) => {
  const text = String(word || '').trim().toLowerCase();
  if (!text) return null;
  if (extra[text]) return extra[text];
  const hit = Object.entries(TYPE_WORDS)
    .find(([, words]) => words.includes(text));
  if (hit) return hit[0];
  /*
   * A last pass on CONTAINMENT, not equality: "Other Current Assets (Bank)"
   * is an asset by any reading. Deliberately after the exact match, so a
   * source that spells a type exactly is never second-guessed by a substring.
   */
  const loose = Object.entries(TYPE_WORDS)
    .find(([, words]) => words.some((candidate) => text.includes(candidate)));
  return loose ? loose[0] : null;
};

const parseChartCsv = (text, { typeMap = {} } = {}) => {
  const result = readFile(text, CHART_COLUMNS, {
    required: ['code', 'name'],
    row: (cells, at) => {
      const code = String(cells[at.code] ?? '').trim();
      const name = String(cells[at.name] ?? '').trim();
      if (!code) return { error: 'no account code.' };
      if (!name) return { error: `account ${code} has no name.` };

      const word = at.type === null ? '' : cells[at.type];
      return {
        code,
        name,
        source_type: String(word || '').trim() || null,
        type: typeFromWord(word, typeMap),
        parent_code: at.parent === null ? null : (String(cells[at.parent] ?? '').trim() || null),
      };
    },
  });

  const seen = new Map();
  result.records.forEach((row) => {
    if (seen.has(row.code)) {
      result.errors.push(`Row ${row.row_number}: account code ${row.code} appears more than once.`);
    }
    seen.set(row.code, row);
  });

  /*
   * Accounts whose type nobody can be sure of go to a screen, not to a guess.
   * They are not errors — the file is fine and the import can proceed once
   * somebody has classified them — so they are reported separately.
   */
  const unclassified = result.records.filter((row) => !row.type);

  return { ...result, unclassified };
};

// ── ACC-9.3: opening balances ───────────────────────────────────────────────

const BALANCE_COLUMNS = {
  code: ['code', 'account_code', 'nominal', 'nominal_code', 'account', 'account_no'],
  debit: ['debit', 'dr', 'debit_amount', 'debits'],
  credit: ['credit', 'cr', 'credit_amount', 'credits'],
  balance: ['balance', 'amount', 'closing_balance'],
  name: ['name', 'account_name', 'description'],
};

/**
 * Read a trial balance into the one journal it becomes.
 *
 * ── Why it posts as a single entry ──────────────────────────────────────────
 *
 * Because it IS one event: on this date, these were the balances. Posting one
 * journal per account would scatter a single fact across fifty entries with
 * nothing tying them together, and reversing a bad import would become fifty
 * reversals.
 *
 * ── And why it must balance ─────────────────────────────────────────────────
 *
 * A trial balance that does not balance is not a trial balance. Where the
 * source's own figures are out, the difference goes to SUSPENSE rather than
 * being silently absorbed into opening balance equity — that is what suspense
 * is for, and the period-close checklist will refuse to close a month while
 * anything sits in it, which is exactly the pressure that gets it corrected.
 */
const parseOpeningBalancesCsv = (text) => {
  const result = readFile(text, BALANCE_COLUMNS, {
    required: ['code'],
    row: (cells, at) => {
      const code = String(cells[at.code] ?? '').trim();
      if (!code) return { error: 'no account code.' };

      let debit = 0;
      let credit = 0;

      if (at.debit !== null || at.credit !== null) {
        debit = at.debit === null ? 0 : parseAmount(cells[at.debit]);
        credit = at.credit === null ? 0 : parseAmount(cells[at.credit]);
        if (debit === null || credit === null) {
          return { error: 'an amount could not be read. Use plain numbers; a bracketed figure is ambiguous in a two-column layout.' };
        }
      } else if (at.balance !== null) {
        /*
         * A single signed balance column. Here a negative IS unambiguous —
         * there is no second column it could have belonged to — so a minus
         * means the other side.
         */
        const raw = String(cells[at.balance] ?? '').trim();
        const negative = /^-/.test(raw) || /^\(.*\)$/.test(raw);
        const value = parseAmount(raw.replace(/^[-(]|\)$/g, ''));
        if (value === null) return { error: 'the balance could not be read.' };
        if (negative) credit = value; else debit = value;
      } else {
        return { error: 'there is no amount on this row.' };
      }

      if (debit > 0 && credit > 0) {
        return { error: 'a balance is a debit or a credit, never both.' };
      }
      if (!debit && !credit) return null; // an account with nothing on it

      return {
        code,
        name: at.name === null ? null : (String(cells[at.name] ?? '').trim() || null),
        debit_minor: debit,
        credit_minor: credit,
      };
    },
  });

  const debits = result.records.reduce((total, row) => total + row.debit_minor, 0);
  const credits = result.records.reduce((total, row) => total + row.credit_minor, 0);

  return {
    ...result,
    debit_minor: debits,
    credit_minor: credits,
    difference_minor: debits - credits,
    balanced: debits === credits,
  };
};

// ── ACC-9.4: open items ─────────────────────────────────────────────────────

const OPEN_ITEM_COLUMNS = {
  party: ['customer', 'client', 'supplier', 'vendor', 'name', 'account_name', 'party'],
  reference: ['document', 'document_no', 'invoice', 'invoice_no', 'reference', 'ref', 'number'],
  date: ['date', 'document_date', 'invoice_date', 'issued'],
  due_date: ['due_date', 'due', 'payment_due'],
  amount: ['amount', 'gross', 'total', 'invoice_amount', 'value'],
  paid: ['paid', 'amount_paid', 'received', 'settled', 'allocated'],
  outstanding: ['outstanding', 'balance', 'open_amount', 'remaining'],
};

/**
 * The file everybody forgets (ACC-9.4).
 *
 * ── Why a trial balance is not enough ───────────────────────────────────────
 *
 * It gives a receivables control TOTAL. It does not give the individual open
 * invoices behind it — who owes what, since when. Without them, aged
 * receivables is wrong from the first day, the control account never
 * reconciles to its subledger, and every check that leans on that agreement is
 * poisoned: the period-close checklist, the statements, the audit pack.
 *
 * A company that imports its trial balance and skips this file has a ledger
 * that balances and a receivables ledger that is empty, and will not find out
 * until somebody asks who owes the ₦40m.
 */
const parseOpenItemsCsv = (text, { dayFirst = true } = {}) => {
  const result = readFile(text, OPEN_ITEM_COLUMNS, {
    required: ['party', 'reference'],
    row: (cells, at) => {
      const party = String(cells[at.party] ?? '').trim();
      const reference = String(cells[at.reference] ?? '').trim();
      if (!party) return { error: 'no customer or supplier.' };
      if (!reference) return { error: 'no document number.' };

      /*
       * A column being ABSENT and a cell being UNREADABLE are different
       * problems, and the first version of this conflated them: an export
       * with no `paid` column was reported as having an unreadable amount.
       */
      const hasAmount = at.amount !== null;
      const hasOutstanding = at.outstanding !== null;
      if (!hasAmount && !hasOutstanding) {
        return { error: 'neither an amount nor an outstanding balance column.' };
      }

      const gross = hasAmount ? parseAmount(cells[at.amount]) : null;
      const paid = at.paid === null ? 0 : parseAmount(cells[at.paid]);
      const stated = hasOutstanding ? parseAmount(cells[at.outstanding]) : null;

      if ((hasAmount && gross === null)
        || paid === null
        || (hasOutstanding && stated === null)) {
        return { error: 'an amount could not be read.' };
      }

      /*
       * Where the file states BOTH a gross and an outstanding figure and they
       * disagree, the outstanding one wins — it is what the company is
       * actually chasing — but the disagreement is reported, because it
       * usually means a payment was recorded in one place and not the other.
       */
      const derived = gross === null ? null : gross - (paid || 0);
      const outstanding = stated === null ? derived : stated;

      return {
        party,
        reference,
        date: at.date === null ? null : parseDate(cells[at.date], { dayFirst }),
        due_date: at.due_date === null ? null : parseDate(cells[at.due_date], { dayFirst }),
        gross_minor: gross ?? outstanding,
        paid_minor: paid || 0,
        outstanding_minor: outstanding,
        disputed: derived !== null && stated !== null && derived !== stated,
      };
    },
  });

  const disagreements = result.records.filter((row) => row.disputed);
  disagreements.forEach((row) => {
    result.errors.push(
      `Row ${row.row_number}: ${row.reference} says it is owed ${row.outstanding_minor / 100} `
      + `but the amount less what was paid is ${(row.gross_minor - row.paid_minor) / 100}. `
      + 'Fix the file — a payment has probably been recorded in one place and not the other.',
    );
  });

  return {
    ...result,
    total_minor: result.records.reduce((total, row) => total + row.outstanding_minor, 0),
  };
};

module.exports = {
  CHART_COLUMNS,
  BALANCE_COLUMNS,
  OPEN_ITEM_COLUMNS,
  TYPE_WORDS,
  typeFromWord,
  parseChartCsv,
  parseOpeningBalancesCsv,
  parseOpenItemsCsv,
};

const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const {
  sequelize, BankStatementLine, BankReconciliation, ImportMapping, LedgerAccount,
} = require('../models');
const { buildCompanyScope, buildDefaultsScope } = require('../utils/crudFactory');
const {
  readFile, readRows, mapHeader,
  parseSignedAmount, parseDate, parseDirection, isAmbiguousDate, isNonMovement,
  referenceFrom,
} = require('../../../../shared/src/accounting/csvImport');
const { suggestFor, fingerprintOf } = require('../../../../shared/src/accounting/bankMatch');
const { post } = require('../../../../shared/src/accounting/ledger');
const { ROLE } = require('../../../../shared/src/accounting/chart');

/**
 * Agreeing with the bank (ACC-6).
 *
 * ── The feature that decides adoption ───────────────────────────────────────
 *
 * A finance team will forgive a general ledger a great deal, but not the
 * absence of a bank reconciliation — it is the one task they do every month
 * whatever else they are doing, and a system that cannot do it is a system
 * they keep a spreadsheet beside. It is also the check that catches the
 * platform's own mistakes: a payment recorded twice, a receipt for money that
 * never arrived, a transfer that failed after being marked paid.
 *
 * ── Imported, suggested, decided ────────────────────────────────────────────
 *
 * Three steps, deliberately separate. The import reads what the bank said and
 * stores it. Matching offers candidates and a person accepts them. Locking
 * says the two agreed on a date, and period close depends on that record.
 *
 * Nothing matches automatically. A wrong automatic match is invisible — the
 * reconciliation balances and the two transactions that were actually swapped
 * are never looked at again.
 */

const scope = (req) => buildCompanyScope(req);

const companyOf = (req) => (req.user?.isSuperiorAdmin
  ? (req.body?.company_id ?? req.query?.company_id ?? null)
  : (req.user?.company_id ?? null));

/** The columns a bank statement might use, and the spellings seen in the wild. */
const STATEMENT_COLUMNS = {
  date: ['date', 'transaction_date', 'value_date', 'trans_date', 'posting_date', 'txn_date'],
  description: ['description', 'narration', 'details', 'particulars', 'remarks', 'memo'],
  reference: ['reference', 'ref', 'transaction_reference', 'ref_no', 'cheque_no', 'instrument_no'],
  amount: ['amount', 'value', 'transaction_amount'],
  /*
   * Plenty of Nigerian banks export two columns rather than one signed
   * column. Both shapes are read, and the two-column form wins where present
   * — a file that has debit, credit AND amount is one where amount is usually
   * a running total somebody mislabelled.
   */
  debit: [
    'debit', 'withdrawal', 'withdrawals', 'money_out', 'dr',
    /* What the statement that started all this called it. */
    'outflow', 'out_flow', 'debit_amount', 'amount_out',
  ],
  credit: [
    'credit', 'deposit', 'deposits', 'lodgement', 'lodgment', 'money_in', 'cr',
    'inflow', 'in_flow', 'credit_amount', 'amount_in',
  ],
  balance: ['balance', 'running_balance', 'closing_balance', 'book_balance'],
  /*
   * The column that says CR or DR beside a single amount. Listed after debit
   * and credit so those claim their own columns first — "dr_cr" would
   * otherwise be grabbed by the `debit` aliases' containment pass.
   */
  direction: [
    'dr_cr', 'cr_dr', 'drcr', 'debit_credit', 'credit_debit',
    'direction', 'indicator', 'type', 'transaction_type', 'tran_type', 'txn_type',
  ],
};

/**
 * The three shapes a bank statement's amounts come in.
 *
 * ── Why this is chosen rather than inferred ─────────────────────────────────
 *
 * It used to be inferred: "if a debit or credit column is mapped, use the two
 * of them; otherwise use the amount column". That reads correctly right up
 * until somebody maps only ONE of the pair — which is exactly what happens
 * when a statement's columns are called Inflow and Outflow and the person
 * mapping them puts Inflow against "amount". The two-column branch then won
 * on the strength of Outflow alone, the Inflow column was never read, and
 * every row came out as money going out. The totals balanced and were
 * backwards.
 *
 * A shape somebody has chosen cannot do that, because there is no branch left
 * to guess at.
 */
const SHAPES = {
  /** Money in and money out in their own columns. */
  TWO_COLUMNS: 'two_columns',
  /** One column, the sign or a trailing DR inside it saying which way. */
  SIGNED: 'signed',
  /** One amount column, and a separate column holding CR or DR. */
  WITH_DIRECTION: 'with_direction',
};

/** What the file looks like it is, before anybody says otherwise. */
const inferShape = (at) => {
  if (at.amount !== null && at.direction !== null) return SHAPES.WITH_DIRECTION;
  if (at.debit !== null && at.credit !== null) return SHAPES.TWO_COLUMNS;
  if (at.amount !== null) return SHAPES.SIGNED;
  // One of the pair only: still two columns, and the other side is simply
  // absent — a statement of nothing but receipts is a real thing.
  if (at.debit !== null || at.credit !== null) return SHAPES.TWO_COLUMNS;
  return null;
};

/**
 * Whether the reference we would import is actually a reference.
 *
 * ── Why this is worth a question ────────────────────────────────────────────
 *
 * Plenty of statements have no reference column at all: the transaction's
 * reference is written INSIDE the narration, in front of or behind the words
 * describing it — "NIP/TRF/091823110422/JOHN OKE FOR RENT". Mapping that
 * column as the reference imports the whole sentence as the reference, and
 * that is not a harmless approximation. The reference is half of what decides
 * whether a statement line is the payment already in the books, and it is
 * part of the fingerprint that stops a re-downloaded statement importing
 * twice. A narration in that field quietly weakens both.
 *
 * Pulling the reference out of the sentence is not attempted. It would work
 * on the samples in front of us and invent references on every template we
 * have not seen — and a wrong reference is worse than none, because it
 * matches something.
 *
 * So the file is read, and where the reference is absent or looks like prose
 * the person is told which of the two it is and asked once. The answer is
 * kept against the bank like the column mapping is.
 */
const REFERENCE_CHOICES = [
  /** The column mapped as the reference holds the reference and nothing else. */
  'only',
  /** This statement has no reference; import the lines without one. */
  'none',
  /**
   * Take the reference out of the narration, show every one of them beside
   * its row, and use what comes back once a person has been through them.
   * The only one of the three that needs the screen to send anything.
   */
  'extract',
];

/** Several words, or long: a sentence rather than a reference. */
const looksLikeProse = (values) => {
  if (!values.length) return false;
  const wordy = values.filter((value) => {
    const text = String(value).trim();
    return text.split(/\s+/).length >= 4 || text.length > 28;
  }).length;
  return wordy >= Math.ceil(values.length / 2);
};

const referenceAdvice = (detected, header, sampleOf) => {
  if (detected.reference === null) return { state: 'absent', column: null, examples: [] };
  const column = header[detected.reference];
  const values = sampleOf('reference');
  const examples = [...new Set(values.map((value) => String(value).trim()))].slice(0, 3);
  // The same column answering both questions is the commonest form of this:
  // there is one text column and it has been pressed into service twice.
  if (detected.reference === detected.description) return { state: 'shared', column, examples };
  if (looksLikeProse(values)) return { state: 'mixed', column, examples };
  return { state: 'ok', column, examples };
};

/**
 * A line printed after the transactions rather than among them.
 *
 * A statement does not stop at its last payment: underneath come the totals,
 * the closing balance, "Generated on…", the page footer. Those lines have no
 * date on them, and refusing the whole file because of them — "Row 15: the
 * date could not be read", twice, about a statement whose fourteen
 * transactions were read perfectly — is not a useful answer.
 */
const SUMMARY_WORDS = /\b(total|totals|summary|closing balance|opening balance|balance b\/f|balance c\/f|end of statement|generated|printed|page \d|continued)\b/i;

const looksLikeSummary = (cells) => SUMMARY_WORDS.test(cells.join(' '));

/** The bank accounts in this company's chart. */
const bankAccounts = asyncHandler(async (req, res) => {
  const rows = await LedgerAccount.findAll({
    // One chart's bank accounts — see buildDefaultsScope.
    where: { ...buildDefaultsScope(req), is_active: true },
    order: [['code', 'ASC']],
  });
  /*
   * By role first, then by the cash-and-bank code range, so a company that
   * renumbered still finds its accounts and one that added a third bank
   * account without giving it a role still sees it.
   */
  const banks = rows.filter((row) => [ROLE.BANK, ROLE.CASH].includes(row.role)
    || /^10[0-3]/.test(String(row.code)));
  res.json({ data: banks });
});

/**
 * Read a statement, and say what would happen — or do it.
 *
 * `preview` is the default posture rather than an option somebody remembers:
 * a half-imported statement leaves a company deciding which lines went in,
 * which is worse than a refused one.
 */
const importStatement = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const accountId = Number(req.body.account_id);
  if (!accountId) return res.status(400).json({ message: 'Say which bank account this statement is for.' });

  const account = await LedgerAccount.findOne({ where: { id: accountId, ...scope(req) } });
  if (!account) return res.status(422).json({ message: 'Choose an account this company has.' });

  const csv = String(req.body.csv || '');
  if (!csv.trim()) return res.status(400).json({ message: 'There is no file to read.' });

  /*
   * A saved mapping tells us the source's own column names and — crucially —
   * whether it writes 03/04 as the third of April. That second answer cannot
   * be inferred from the file, and getting it wrong puts every transaction in
   * the wrong month.
   */
  let dayFirst = req.body.day_first === undefined ? true : Boolean(req.body.day_first);
  let mapping = null;
  if (req.body.source) {
    mapping = await ImportMapping.findOne({
      where: { kind: 'bank_statement', source: String(req.body.source), company_id: companyId },
    }) || await ImportMapping.findOne({
      where: { kind: 'bank_statement', source: String(req.body.source), company_id: null },
    });
    if (mapping) dayFirst = mapping.day_first;
  }

  const aliases = { ...STATEMENT_COLUMNS };

  /*
   * field → the heading in THIS file, where somebody has said which is which.
   *
   * Pinned rather than added to the aliases: an answer has to win outright,
   * including over the field that would otherwise have claimed that column.
   * See mapHeader — a narration column chosen as the reference as well is a
   * correct description of plenty of statements.
   */
  const pinned = {};
  const applyColumns = (columns) => {
    Object.entries(columns || {}).forEach(([field, column]) => {
      // Anything beginning __ is stored alongside the columns — the shape,
      // the reference answer — and is not itself a column.
      if (!column || field.startsWith('__')) return;
      pinned[field] = column;
    });
  };

  // The saved spelling for this bank...
  applyColumns(mapping?.columns);
  /* The shape is stored beside them rather than in its own column. */
  if (mapping?.columns?.__shape && req.body.shape === undefined) {
    req.body.shape = mapping.columns.__shape;
  }
  /*
   * ...and then whatever the person has just said on screen, which wins.
   *
   * This is the answer to a statement whose columns we have never seen —
   * "Outflow" and "Inflow" rather than debit and credit. Guessing harder
   * would eventually mismatch something; asking costs two clicks, once per
   * bank, and is then remembered.
   */
  applyColumns(req.body.columns)

  /*
   * Dates that could honestly be read two ways, counted as the file is read.
   *
   * Only an all-numeric date with both leading parts at twelve or below is
   * ambiguous. "03 Aug 2026", which is what Stanbic prints, is not — and nor
   * is 25/04. Reporting the count lets the screen ask about the format ONLY
   * when the answer changes something, instead of asking everybody every time
   * in wording that describes neither of the formats in front of them.
   */
  /*
   * What the file's columns are, and which of ours they answer.
   *
   * Worked out ONCE, before any row is read, and handed back to the screen
   * whatever happens. A file whose headings we do not recognise is not a
   * broken file — it is a file we have not been told about yet, and the
   * screen can ask rather than refuse. Reading the rows first produced "there
   * is no amount on this row" once per row: thirteen identical lines saying
   * nothing about the actual problem.
   */
  const { header } = readRows(csv);
  const detected = mapHeader(header, aliases, pinned);
  const columnFor = (field) => (detected[field] === null ? null : header[detected[field]]);

  const resolved = Object.fromEntries(
    Object.keys(STATEMENT_COLUMNS).map((field) => [field, columnFor(field)]),
  );

  /*
   * The shape somebody chose, or the one the file looks like. Explicit wins,
   * and the columns the chosen shape does not use are dropped — so a leftover
   * mapping from a previous shape cannot quietly change how the file is read.
   */
  const shape = Object.values(SHAPES).includes(req.body.shape)
    ? req.body.shape
    : inferShape(detected);

  if (shape === SHAPES.TWO_COLUMNS) { resolved.amount = null; resolved.direction = null; }
  if (shape === SHAPES.SIGNED) { resolved.debit = null; resolved.credit = null; resolved.direction = null; }
  if (shape === SHAPES.WITH_DIRECTION) { resolved.debit = null; resolved.credit = null; }

  /* What each shape cannot do without. */
  const needsAmount = {
    [SHAPES.TWO_COLUMNS]: detected.debit === null && detected.credit === null,
    [SHAPES.SIGNED]: detected.amount === null,
    [SHAPES.WITH_DIRECTION]: detected.amount === null,
  }[shape] ?? true;

  const missing = [
    detected.date === null ? 'date' : null,
    needsAmount ? 'amount' : null,
    shape === SHAPES.WITH_DIRECTION && detected.direction === null ? 'direction' : null,
  ].filter(Boolean);

  const columnReport = {
    header,
    columns: resolved,
    missing,
    shape,
    shapes: Object.values(SHAPES),
    needs_mapping: missing.length > 0,
  };

  /*
   * Does the column somebody gave us actually HOLD amounts?
   *
   * Mapping a column is only half the answer; the other half is whether the
   * values in it can be read. Mapping the narration as the amount by mistake
   * is easy, and without this check it produced "the amount could not be
   * read" once per row — thirteen identical lines that never said WHICH
   * column, or what was in it.
   *
   * Checked on a sample before any row is parsed, so the answer is one
   * message showing the column, the heading and the values it actually found.
   */
  const dataRows = readRows(csv).rows;
  const sampleOf = (field) => (detected[field] === null ? [] : dataRows
    .slice(0, 12)
    .map((cells) => cells[detected[field]])
    .filter((cell) => String(cell ?? '').trim() !== ''));

  /*
   * The same sample, without the rows that were never transactions.
   *
   * A statement whose debit column is blank down the page except for "B/F" on
   * the opening line would otherwise be judged a column that "does not hold
   * amounts" on the strength of its one non-empty cell — and the file refused
   * over the single row in it that was never a movement.
   */
  const figuresOf = (field) => sampleOf(field).filter((cell) => !isNonMovement(cell));

  /*
   * Is the reference a reference? See referenceAdvice — the answer decides
   * whether a question is asked before this statement can be imported.
   */
  const reference = referenceAdvice(detected, header, sampleOf);
  columnReport.reference_note = reference;
  const referenceChoice = REFERENCE_CHOICES.includes(req.body.reference_choice)
    ? req.body.reference_choice
    : (REFERENCE_CHOICES.includes(mapping?.columns?.__reference)
      ? mapping.columns.__reference
      : null);
  columnReport.reference_choice = referenceChoice;
  /*
   * row number → what a person put in the reference box for that row. Sent
   * back with the import; blank means "no reference on this row", which is a
   * legitimate answer and not a gap to fill in with the guess.
   */
  const corrections = (req.body.references && typeof req.body.references === 'object')
    ? req.body.references
    : {};

  const unreadable = [];
  const amountFields = {
    [SHAPES.TWO_COLUMNS]: ['debit', 'credit'],
    [SHAPES.SIGNED]: ['amount'],
    [SHAPES.WITH_DIRECTION]: ['amount'],
  }[shape] || [];
  amountFields.forEach((field) => {
    if (detected[field] === null) return;
    const values = figuresOf(field);
    if (!values.length) return;
    const readable = values.filter((value) => parseSignedAmount(value) !== null).length;
    // Most of them, not all: a stray "BALANCE B/F" row is normal.
    if (readable < Math.ceil(values.length / 2)) {
      unreadable.push({
        field,
        column: header[detected[field]],
        examples: [...new Set(values.map((value) => String(value).trim()))].slice(0, 4),
      });
    }
  });

  if (unreadable.length && !missing.length) {
    const first = unreadable[0];
    const message = `The "${first.column}" column was read as the ${first.field} amount, but it `
      + `does not hold amounts — it contains ${first.examples.map((e) => `"${e}"`).join(', ')}. `
      + 'Pick the column that holds the figures.';
    const report = { ...columnReport, needs_mapping: true, unreadable, message };
    if (req.query.preview === 'true') return res.json({ data: report });
    return res.status(422).json({ message, data: report });
  }

  if (missing.length) {
    /*
     * A preview ANSWERS with what it found so the screen can offer the
     * mapping; an import refuses, because importing with no amount column
     * would write nothing and say it succeeded.
     */
    const message = missing.includes('date') && missing.includes('amount')
      ? 'Neither a date nor an amount column was recognised. Pick which of the file\'s columns '
        + 'holds each — in a PDF this usually means the header row itself was read wrongly.'
      : `No ${missing[0]} column was recognised. Pick which of the file's columns holds it.`;

    if (req.query.preview === 'true') return res.json({ data: { ...columnReport, message } });
    return res.status(422).json({ message, data: columnReport });
  }

  /*
   * The reference question, asked once and only where it changes something.
   *
   * A preview answers rather than refuses — the screen needs the report in
   * order to ASK — but an import stops here until it has been answered,
   * because a narration imported as a reference is not visible afterwards:
   * the lines look right and only match badly.
   */
  if (reference.state !== 'ok' && !referenceChoice) {
    const message = reference.state === 'absent'
      ? 'No column on this statement holds a transaction reference. Say whether to import '
        + 'without references, or add a column headed "Reference" holding just the reference '
        + 'for each line and upload the file again.'
      : `The "${reference.column}" column was read as the reference, but it reads like a `
        + `narration — it holds ${reference.examples.map((e) => `"${e}"`).join(', ')}. `
        + 'Say that it holds only the reference, or copy each reference into its own column '
        + 'headed "Reference" and upload the file again.';
    /* Carried on the note itself, so a preview can ask the question without
       the panel's own "read as follows" heading being replaced by it. */
    reference.message = message;
    if (req.query.preview !== 'true') {
      return res.status(422).json({ message, data: { ...columnReport, needs_mapping: true } });
    }
  }

  let ambiguous = 0;
  let ambiguousExample = null;
  /*
   * Rows that are not transactions — see isNonMovement. Kept so the screen can
   * show exactly what was passed over; a statement that quietly loses rows is
   * the thing this whole screen exists to avoid.
   */
  const passedOver = [];
  /*
   * The running balance beside every row, movement or not. See the check
   * below: a statement that prints its balance is a statement that can be
   * made to prove the amounts were read correctly.
   */
  const trail = [];

  const parsed = readFile(csv, aliases, {
    required: ['date'],
    /* The same answers the report above was built from. */
    pinned,
    row: (cells, at, rowNumber) => {
      const raw = at.date === null ? '' : cells[at.date];
      if (isAmbiguousDate(raw)) {
        ambiguous += 1;
        ambiguousExample = ambiguousExample || String(raw).trim();
      }
      const date = parseDate(raw, { dayFirst });

      /*
       * By the SHAPE, not by which columns happen to be mapped. See SHAPES
       * above for what the difference cost.
       */
      let amount = null;

      const textAt = (index) => (index === null ? '' : String(cells[index] ?? '').trim());
      /*
       * What a refusal says.
       *
       * "an amount could not be read" is true and useless: it names neither
       * the column nor what was in it, so the only way to find out was to
       * open the file and count rows. This quotes the cells it actually
       * looked at, by their headings in your file.
       */
      const cannotRead = (fields) => ({
        error: `${fields.map((field) => {
          const text = textAt(at[field]);
          return `the "${header[at[field]]}" column ${text ? `says "${text}"` : 'is empty'}`;
        }).join(' and ')} — that is not an amount.`,
      });
      /* A brought-forward or total line: passed over, and said so. */
      /*
       * The balance on this row, or nothing.
       *
       * Blank is NOT zero here. An empty balance cell means the row carries no
       * balance — a footer, a spacer — and reading it as zero puts a fall of
       * the entire closing balance into the running check.
       */
      const balanceOf = () => {
        const text = textAt(at.balance);
        return text ? parseSignedAmount(text) : null;
      };

      const notATransaction = (fields, inTrail = true) => {
        /*
         * A brought-forward line belongs to the running balance; a totals line
         * under the table does not, and letting one into the chain makes the
         * balance check complain about a row that was never a movement.
         */
        if (inTrail) trail.push({ row: rowNumber, balance: balanceOf(), amount: 0, date });
        passedOver.push({
          row: rowNumber,
          text: fields.map((field) => textAt(at[field])).filter(Boolean).join(' / ')
            /* Nothing to quote from the columns: show the row itself, so what
               was left out is never a mystery. */
            || cells.filter((cell) => String(cell ?? '').trim()).join(' ').slice(0, 80),
          description: at.description === null ? null : textAt(at.description),
        });
        return null;
      };

      /*
       * No date on the row. Either the table has ended — a totals line, a
       * footer — or a date really could not be read, and the two need
       * different answers. What decides it: whether anything on the row is
       * money, and whether it reads like the foot of a statement.
       */
      if (!date) {
        const figures = [at.debit, at.credit, at.amount]
          .filter((index) => index !== null && index !== undefined)
          .map((index) => parseSignedAmount(cells[index]))
          .filter((value) => value !== null && value !== 0);
        if (!figures.length || looksLikeSummary(cells)) {
          return notATransaction(at.date === null ? [] : ['date'], false);
        }
        return {
          error: `the date could not be read — the "${header[at.date]}" column `
            + `${String(raw).trim() ? `says "${String(raw).trim()}"` : 'is empty'}.`,
        };
      }

      if (shape === SHAPES.TWO_COLUMNS) {
        const out = at.debit === null ? 0 : parseSignedAmount(cells[at.debit]);
        const income = at.credit === null ? 0 : parseSignedAmount(cells[at.credit]);
        if (out === null || income === null) {
          const sides = [at.debit, at.credit].map((index, which) => (index === null ? null : ['debit', 'credit'][which])).filter(Boolean);
          /*
           * Neither side holds a figure and one of them holds a word: a
           * balance brought forward, a page total. Not a movement, and not a
           * reason to refuse the statement it came in.
           */
          if (!out && !income && sides.some((field) => isNonMovement(textAt(at[field])))) {
            return notATransaction(sides);
          }
          return cannotRead(sides);
        }
        amount = Math.abs(income) - Math.abs(out);
      } else if (shape === SHAPES.WITH_DIRECTION) {
        const value = parseSignedAmount(cells[at.amount]);
        if (value === null) {
          if (isNonMovement(textAt(at.amount))) return notATransaction(['amount']);
          return cannotRead(['amount']);
        }
        const way = parseDirection(cells[at.direction]);
        if (value !== 0 && way === null) {
          return {
            error: `the "${header[at.direction]}" column says "${String(cells[at.direction] ?? '').trim()}", `
              + 'which does not say whether the money came in or went out.',
          };
        }
        amount = way === 'out' ? -Math.abs(value) : Math.abs(value);
      } else if (shape === SHAPES.SIGNED) {
        amount = parseSignedAmount(cells[at.amount]);
        if (amount === null) {
          if (isNonMovement(textAt(at.amount))) return notATransaction(['amount']);
          return cannotRead(['amount']);
        }
      } else {
        return { error: 'there is no amount on this row.' };
      }

      /*
       * Nothing moved, and the row reads like the foot of the statement —
       * "Generated on 01 Sep 2026", "Page 1 of 1". Those carry a date the
       * parser will happily read, so they reach this far looking like rows.
       */
      if (!amount && looksLikeSummary(cells)) return notATransaction([], false);

      /*
       * The reference: the column where there is one, the narration where
       * somebody has asked for that, and whatever they corrected it to.
       */
      const narration = at.description === null ? '' : textAt(at.description);
      const suggestion = referenceChoice === 'extract' ? referenceFrom(narration) : null;
      const referenceOf = (row) => {
        if (referenceChoice === 'none') return null;
        if (referenceChoice === 'extract') {
          const given = corrections[String(row)];
          // An answer of "" is an answer: this row has no reference.
          if (given !== undefined) return String(given).trim() || null;
          return suggestion;
        }
        return at.reference === null ? null : (cells[at.reference] || null);
      };

      trail.push({ row: rowNumber, balance: balanceOf(), amount, date });

      if (!amount) return null; // a zero line is not a movement

      return {
        statement_date: date,
        description: at.description === null ? null : (cells[at.description] || null),
        /* "none" means the column mapped here is not a reference — see
           referenceAdvice. Importing it anyway is what the question exists
           to prevent. */
        reference: referenceOf(rowNumber),
        /* What was read out of the narration, for the screen to show and for
           a person to correct. Never imported on its own — see below. */
        suggested_reference: suggestion,
        amount_minor: amount,
        balance_minor: at.balance === null ? null : parseSignedAmount(cells[at.balance]),
      };
    },
  });

  /*
   * ── Does the statement agree with itself? ─────────────────────────────────
   *
   * A bank statement prints a running balance, which means the file carries
   * its own proof: each row's balance less the row before it IS that row's
   * movement. Where the two disagree, an amount was misread — and that is
   * precisely the failure that is otherwise invisible, because a row whose
   * amount was lost imports as nothing at all and the totals simply come out
   * too small.
   *
   * Only where the balance is dependable in the first place: if it reconciles
   * on most rows the exceptions are real, and if it reconciles on few the
   * column is something else — a cleared balance, an available balance — and
   * this says nothing.
   */
  const walk = trail.filter((step) => step.balance !== null);
  const drift = (reverse) => {
    const breaks = [];
    let agreed = 0;
    for (let i = 1; i < walk.length; i += 1) {
      /*
       * Where the dates turn back on themselves the statement has started
       * again — a personal statement carries several accounts, each with its
       * own letterhead and its own running balance, and the balance at the
       * top of the second account has nothing to do with the bottom of the
       * first. Those joins are stepped over rather than reported as a
       * misread amount. A missed amount does not move a date, so the check
       * loses nothing it was there to catch.
       */
      const before = walk[i - 1].date;
      const now = walk[i].date;
      const restarted = before && now && (reverse ? now > before : now < before);
      if (restarted) continue; // eslint-disable-line no-continue

      const delta = reverse
        ? walk[i - 1].balance - walk[i].balance
        : walk[i].balance - walk[i - 1].balance;
      // A kobo of slack: banks round, and so does everybody reading them.
      if (Math.abs(delta - walk[i].amount) <= 1) agreed += 1;
      else breaks.push({ ...walk[i], delta });
    }
    return { agreed, breaks };
  };
  const forwards = drift(false);
  const backwards = drift(true);
  /* Newest-first statements exist; whichever reading agrees more is the one. */
  const best = backwards.agreed > forwards.agreed ? backwards : forwards;
  const pairs = best.agreed + best.breaks.length;

  if (pairs >= 4 && best.agreed >= pairs * 0.7 && best.breaks.length) {
    const money = (minor) => (Math.abs(minor) / 100).toLocaleString('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
    return res.status(422).json({
      message: 'This statement does not agree with its own balance column, so an amount was '
        + `read wrongly on ${best.breaks.length} row(s). Nothing was imported. Check those rows `
        + 'against the file — in a PDF it usually means two columns were read as one.',
      errors: best.breaks.slice(0, 20).map((step) => (
        `Row ${step.row}: the balance moves by ${money(step.delta)} `
        + `but the amounts on that row come to ${money(step.amount)}.`
      )),
      data: { ...columnReport, needs_mapping: true },
    });
  }

  /*
   * Too many rows "not transactions" is not a statement full of totals — it
   * is a statement whose columns were read wrongly, and passing them over
   * hides exactly that. Beyond a handful they are reported as the problem
   * they are, with what was in them, rather than being left out quietly.
   */
  if (passedOver.length > Math.max(2, Math.ceil(parsed.records.length * 0.25))) {
    return res.status(422).json({
      message: `${passedOver.length} rows had nothing readable in the amount columns, which `
        + 'usually means the columns were read wrongly rather than that those rows are totals. '
        + 'Check the columns below against your file.',
      errors: passedOver.map((row) => (
        `Row ${row.row}: ${row.description || row.text || 'no amount could be read'}`
      )),
      data: { ...columnReport, needs_mapping: true, passed_over: passedOver.slice(0, 20) },
    });
  }

  if (parsed.errors.length) {
    return res.status(422).json({
      message: `The statement was not imported. ${parsed.errors.length} problem(s) found.`,
      errors: parsed.errors,
    });
  }
  if (!parsed.records.length) {
    return res.status(422).json({ message: 'The file has no movements in it.' });
  }

  /*
   * Every row with what was read out of its narration, for the screen to put
   * in front of somebody. Sent whenever the reference is in question, whether
   * the row is new or already imported — the table is of the FILE, and a
   * table missing half its rows is not something anybody can check.
   */
  const referenceRows = reference.state === 'ok' ? [] : parsed.records.slice(0, 300).map((row) => ({
    row: row.row_number,
    date: row.statement_date,
    description: row.description,
    amount_minor: row.amount_minor,
    suggestion: row.suggested_reference ?? referenceFrom(row.description),
    reference: row.reference,
  }));

  const withFingerprints = parsed.records.map(({ suggested_reference: _suggested, ...row }) => ({
    ...row, fingerprint: fingerprintOf(row),
  }));

  /*
   * A statement re-downloaded to pick up the last few days brings the whole
   * month with it. Those lines are recognised and skipped rather than
   * doubling every movement.
   */
  const existing = await sequelize.query(
    `SELECT fingerprint FROM bank_statement_lines
      WHERE account_id = :accountId AND fingerprint IN (:prints)
        AND company_id ${companyId ? '= :companyId' : 'IS NULL'}`,
    {
      replacements: { accountId, companyId, prints: withFingerprints.map((r) => r.fingerprint) },
      type: QueryTypes.SELECT,
    },
  );
  const seen = new Set(existing.map((row) => row.fingerprint));
  const fresh = withFingerprints.filter((row) => !seen.has(row.fingerprint));

  const summary = {
    read: parsed.records.length,
    already_imported: withFingerprints.length - fresh.length,
    to_import: fresh.length,
    money_in_minor: fresh.filter((r) => r.amount_minor > 0).reduce((t, r) => t + r.amount_minor, 0),
    money_out_minor: fresh.filter((r) => r.amount_minor < 0).reduce((t, r) => t + r.amount_minor, 0),
    from: fresh.length ? fresh[0].statement_date : null,
    to: fresh.length ? fresh[fresh.length - 1].statement_date : null,
    mapping_used: mapping ? mapping.source : null,
    day_first: dayFirst,
    shape,
    ambiguous_dates: ambiguous,
    ambiguous_example: ambiguousExample,
    /* Rows that were not transactions, and what was in them. */
    passed_over: passedOver.slice(0, 20),
    passed_over_count: passedOver.length,
    /* Always, not only when something is missing — so the screen can show
       which column it read as what, and let it be corrected. */
    ...columnReport,
    reference_rows: referenceRows,
  };

  if (req.query.preview === 'true') {
    return res.json({ data: { ...summary, lines: fresh.slice(0, 50) } });
  }

  if (!fresh.length) {
    return res.status(409).json({
      message: 'Every line in this file has already been imported.',
      data: summary,
    });
  }

  const batch = `BS-${Date.now().toString(36).toUpperCase()}`;
  await BankStatementLine.bulkCreate(fresh.map((row) => ({
    ...row,
    company_id: companyId,
    account_id: accountId,
    status: 'unmatched',
    import_batch: batch,
    imported_by: req.user?.id ?? null,
  })));

  /*
   * The mapping is saved AFTER a successful import rather than before, so a
   * file that could not be read does not leave behind a description of how to
   * read it.
   */
  if (req.body.source && req.body.save_mapping !== false) {
    const columns = Object.fromEntries(
      Object.entries(resolved).filter(([, column]) => column),
    );
    /*
     * Updated, not just created. The whole point of asking somebody which
     * column is which is that they never have to answer twice — and a bank
     * that renames a column next year has to be able to correct it.
     */
    const [saved] = await ImportMapping.findOrCreate({
      where: { company_id: companyId, kind: 'bank_statement', source: String(req.body.source) },
      defaults: {
        company_id: companyId,
        kind: 'bank_statement',
        source: String(req.body.source),
        columns: { ...columns, __shape: shape, __reference: referenceChoice },
        day_first: dayFirst,
        created_by: req.user?.id ?? null,
      },
    });
    await saved.update({
      columns: { ...columns, __shape: shape, __reference: referenceChoice },
      day_first: dayFirst,
    });
  }

  res.status(201).json({
    data: { ...summary, batch },
    message: `${fresh.length} line(s) imported`
      + (summary.already_imported ? `, ${summary.already_imported} already seen.` : '.'),
  });
});

const listLines = asyncHandler(async (req, res) => {
  const companyId = req.user?.isSuperiorAdmin
    ? (req.query.company_id ?? null) : (req.user?.company_id ?? null);

  const filters = [];
  const replacements = { companyId, accountId: req.query.account_id };
  if (req.query.account_id) filters.push('AND l.account_id = :accountId');
  if (req.query.status) { filters.push('AND l.status = :status'); replacements.status = req.query.status; }
  if (req.query.to) { filters.push('AND l.statement_date <= :to'); replacements.to = req.query.to; }

  const rows = await sequelize.query(
    `SELECT l.*, e.reference AS entry_reference, e.memo AS entry_memo
       FROM bank_statement_lines l
       LEFT JOIN journal_entries e ON e.id = l.matched_entry_id
      WHERE l.company_id ${companyId ? '= :companyId' : 'IS NULL'} ${filters.join(' ')}
      ORDER BY l.statement_date, l.id
      LIMIT 1000`,
    { replacements, type: QueryTypes.SELECT },
  );
  res.json({ data: rows });
});

/**
 * ACC-6.2 — what each unmatched line might be.
 *
 * The candidate side is the JOURNAL, not the receipts or the payments: every
 * movement through a bank account is a journal line against that account,
 * however it arose. Matching against source documents instead would mean four
 * queries and a gap wherever a fifth kind of document appears.
 */
const suggestions = asyncHandler(async (req, res) => {
  const companyId = req.user?.isSuperiorAdmin
    ? (req.query.company_id ?? null) : (req.user?.company_id ?? null);
  const accountId = Number(req.query.account_id);
  if (!accountId) return res.status(400).json({ message: 'Say which bank account.' });

  const lines = await BankStatementLine.findAll({
    where: {
      ...buildCompanyScope(req), account_id: accountId, status: 'unmatched',
    },
    order: [['statement_date', 'ASC']],
    limit: 200,
  });
  if (!lines.length) return res.json({ data: [] });

  /*
   * Every journal line touching this account that no statement line has
   * claimed. The window is bounded by the statement's own dates plus a
   * fortnight either side, because a candidate three years away is never the
   * answer and scanning the whole ledger for each line is how this gets slow.
   */
  const dates = lines.map((line) => line.statement_date).sort();
  const candidates = await sequelize.query(
    `SELECT e.id AS entry_id, e.reference, e.entry_date, e.memo, e.source, e.source_id,
            (l.debit_minor - l.credit_minor) AS amount_minor,
            l.memo AS line_memo
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = :accountId
        AND e.entry_date >= :from AND e.entry_date <= :to
        AND e.company_id ${companyId ? '= :companyId' : 'IS NULL'}
        AND NOT EXISTS (
          SELECT 1 FROM bank_statement_lines b
           WHERE b.matched_entry_id = e.id AND b.status IN ('matched', 'posted')
        )`,
    {
      replacements: {
        accountId,
        companyId,
        from: new Date(new Date(dates[0]).getTime() - 14 * 86400000).toISOString().slice(0, 10),
        to: new Date(new Date(dates[dates.length - 1]).getTime() + 14 * 86400000).toISOString().slice(0, 10),
      },
      type: QueryTypes.SELECT,
    },
  );

  /*
   * A candidate already suggested as CERTAIN for an earlier line is taken out
   * of the running for later ones. Without that, one ₦500,000 receipt is
   * offered against three identical statement lines and a person accepts the
   * same entry three times.
   */
  const claimed = new Set();
  const data = lines.map((line) => {
    const available = candidates.filter((row) => !claimed.has(row.entry_id));
    const ranked = suggestFor(line, available.map((row) => ({
      ...row, reference: row.reference, memo: row.line_memo || row.memo,
    })));
    const best = ranked[0];
    if (best?.certainty === 'certain') claimed.add(best.candidate.entry_id);
    return { line, suggestions: ranked };
  });

  res.json({
    data,
    certain: data.filter((row) => row.suggestions[0]?.certainty === 'certain').length,
  });
});

/** Accept a match. */
const matchLine = asyncHandler(async (req, res) => {
  const line = await BankStatementLine.findOne({ where: { id: req.params.id, ...scope(req) } });
  if (!line) return res.status(404).json({ message: 'Statement line not found' });
  if (line.reconciliation_id) {
    return res.status(409).json({ message: 'This line is inside a locked reconciliation.' });
  }

  const entryId = Number(req.body.entry_id);
  if (!entryId) return res.status(400).json({ message: 'Say which journal it is.' });

  const [taken] = await sequelize.query(
    `SELECT id FROM bank_statement_lines
      WHERE matched_entry_id = :entryId AND id <> :id AND status IN ('matched', 'posted')
      LIMIT 1`,
    { replacements: { entryId, id: line.id }, type: QueryTypes.SELECT },
  );
  if (taken) {
    return res.status(409).json({
      message: 'That journal is already matched to another statement line. '
        + 'Two bank lines cannot be the same movement.',
    });
  }

  await line.update({
    status: 'matched',
    matched_entry_id: entryId,
    matched_by: req.user?.id ?? null,
    matched_at: new Date(),
  });
  res.json({ data: line });
});

const unmatchLine = asyncHandler(async (req, res) => {
  const line = await BankStatementLine.findOne({ where: { id: req.params.id, ...scope(req) } });
  if (!line) return res.status(404).json({ message: 'Statement line not found' });
  if (line.reconciliation_id) {
    return res.status(409).json({
      message: 'This line is inside a locked reconciliation, which is what makes the lock mean something.',
    });
  }
  if (line.status === 'posted') {
    return res.status(409).json({
      message: 'This line was posted to the ledger. Reverse the journal instead — unmatching it here would leave the entry with nothing to explain it.',
    });
  }
  await line.update({
    status: 'unmatched', matched_entry_id: null, matched_by: null, matched_at: null,
  });
  res.json({ data: line });
});

/**
 * ACC-6.3 — a line with nothing behind it, posted straight to an account.
 *
 * Bank charges, interest received, a standing order nobody recorded. These
 * have no document in the platform and never will: the bank is the document.
 * Posting them from here is what stops a reconciliation stalling on three
 * lines of charges nobody can clear.
 */
const postLine = asyncHandler(async (req, res) => {
  const line = await BankStatementLine.findOne({ where: { id: req.params.id, ...scope(req) } });
  if (!line) return res.status(404).json({ message: 'Statement line not found' });
  if (line.status !== 'unmatched') {
    return res.status(409).json({ message: `This line is already ${line.status}.` });
  }

  const accountId = Number(req.body.account_id);
  if (!accountId) {
    return res.status(400).json({ message: 'Say which account this belongs to — bank charges, interest, and so on.' });
  }
  const account = await LedgerAccount.findOne({ where: { id: accountId, ...scope(req) } });
  if (!account) return res.status(422).json({ message: 'Choose an account this company has.' });

  const amount = Number(line.amount_minor);
  const memo = String(req.body.memo || line.description || 'Bank statement line').slice(0, 200);

  /*
   * Money OUT of the bank is a credit to the bank and a debit to wherever it
   * went; money in is the reverse. Both legs are derived from the one signed
   * amount, so the entry balances by construction.
   */
  const lines = amount < 0
    ? [
      { account_id: accountId, debit_minor: -amount, credit_minor: 0, memo },
      { account_id: line.account_id, debit_minor: 0, credit_minor: -amount, memo },
    ]
    : [
      { account_id: line.account_id, debit_minor: amount, credit_minor: 0, memo },
      { account_id: accountId, debit_minor: 0, credit_minor: amount, memo },
    ];

  try {
    const entry = await post(sequelize, {
      companyId: line.company_id,
      entryDate: line.statement_date,
      source: 'bank_line',
      sourceId: String(line.id),
      memo,
      createdBy: req.user?.id ?? null,
      lines,
    });
    await line.update({
      status: 'posted',
      matched_entry_id: entry.entry_id,
      matched_by: req.user?.id ?? null,
      matched_at: new Date(),
    });
    return res.status(201).json({
      data: line,
      message: `Posted as ${entry.reference}.`,
    });
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message });
  }
});

/** A line that is not the company's business — a bank's own reversal pair. */
const ignoreLine = asyncHandler(async (req, res) => {
  const line = await BankStatementLine.findOne({ where: { id: req.params.id, ...scope(req) } });
  if (!line) return res.status(404).json({ message: 'Statement line not found' });
  const reason = String(req.body.reason || '').trim();
  if (!reason) {
    return res.status(400).json({ message: 'Say why this line is being set aside. It stays on the statement either way.' });
  }
  await line.update({
    status: 'ignored',
    description: `${line.description || ''} [ignored: ${reason}]`.trim().slice(0, 400),
  });
  res.json({ data: line });
});

/**
 * Where the account stands: what the bank says, what the ledger says, and what
 * is between them.
 */
const summary = asyncHandler(async (req, res) => {
  const companyId = req.user?.isSuperiorAdmin
    ? (req.query.company_id ?? null) : (req.user?.company_id ?? null);
  const accountId = Number(req.query.account_id);
  const asAt = req.query.as_at || new Date().toISOString().slice(0, 10);
  if (!accountId) return res.status(400).json({ message: 'Say which bank account.' });

  const [ledger] = await sequelize.query(
    `SELECT COALESCE(SUM(l.debit_minor), 0) - COALESCE(SUM(l.credit_minor), 0) AS balance
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = :accountId AND e.entry_date <= :asAt
        AND e.company_id ${companyId ? '= :companyId' : 'IS NULL'}`,
    { replacements: { accountId, asAt, companyId }, type: QueryTypes.SELECT },
  );

  const [statement] = await sequelize.query(
    /*
     * `line_count`, not `lines`: LINES is a reserved word in MySQL 8 and the
     * query fails to parse with it as an alias. Aliases across this module
     * avoid words either engine has claimed rather than quoting per dialect.
     */
    `SELECT COALESCE(SUM(amount_minor), 0) AS movement, COUNT(*) AS line_count,
            COALESCE(SUM(CASE WHEN status = 'unmatched' THEN 1 ELSE 0 END), 0) AS unmatched_count,
            MAX(statement_date) AS last_line
       FROM bank_statement_lines
      WHERE account_id = :accountId AND statement_date <= :asAt AND status <> 'ignored'
        AND company_id ${companyId ? '= :companyId' : 'IS NULL'}`,
    { replacements: { accountId, asAt, companyId }, type: QueryTypes.SELECT },
  );

  /*
   * Unmatched lines in BOTH directions are what a reconciliation actually
   * reports: a statement line nobody has recorded, and a ledger entry the bank
   * has not shown. Reporting only the first would describe half the gap.
   */
  const [unrecorded] = await sequelize.query(
    `SELECT COALESCE(SUM(amount_minor), 0) AS total
       FROM bank_statement_lines
      WHERE account_id = :accountId AND statement_date <= :asAt AND status = 'unmatched'
        AND company_id ${companyId ? '= :companyId' : 'IS NULL'}`,
    { replacements: { accountId, asAt, companyId }, type: QueryTypes.SELECT },
  );

  const [unpresented] = await sequelize.query(
    `SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) AS total
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = :accountId AND e.entry_date <= :asAt
        AND e.company_id ${companyId ? '= :companyId' : 'IS NULL'}
        AND NOT EXISTS (
          SELECT 1 FROM bank_statement_lines b
           WHERE b.matched_entry_id = e.id AND b.status IN ('matched', 'posted')
        )`,
    { replacements: { accountId, asAt, companyId }, type: QueryTypes.SELECT },
  );

  const ledgerBalance = Number(ledger?.balance || 0);
  const unrecordedTotal = Number(unrecorded?.total || 0);
  const unpresentedTotal = Number(unpresented?.total || 0);

  res.json({
    data: {
      account_id: accountId,
      as_at: asAt,
      ledger_balance_minor: ledgerBalance,
      statement_lines: Number(statement?.line_count || 0),
      unmatched_lines: Number(statement?.unmatched_count || 0),
      last_statement_line: statement?.last_line || null,
      on_statement_not_in_books_minor: unrecordedTotal,
      in_books_not_on_statement_minor: unpresentedTotal,
      /*
       * What the bank's balance ought to be if everything outstanding is
       * accounted for. Offered rather than demanded, because most Nigerian
       * exports do not carry a running balance and a reconciliation is still
       * worth doing without one.
       */
      expected_statement_balance_minor: ledgerBalance - unpresentedTotal + unrecordedTotal,
    },
  });
});

/**
 * ACC-6.4 — lock it.
 *
 * Refused while anything is unmatched, because a reconciliation with open
 * items in it is a statement that the account agrees when it does not. Period
 * close reads these rows, and a lock that could be taken with unmatched lines
 * would let a month close on an account nobody had actually agreed.
 */
const lockReconciliation = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const accountId = Number(req.body.account_id);
  const statementDate = req.body.statement_date;
  if (!accountId || !statementDate) {
    return res.status(400).json({ message: 'Say which account, and to what date.' });
  }

  const [open] = await sequelize.query(
    `SELECT COUNT(*) AS n FROM bank_statement_lines
      WHERE account_id = :accountId AND statement_date <= :statementDate
        AND status = 'unmatched'
        AND company_id ${companyId ? '= :companyId' : 'IS NULL'}`,
    { replacements: { accountId, statementDate, companyId }, type: QueryTypes.SELECT },
  );
  if (Number(open.n) > 0) {
    return res.status(422).json({
      message: `${open.n} statement line(s) up to ${statementDate} are still unmatched. `
        + 'A reconciliation with open items in it would say the account agrees when it does not.',
    });
  }

  const [ledger] = await sequelize.query(
    `SELECT COALESCE(SUM(l.debit_minor), 0) - COALESCE(SUM(l.credit_minor), 0) AS balance
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = :accountId AND e.entry_date <= :statementDate
        AND e.company_id ${companyId ? '= :companyId' : 'IS NULL'}`,
    { replacements: { accountId, statementDate, companyId }, type: QueryTypes.SELECT },
  );

  const [unpresented] = await sequelize.query(
    `SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) AS total
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = :accountId AND e.entry_date <= :statementDate
        AND e.company_id ${companyId ? '= :companyId' : 'IS NULL'}
        AND NOT EXISTS (
          SELECT 1 FROM bank_statement_lines b
           WHERE b.matched_entry_id = e.id AND b.status IN ('matched', 'posted')
        )`,
    { replacements: { accountId, statementDate, companyId }, type: QueryTypes.SELECT },
  );

  const ledgerBalance = Number(ledger?.balance || 0);
  const outstanding = Number(unpresented?.total || 0);
  const statementBalance = req.body.statement_balance_minor === undefined
    ? ledgerBalance - outstanding
    : Math.round(Number(req.body.statement_balance_minor));

  const difference = ledgerBalance - outstanding - statementBalance;
  if (difference !== 0) {
    return res.status(422).json({
      message: `The account does not agree: the ledger less ${outstanding} minor units of `
        + `outstanding items gives ${ledgerBalance - outstanding}, and the statement says `
        + `${statementBalance} — a difference of ${difference}.`,
    });
  }

  const [reconciliation] = await BankReconciliation.findOrCreate({
    where: { company_id: companyId, account_id: accountId, statement_date: statementDate },
    defaults: { company_id: companyId, account_id: accountId, statement_date: statementDate },
  });
  await reconciliation.update({
    statement_balance_minor: statementBalance,
    ledger_balance_minor: ledgerBalance,
    outstanding_minor: outstanding,
    difference_minor: 0,
    status: 'locked',
    notes: req.body.notes || null,
    reconciled_by: req.user?.id ?? null,
    reconciled_at: new Date(),
  });

  await sequelize.query(
    `UPDATE bank_statement_lines SET reconciliation_id = :id, updated_at = NOW()
      WHERE account_id = :accountId AND statement_date <= :statementDate
        AND reconciliation_id IS NULL
        AND company_id ${companyId ? '= :companyId' : 'IS NULL'}`,
    {
      replacements: { id: reconciliation.id, accountId, statementDate, companyId },
      type: QueryTypes.UPDATE,
    },
  );

  res.json({
    data: reconciliation,
    message: `Reconciled to ${statementDate}. Period close will now accept this account.`,
  });
});

const listReconciliations = asyncHandler(async (req, res) => {
  const rows = await BankReconciliation.findAll({
    where: scope(req),
    order: [['statement_date', 'DESC']],
  });
  res.json({ data: rows });
});

/**
 * The saved column mappings, presets included.
 *
 * Presets first, then the company's own. Ordered by a CASE rather than by
 * "company_id IS NULL DESC", which sorts a boolean — something MySQL is happy
 * with and Postgres orders the other way round.
 */
const listMappings = asyncHandler(async (req, res) => {
  const companyId = req.user?.isSuperiorAdmin
    ? (req.query.company_id ?? null) : (req.user?.company_id ?? null);
  const rows = await sequelize.query(
    `SELECT * FROM import_mappings
      WHERE is_active = true AND (company_id IS NULL ${companyId ? 'OR company_id = :companyId' : ''})
        ${req.query.kind ? 'AND kind = :kind' : ''}
      ORDER BY CASE WHEN company_id IS NULL THEN 0 ELSE 1 END, source`,
    { replacements: { companyId, kind: req.query.kind }, type: QueryTypes.SELECT },
  );
  res.json({ data: rows });
});

module.exports = {
  bankAccounts,
  importStatement,
  listLines,
  suggestions,
  matchLine,
  unmatchLine,
  postLine,
  ignoreLine,
  summary,
  lockReconciliation,
  listReconciliations,
  listMappings,
  STATEMENT_COLUMNS,
  SHAPES,
  inferShape,
  referenceAdvice,
};

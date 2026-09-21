const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const {
  sequelize, BankStatementLine, BankReconciliation, ImportMapping, LedgerAccount,
} = require('../models');
const { buildCompanyScope, buildDefaultsScope } = require('../utils/crudFactory');
const { readFile, parseSignedAmount, parseDate } = require('../../../../shared/src/accounting/csvImport');
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
  debit: ['debit', 'withdrawal', 'withdrawals', 'money_out', 'dr'],
  credit: ['credit', 'deposit', 'deposits', 'lodgement', 'money_in', 'cr'],
  balance: ['balance', 'running_balance', 'closing_balance', 'book_balance'],
};

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
  if (mapping?.columns) {
    // The saved spelling goes first, so it wins over a generic guess.
    Object.entries(mapping.columns).forEach(([field, column]) => {
      if (!column) return;
      const key = String(column).toLowerCase().replace(/\s+/g, '_');
      aliases[field] = [key, ...(aliases[field] || [])];
    });
  }

  const parsed = readFile(csv, aliases, {
    required: ['date'],
    row: (cells, at) => {
      const date = parseDate(at.date === null ? '' : cells[at.date], { dayFirst });
      if (!date) return { error: 'the date could not be read.' };

      /*
       * Two columns beat one. A file with debit and credit columns has already
       * told us the direction; reading its `amount` column instead would be
       * reading whatever the bank chose to put there, which is often a running
       * balance.
       */
      let amount = null;
      if (at.debit !== null || at.credit !== null) {
        const out = at.debit === null ? 0 : parseSignedAmount(cells[at.debit]);
        const income = at.credit === null ? 0 : parseSignedAmount(cells[at.credit]);
        if (out === null || income === null) return { error: 'an amount could not be read.' };
        amount = Math.abs(income) - Math.abs(out);
      } else if (at.amount !== null) {
        amount = parseSignedAmount(cells[at.amount]);
        if (amount === null) return { error: 'the amount could not be read.' };
      } else {
        return { error: 'there is no amount on this row.' };
      }

      if (!amount) return null; // a zero line is not a movement

      return {
        statement_date: date,
        description: at.description === null ? null : (cells[at.description] || null),
        reference: at.reference === null ? null : (cells[at.reference] || null),
        amount_minor: amount,
        balance_minor: at.balance === null ? null : parseSignedAmount(cells[at.balance]),
      };
    },
  });

  if (parsed.errors.length) {
    return res.status(422).json({
      message: `The statement was not imported. ${parsed.errors.length} problem(s) found.`,
      errors: parsed.errors,
    });
  }
  if (!parsed.records.length) {
    return res.status(422).json({ message: 'The file has no movements in it.' });
  }

  const withFingerprints = parsed.records.map((row) => ({
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
      Object.entries(parsed.mapping)
        .filter(([, index]) => index !== null)
        .map(([field, index]) => [field, parsed.header[index]]),
    );
    await ImportMapping.findOrCreate({
      where: { company_id: companyId, kind: 'bank_statement', source: String(req.body.source) },
      defaults: {
        company_id: companyId,
        kind: 'bank_statement',
        source: String(req.body.source),
        columns,
        day_first: dayFirst,
        created_by: req.user?.id ?? null,
      },
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
};

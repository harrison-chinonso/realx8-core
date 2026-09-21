const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize, LedgerAccount } = require('../models');
const { buildCompanyScope } = require('../utils/crudFactory');
const ledger = require('../../../../shared/src/accounting/ledger');
const { TYPE, ROLES, parentCodeOf } = require('../../../../shared/src/accounting/chart');
const { parseJournalCsv } = require('../../../../shared/src/accounting/journalImport');

/**
 * Reading the ledger, and the two ways of writing to it.
 *
 * ── What is NOT here ────────────────────────────────────────────────────────
 *
 * There is no endpoint that edits or deletes a journal entry, and there must
 * never be. A posted journal is corrected by reversing it (ACC-2.4); the
 * database refuses the alternative (protectJournal.js) and this controller
 * simply has nothing to offer anyone who wants one. Same shape as
 * auditController, and for the same reason.
 *
 * Nor is there an endpoint that posts an arbitrary journal from a request
 * body. Automatic postings come from the events that cause them (ACC-3);
 * `createManualJournal` below is for the things the system cannot know —
 * opening balances, an accrual, a depreciation schedule kept outside — and it
 * takes its own permission (ACC-2.5) precisely so that the ordinary finance
 * permissions do not carry the ability to write whatever anybody likes into
 * the books.
 */

const companyOf = (req) => {
  if (req.user?.isSuperiorAdmin) {
    return req.query.company_id ? Number(req.query.company_id) : null;
  }
  return req.user?.company_id ?? null;
};

// ── The chart (ACC-1) ───────────────────────────────────────────────────────

const listAccounts = asyncHandler(async (req, res) => {
  const scope = buildCompanyScope(req);
  const where = { ...scope };
  if (req.query.type) where.type = req.query.type;
  if (req.query.active === 'true') where.is_active = true;

  const rows = await LedgerAccount.findAll({ where, order: [['code', 'ASC']] });
  res.json({ data: rows });
});

const createAccount = asyncHandler(async (req, res) => {
  const companyId = req.user?.isSuperiorAdmin
    ? (req.body.company_id ?? null)
    : (req.user?.company_id ?? null);

  const code = String(req.body.code || '').trim();
  const name = String(req.body.name || '').trim();
  if (!code || !name) return res.status(400).json({ message: 'An account needs a code and a name.' });
  if (!Object.values(TYPE).includes(req.body.type)) {
    return res.status(400).json({
      message: `type must be one of ${Object.values(TYPE).join(', ')}.`,
    });
  }
  /*
   * A role outside the catalogue is refused rather than stored.
   *
   * A posting rule asks for a role by name; a typo here produces an account
   * that no rule will ever find, while the rule quietly posts to suspense. The
   * catalogue is the only list of roles that mean anything.
   */
  if (req.body.role && !ROLES.includes(req.body.role)) {
    return res.status(422).json({
      message: `${req.body.role} is not a control-account role this system posts to.`,
      roles: ROLES,
    });
  }

  const account = await LedgerAccount.create({
    company_id: companyId,
    code,
    name,
    type: req.body.type,
    role: req.body.role || null,
    parent_code: req.body.parent_code || parentCodeOf(code),
    description: req.body.description || null,
    is_active: req.body.is_active !== false,
    is_system: false,
    created_by: req.user?.id ?? null,
  });

  // The posting engine holds the chart in memory; a new account has to be
  // visible to the next journal rather than to the next restart.
  ledger.forgetChart(companyId);
  res.status(201).json({ data: account });
});

const updateAccount = asyncHandler(async (req, res) => {
  const account = await LedgerAccount.findOne({
    where: { id: req.params.id, ...buildCompanyScope(req) },
  });
  if (!account) return res.status(404).json({ message: 'Account not found' });

  if (req.body.role && !ROLES.includes(req.body.role)) {
    return res.status(422).json({ message: `${req.body.role} is not a role this system posts to.`, roles: ROLES });
  }

  await account.update({
    ...(req.body.code ? { code: String(req.body.code).trim() } : {}),
    ...(req.body.name ? { name: String(req.body.name).trim() } : {}),
    ...(req.body.type ? { type: req.body.type } : {}),
    ...(req.body.role !== undefined ? { role: req.body.role || null } : {}),
    ...(req.body.parent_code !== undefined ? { parent_code: req.body.parent_code || null } : {}),
    ...(req.body.description !== undefined ? { description: req.body.description } : {}),
    ...(req.body.is_active !== undefined ? { is_active: Boolean(req.body.is_active) } : {}),
  });
  ledger.forgetChart(account.company_id);
  res.json({ data: account });
});

/**
 * ACC-1.3: an account that has been posted to is deactivated, never removed.
 *
 * Its history has to stay readable — a journal line pointing at a row that is
 * gone is a statement that cannot be reproduced, which is the one thing book
 * of record cannot tolerate.
 */
const deactivateAccount = asyncHandler(async (req, res) => {
  const account = await LedgerAccount.findOne({
    where: { id: req.params.id, ...buildCompanyScope(req) },
  });
  if (!account) return res.status(404).json({ message: 'Account not found' });

  const [used] = await sequelize.query(
    'SELECT COUNT(*) AS n FROM journal_lines WHERE account_id = :id',
    { replacements: { id: account.id }, type: QueryTypes.SELECT },
  );

  if (Number(used.n) > 0) {
    await account.update({ is_active: false });
    ledger.forgetChart(account.company_id);
    return res.json({
      data: account,
      message: `${account.code} has ${used.n} posting(s) against it, so it has been deactivated `
        + 'rather than deleted. Its history stays readable and nothing new can be posted to it.',
    });
  }

  await account.destroy();
  ledger.forgetChart(account.company_id);
  return res.json({ message: `${account.code} had no postings and has been removed.` });
});

// ── The journal (ACC-2) ─────────────────────────────────────────────────────

const listJournal = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const bounds = [];
  const replacements = { companyId, limit: Math.min(Number(req.query.limit) || 50, 200) };
  if (req.query.from) { bounds.push('AND e.entry_date >= :from'); replacements.from = req.query.from; }
  if (req.query.to) { bounds.push('AND e.entry_date <= :to'); replacements.to = req.query.to; }
  if (req.query.source) { bounds.push('AND e.source = :source'); replacements.source = req.query.source; }

  /*
   * ACC-5.1's drill-through: the entries touching ONE account.
   *
   * An EXISTS rather than a join to journal_lines, because an entry with two
   * lines on the same account would otherwise come back twice — and a reader
   * drilling into a figure would see the same journal listed against itself.
   * What each line contributed is added below, per entry, from the same
   * filter.
   */
  if (req.query.account_id) {
    bounds.push(`AND EXISTS (
      SELECT 1 FROM journal_lines dl WHERE dl.entry_id = e.id AND dl.account_id = :accountId
    )`);
    replacements.accountId = req.query.account_id;
  }

  const rows = await sequelize.query(
    `SELECT e.id, e.reference, e.entry_date, e.source, e.source_id, e.memo,
            e.debit_minor, e.credit_minor, e.reverses_entry_id, e.reversal_reason,
            e.created_by, e.created_at, u.name AS created_by_name
       FROM journal_entries e
       LEFT JOIN users u ON u.id = e.created_by
      WHERE e.company_id ${companyId ? '= :companyId' : 'IS NULL'} ${bounds.join(' ')}
      ORDER BY e.entry_date DESC, e.id DESC
      LIMIT :limit`,
    { replacements, type: QueryTypes.SELECT },
  );

  /*
   * Drilling into an account, the number a reader is chasing is what THIS
   * account took from each entry — not the entry's total, which includes
   * every other leg. Without it the list adds up to something quite different
   * from the figure they clicked, which is the one thing a drill-through must
   * never do.
   */
  if (req.query.account_id && rows.length) {
    const contributions = await sequelize.query(
      `SELECT entry_id,
              COALESCE(SUM(debit_minor), 0) AS debit_minor,
              COALESCE(SUM(credit_minor), 0) AS credit_minor
         FROM journal_lines
        WHERE account_id = :accountId AND entry_id IN (:ids)
        GROUP BY entry_id`,
      {
        replacements: { accountId: req.query.account_id, ids: rows.map((row) => row.id) },
        type: QueryTypes.SELECT,
      },
    );
    const byEntry = new Map(contributions.map((row) => [Number(row.entry_id), row]));
    rows.forEach((row) => {
      const own = byEntry.get(Number(row.id));
      row.account_debit_minor = Number(own?.debit_minor || 0);
      row.account_credit_minor = Number(own?.credit_minor || 0);
    });
  }

  res.json({ data: rows });
});

/** One entry with its lines — the drill-through ACC-5.1 depends on. */
const getJournalEntry = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const [entry] = await sequelize.query(
    `SELECT e.*, u.name AS created_by_name FROM journal_entries e
       LEFT JOIN users u ON u.id = e.created_by
      WHERE e.id = :id ${companyId ? 'AND e.company_id = :companyId' : ''} LIMIT 1`,
    { replacements: { id: req.params.id, companyId }, type: QueryTypes.SELECT },
  );
  // Same answer for "no such entry" and "not yours", so the endpoint cannot be
  // used to discover that another company posted something.
  if (!entry) return res.status(404).json({ message: 'Journal entry not found' });

  /*
   * The project and branch by NAME, not by id.
   *
   * "project 4" on a journal line is a number a reader has to go and look up,
   * which in a drill-through — whose whole purpose is not having to look
   * things up — is the wrong way round. LEFT JOINs, so a line coded to a
   * project since deleted still shows rather than vanishing.
   */
  const lines = await sequelize.query(
    `SELECT l.*, a.name AS account_name, a.${sequelize.getDialect() === 'postgres' ? '"type"' : '`type`'} AS account_type,
            p.name AS property_name, b.name AS branch_name
       FROM journal_lines l
       LEFT JOIN ledger_accounts a ON a.id = l.account_id
       LEFT JOIN properties p ON p.id = l.property_id
       LEFT JOIN branches b ON b.id = l.branch_id
      WHERE l.entry_id = :id ORDER BY l.position, l.id`,
    { replacements: { id: entry.id }, type: QueryTypes.SELECT },
  );
  res.json({ data: { ...entry, lines } });
});

/**
 * A manual journal (ACC-2.5).
 *
 * The only way a person writes directly into the books, and the reason it has
 * a permission of its own. Everything else in the ledger is a consequence of a
 * business event; this is somebody asserting something the system cannot know.
 */
const createManualJournal = asyncHandler(async (req, res) => {
  const companyId = req.user?.isSuperiorAdmin
    ? (req.body.company_id ?? null)
    : (req.user?.company_id ?? null);

  const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
  if (lines.length < 2) {
    return res.status(400).json({ message: 'A journal needs at least two lines.' });
  }
  if (!req.body.entry_date) {
    return res.status(400).json({ message: 'A journal needs the date it belongs to.' });
  }

  try {
    const result = await sequelize.transaction((transaction) => ledger.post(sequelize, {
      companyId,
      entryDate: req.body.entry_date,
      source: 'manual',
      sourceId: null,
      memo: req.body.memo || null,
      createdBy: req.user?.id ?? null,
      lines,
    }, { transaction }));
    return res.status(201).json({ data: result });
  } catch (error) {
    // The balance refusal and the shape refusals carry a status and a message
    // written for the person who typed the journal; pass them straight through.
    if (error.status) return res.status(error.status).json({ message: error.message });
    throw error;
  }
});

/** Reversing an entry — the only correction there is (ACC-2.4). */
const reverseJournalEntry = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const [entry] = await sequelize.query(
    `SELECT id FROM journal_entries WHERE id = :id ${companyId ? 'AND company_id = :companyId' : ''} LIMIT 1`,
    { replacements: { id: req.params.id, companyId }, type: QueryTypes.SELECT },
  );
  if (!entry) return res.status(404).json({ message: 'Journal entry not found' });

  const reason = String(req.body.reason || '').trim();
  if (!reason) {
    return res.status(400).json({
      message: 'Say why this is being reversed. It stays on the record beside the entry.',
    });
  }

  /*
   * `entry_date` is offered but rarely passed: a reversal is dated with the
   * entry it reverses by default, which is where it belongs. It is worth
   * being able to override when the original month is closed and reopening it
   * is not the right answer.
   */
  const result = await sequelize.transaction((transaction) => ledger.reverse(sequelize, entry.id, {
    reason,
    createdBy: req.user?.id ?? null,
    entryDate: req.body.entry_date || null,
    transaction,
  })).catch((error) => error);

  if (result instanceof Error) {
    return res.status(result.status || 500).json({ message: result.message });
  }
  res.status(201).json({ data: result });
});

/**
 * A journal from a CSV (ACC-4.6).
 *
 * How a payroll bureau's monthly summary and an externally-kept depreciation
 * schedule reach the books without this platform building payroll or fixed
 * assets. Posted through exactly the same door as a manual journal, so the
 * balance rule, the idempotency key and the append-only guarantee all apply —
 * there is no second, laxer path into the ledger.
 *
 * Takes the same permission as a manual journal, because that is what it is.
 */
const importJournalCsv = asyncHandler(async (req, res) => {
  const companyId = req.user?.isSuperiorAdmin
    ? (req.body.company_id ?? null)
    : (req.user?.company_id ?? null);

  const text = typeof req.body?.csv === 'string' ? req.body.csv : '';
  if (!text.trim()) return res.status(400).json({ message: 'Send the file contents as `csv`.' });

  const parsed = parseJournalCsv(text, { defaultDate: req.body.entry_date || null });

  /*
   * Every problem at once, not the first one.
   *
   * Somebody fixing a four-hundred-row payroll journal needs the whole list;
   * returning one error and making them re-upload to find the next is how an
   * import becomes a thing people stop using.
   */
  if (parsed.errors.length) {
    return res.status(422).json({
      message: `The file was not imported. ${parsed.errors.length} problem(s) found.`,
      errors: parsed.errors,
      debit_minor: parsed.debit_minor,
      credit_minor: parsed.credit_minor,
    });
  }

  const entryDate = req.body.entry_date || parsed.date;
  if (!entryDate) {
    return res.status(400).json({
      message: 'The file has no date column, so say which date this journal belongs to.',
    });
  }

  /*
   * Dry run by default is deliberately NOT the behaviour — an import that
   * silently previewed would be an import somebody thinks they have done.
   * `?preview=true` asks for the check without the posting.
   */
  if (req.query.preview === 'true' || req.body.preview === true) {
    return res.json({
      data: {
        preview: true,
        lines: parsed.lines,
        debit_minor: parsed.debit_minor,
        credit_minor: parsed.credit_minor,
        balanced: parsed.balanced,
        entry_date: entryDate,
      },
    });
  }

  try {
    const result = await sequelize.transaction((transaction) => ledger.post(sequelize, {
      companyId,
      entryDate,
      source: 'import',
      sourceId: req.body.reference || null,
      memo: req.body.memo || parsed.memo || 'Imported journal',
      createdBy: req.user?.id ?? null,
      lines: parsed.lines,
    }, { transaction }));

    return res.status(201).json({
      data: result,
      /*
       * Named rather than silently absorbed. A line whose account code is not
       * in the chart posts to suspense — which is visible and blocks the
       * close — but the person who just imported it should be told now rather
       * than at month end.
       */
      ...(result.fell_back?.length
        ? {
          message: `Posted, but ${result.fell_back.length} line(s) had no matching account and went to suspense: `
            + `${result.fell_back.join(', ')}. Correct the chart and reverse the entry if that is wrong.`,
        }
        : {}),
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    throw error;
  }
});

/** The trial balance (ACC-5.1). */
const trialBalance = asyncHandler(async (req, res) => {
  const data = await ledger.trialBalance(sequelize, {
    companyId: companyOf(req),
    from: req.query.from || null,
    to: req.query.to || null,
  });
  /*
   * An unbalanced trial balance is returned WITH its difference rather than
   * refused — the same judgement the commission GL export makes. The person
   * asking needs the figures to find out what is wrong; a 500 tells them only
   * that something is. `balanced` is on the payload so the two cannot be
   * mistaken for each other.
   */
  res.json({ data });
});

module.exports = {
  listAccounts, createAccount, updateAccount, deactivateAccount,
  listJournal, getJournalEntry, createManualJournal, reverseJournalEntry, trialBalance,
  importJournalCsv,
};

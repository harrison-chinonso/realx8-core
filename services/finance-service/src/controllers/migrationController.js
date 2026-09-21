const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const {
  sequelize, LedgerAccount, ImportMapping, Invoice, Vendor, Bill, OpeningAttestation,
} = require('../models');
const { buildCompanyScope } = require('../utils/crudFactory');
const {
  parseChartCsv, parseOpeningBalancesCsv, parseOpenItemsCsv, TYPE_WORDS,
} = require('../../../../shared/src/accounting/migration');
const { post, forgetChart } = require('../../../../shared/src/accounting/ledger');
const { ROLE, TYPE, parentCodeOf } = require('../../../../shared/src/accounting/chart');
const { safeUploadUrl, UPLOAD_URL_MESSAGE } = require('../../../../shared/src/safeUrl');
const { nextNumber } = require('../../../../shared/src/documentSequence');

/**
 * Moving a company's books in (ACC-9).
 *
 * ── Every import is a dry run first, and that is not optional ───────────────
 *
 * `preview` is where each of these starts. Nobody imports correctly the first
 * time, and a half-committed import is worse than a refused one: it leaves a
 * company working out which rows went in, against a ledger that is now neither
 * their old books nor their new ones.
 *
 * ── The sign-off is the most important thing here ───────────────────────────
 *
 * Opening balances are the one import that decides what a company is worth on
 * the day it arrives, and every later dispute rewinds to this moment. A Realx8
 * admin attesting alone would place the liability on us for figures we have no
 * way to verify — so the tenant's own finance lead or outgoing accountant
 * attests in writing, the document is attached, and the journal will not post
 * without it.
 */

const scope = (req) => buildCompanyScope(req);

const companyOf = (req) => (req.user?.isSuperiorAdmin
  ? (req.body?.company_id ?? req.query?.company_id ?? null)
  : (req.user?.company_id ?? null));

const isPreview = (req) => req.query.preview === 'true';

/** What each package calls our five types, for the classify screen. */
const typeVocabulary = asyncHandler(async (req, res) => {
  res.json({ data: { types: Object.keys(TYPE_WORDS), words: TYPE_WORDS } });
});

// ── ACC-9.2: the chart ──────────────────────────────────────────────────────

const importChart = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const parsed = parseChartCsv(String(req.body.csv || ''), {
    typeMap: req.body.type_map || {},
  });

  if (parsed.errors.length) {
    return res.status(422).json({
      message: `Nothing was imported. ${parsed.errors.length} problem(s) found.`,
      errors: parsed.errors,
    });
  }
  if (!parsed.records.length) {
    return res.status(422).json({ message: 'The file has no accounts in it.' });
  }

  const existing = await LedgerAccount.findAll({
    where: { ...scope(req) }, attributes: ['code'],
  });
  const have = new Set(existing.map((row) => String(row.code)));

  const fresh = parsed.records.filter((row) => !have.has(row.code));
  const clashes = parsed.records.filter((row) => have.has(row.code));

  const summary = {
    read: parsed.records.length,
    to_create: fresh.length,
    already_present: clashes.length,
    /*
     * ACC-9.6. Accounts whose type this could not be sure of. Not errors —
     * the file is fine and somebody simply has to say what "Nominal Group 4"
     * means — but the import is refused until they do, because an account
     * classified wrongly puts a liability in the assets and produces a balance
     * sheet that balances while describing a different company.
     */
    unclassified: parsed.unclassified.map((row) => ({
      code: row.code, name: row.name, source_type: row.source_type,
    })),
    clashing_codes: clashes.map((row) => row.code).slice(0, 20),
  };

  if (isPreview(req)) return res.json({ data: summary });

  if (summary.unclassified.length) {
    return res.status(422).json({
      message: `${summary.unclassified.length} account(s) have a type nobody here can be sure of. `
        + 'Classify them and import again — guessing would put a liability in the assets.',
      data: summary,
    });
  }
  if (!fresh.length) {
    return res.status(409).json({ message: 'Every account in the file is already here.', data: summary });
  }

  await LedgerAccount.bulkCreate(fresh.map((row) => ({
    company_id: companyId,
    code: row.code,
    name: row.name,
    type: row.type,
    role: null,
    /*
     * The source's own parent where it gave one; otherwise our own convention.
     * Never a role: roles name the accounts the POSTING RULES must find, and
     * an imported account claiming one would silently redirect postings that
     * belong to the seeded chart.
     */
    parent_code: row.parent_code || parentCodeOf(row.code),
    is_active: true,
    is_system: false,
  })));
  forgetChart(companyId);

  if (req.body.source && req.body.save_mapping !== false) {
    await ImportMapping.findOrCreate({
      where: { company_id: companyId, kind: 'chart_of_accounts', source: String(req.body.source) },
      defaults: {
        company_id: companyId,
        kind: 'chart_of_accounts',
        source: String(req.body.source),
        columns: Object.fromEntries(
          Object.entries(parsed.mapping)
            .filter(([, index]) => index !== null)
            .map(([field, index]) => [field, parsed.header[index]]),
        ),
        type_map: req.body.type_map || null,
        created_by: req.user?.id ?? null,
      },
    });
  }

  return res.status(201).json({
    data: summary,
    message: `${fresh.length} account(s) created`
      + (clashes.length ? `, ${clashes.length} already here and left alone.` : '.'),
  });
});

// ── ACC-9.3: opening balances ───────────────────────────────────────────────

const importOpeningBalances = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const parsed = parseOpeningBalancesCsv(String(req.body.csv || ''));

  if (parsed.errors.length) {
    return res.status(422).json({
      message: `Nothing was imported. ${parsed.errors.length} problem(s) found.`,
      errors: parsed.errors,
    });
  }
  if (!parsed.records.length) {
    return res.status(422).json({ message: 'The file has no balances in it.' });
  }

  const accounts = await LedgerAccount.findAll({ where: { ...scope(req) } });
  const byCode = new Map(accounts.map((row) => [String(row.code), row]));
  const unknown = parsed.records.filter((row) => !byCode.has(row.code));

  const summary = {
    read: parsed.records.length,
    debit_minor: parsed.debit_minor,
    credit_minor: parsed.credit_minor,
    difference_minor: parsed.difference_minor,
    balanced: parsed.balanced,
    unknown_codes: unknown.map((row) => row.code).slice(0, 20),
    as_at: req.body.as_at || null,
    /*
     * Where the file does not balance, the difference goes to suspense rather
     * than being absorbed into opening balance equity. The period-close
     * checklist refuses to close a month with anything in suspense, which is
     * the pressure that gets it corrected instead of forgotten.
     */
    to_suspense_minor: parsed.balanced ? 0 : Math.abs(parsed.difference_minor),
  };

  if (isPreview(req)) return res.json({ data: summary });

  if (unknown.length) {
    return res.status(422).json({
      message: `${unknown.length} account code(s) in the file are not in the chart. `
        + 'Import the chart first, or correct the codes.',
      data: summary,
    });
  }
  if (!req.body.as_at) {
    return res.status(400).json({ message: 'Say the date these were the balances on.' });
  }

  /*
   * ACC-9.3b — the two-sided sign-off.
   *
   * An admin permission gates this endpoint. Separately, the TENANT'S own
   * finance lead or outgoing accountant has to attest in writing that these
   * are the balances they closed with, and that document is attached here. A
   * Realx8 admin attesting alone would place the liability on us for figures
   * we have no way to verify, and every later dispute rewinds to this moment.
   */
  const attestedBy = String(req.body.attested_by || '').trim();
  if (!attestedBy) {
    return res.status(422).json({
      message: 'Name the person at the company who confirms these are the balances they closed with.',
    });
  }
  if (!req.body.attestation_url) {
    return res.status(422).json({
      message: 'Attach their written confirmation. These figures decide what the company is worth '
        + 'on the day it arrives, and every later dispute comes back to them.',
    });
  }
  const attestationUrl = safeUploadUrl(req.body.attestation_url);
  if (!attestationUrl) return res.status(422).json({ message: UPLOAD_URL_MESSAGE });

  const [already] = await sequelize.query(
    `SELECT id, reference FROM journal_entries
      WHERE source = 'opening_balance'
        AND company_id ${companyId ? '= :companyId' : 'IS NULL'}
      LIMIT 1`,
    { replacements: { companyId }, type: QueryTypes.SELECT },
  );
  if (already) {
    return res.status(409).json({
      message: `Opening balances have already been posted as ${already.reference}. `
        + 'Reverse that entry before posting another set — two sets of opening balances '
        + 'would double the company.',
    });
  }

  /*
   * The contra side is opening balance equity, so imported balances never
   * masquerade as this year's trading. Derived as the residual, which is what
   * makes the entry balance by construction.
   */
  const lines = parsed.records.map((row) => ({
    account_id: byCode.get(row.code).id,
    debit_minor: row.debit_minor,
    credit_minor: row.credit_minor,
    memo: row.name || undefined,
  }));

  if (!parsed.balanced) {
    lines.push(parsed.difference_minor > 0
      ? { role: ROLE.SUSPENSE, debit_minor: 0, credit_minor: parsed.difference_minor }
      : { role: ROLE.SUSPENSE, debit_minor: -parsed.difference_minor, credit_minor: 0 });
  }

  try {
    /*
     * The journal and the sign-off, in ONE transaction.
     *
     * The first version wrote the attestation afterwards, best-effort, and
     * logged the failure — so on a schema where the write failed the opening
     * balances posted with nobody standing behind them, which is exactly what
     * ACC-9.3b exists to prevent. Either both land or neither does.
     */
    const result = await sequelize.transaction(async (transaction) => {
      const entry = await post(sequelize, {
        companyId,
        entryDate: req.body.as_at,
        source: 'opening_balance',
        sourceId: String(companyId ?? 'platform'),
        memo: `Opening balances at ${req.body.as_at}, confirmed by ${attestedBy}`,
        createdBy: req.user?.id ?? null,
        lines,
      }, { transaction });

      await OpeningAttestation.create({
        company_id: companyId,
        entry_id: entry.entry_id,
        as_at: req.body.as_at,
        attested_by: attestedBy,
        attestation_url: attestationUrl,
        posted_by: req.user?.id ?? null,
        notes: req.body.notes || null,
      }, { transaction });

      return entry;
    });

    return res.status(201).json({
      data: { ...summary, reference: result.reference },
      message: parsed.balanced
        ? `Opening balances posted as ${result.reference}, confirmed by ${attestedBy}.`
        : `Posted as ${result.reference}, with the ${summary.to_suspense_minor} minor unit `
          + 'difference in suspense. No period can close until that is cleared.',
    });
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message });
  }
});

// ── ACC-9.4: open items ─────────────────────────────────────────────────────

/**
 * The invoices and bills behind the control accounts.
 *
 * ── Why this cannot be skipped ──────────────────────────────────────────────
 *
 * A trial balance gives a receivables TOTAL. It does not say who owes it or
 * since when. Without these rows the aged receivables report is wrong from the
 * first day, the control account never reconciles to its subledger, and every
 * check that leans on that agreement is poisoned — the close checklist, the
 * statements, the audit pack.
 *
 * ── They are documents, not journals ────────────────────────────────────────
 *
 * The MONEY came in with the opening balances; these rows are the detail
 * behind that one figure. Posting them again would double the receivables, so
 * nothing here writes to the ledger — and the preview says plainly whether the
 * detail adds up to the control account it is supposed to explain.
 */
const importOpenItems = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const side = req.body.side === 'payable' ? 'payable' : 'receivable';
  const parsed = parseOpenItemsCsv(String(req.body.csv || ''), {
    dayFirst: req.body.day_first === undefined ? true : Boolean(req.body.day_first),
  });

  if (parsed.errors.length) {
    return res.status(422).json({
      message: `Nothing was imported. ${parsed.errors.length} problem(s) found.`,
      errors: parsed.errors,
    });
  }
  if (!parsed.records.length) {
    return res.status(422).json({ message: 'The file has no open items in it.' });
  }

  const role = side === 'payable' ? ROLE.ACCOUNTS_PAYABLE : ROLE.ACCOUNTS_RECEIVABLE;
  const [control] = await sequelize.query(
    `SELECT COALESCE(SUM(l.debit_minor), 0) - COALESCE(SUM(l.credit_minor), 0) AS balance
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN ledger_accounts a ON a.id = l.account_id
      WHERE a.role = :role
        AND e.company_id ${companyId ? '= :companyId' : 'IS NULL'}`,
    { replacements: { role, companyId }, type: QueryTypes.SELECT },
  );

  const controlBalance = Math.abs(Number(control?.balance || 0));
  const summary = {
    side,
    read: parsed.records.length,
    total_minor: parsed.total_minor,
    control_balance_minor: controlBalance,
    difference_minor: parsed.total_minor - controlBalance,
    /*
     * The one thing this import is FOR. A difference here means the subledger
     * will never reconcile to the control account, which is the failure ACC-9.4
     * exists to prevent — so it is reported before anything is written rather
     * than discovered at the first period close.
     */
    reconciles: parsed.total_minor === controlBalance,
    parties: [...new Set(parsed.records.map((row) => row.party))].length,
  };

  if (isPreview(req)) {
    return res.json({ data: { ...summary, items: parsed.records.slice(0, 50) } });
  }

  if (side === 'receivable') {
    const clients = await sequelize.query(
      `SELECT id, name, email FROM users
        WHERE company_id ${companyId ? '= :companyId' : 'IS NULL'}`,
      { replacements: { companyId }, type: QueryTypes.SELECT },
    );
    const byName = new Map(clients.map((row) => [String(row.name || '').toLowerCase(), row]));

    const unknown = parsed.records.filter((row) => !byName.has(row.party.toLowerCase()));
    if (unknown.length) {
      return res.status(422).json({
        message: `${unknown.length} customer(s) in the file are not on the system yet. `
          + 'Add them, or correct the names to match.',
        data: { ...summary, unknown: [...new Set(unknown.map((row) => row.party))].slice(0, 20) },
      });
    }

    const made = [];
    for (const row of parsed.records) {
      const client = byName.get(row.party.toLowerCase());
      // eslint-disable-next-line no-await-in-loop
      const invoice = await Invoice.create({
        company_id: companyId,
        invoice_id: row.reference,
        client_id: client.id,
        amount: row.gross_minor / 100,
        status: 'sent',
        type: 'property_sale',
        due_date: row.due_date || null,
        source_type: 'migration',
      });
      if (row.date) {
        // eslint-disable-next-line no-await-in-loop
        await sequelize.query(
          'UPDATE invoices SET created_at = :date WHERE id = :id',
          { replacements: { date: `${row.date} 00:00:00`, id: invoice.id }, type: QueryTypes.UPDATE },
        );
      }
      made.push(invoice.invoice_id);
    }

    return res.status(201).json({
      data: summary,
      message: `${made.length} open invoice(s) brought in`
        + (summary.reconciles
          ? ' and they agree with the receivables control account.'
          : `, but they total ${summary.total_minor} against a control account of `
            + `${controlBalance}. Aged receivables will be wrong until that is fixed.`),
    });
  }

  // ── Payables ──────────────────────────────────────────────────────────────
  const vendors = await Vendor.findAll({ where: { ...scope(req) } });
  const byName = new Map(vendors.map((row) => [String(row.name || '').toLowerCase(), row]));

  const made = [];
  for (const row of parsed.records) {
    let vendor = byName.get(row.party.toLowerCase());
    if (!vendor) {
      /*
       * A supplier that does not exist yet is CREATED, unlike a customer.
       * A customer is a person with a login, a history and possibly a realtor
       * who introduced them — inventing one would be inventing a relationship.
       * A vendor is a name and bank details, and the name is in the file.
       */
      // eslint-disable-next-line no-await-in-loop
      vendor = await Vendor.create({
        company_id: companyId, name: row.party, created_by: req.user?.id ?? null,
      });
      byName.set(row.party.toLowerCase(), vendor);
    }

    // eslint-disable-next-line no-await-in-loop
    const reference = await nextNumber(sequelize, {
      docType: 'bills', table: 'bills', field: 'reference', prefix: 'BILL-', companyId,
    });
    // eslint-disable-next-line no-await-in-loop
    await Bill.create({
      company_id: companyId,
      reference,
      vendor_reference: row.reference,
      vendor_id: vendor.id,
      type: 'bill',
      net_minor: row.gross_minor,
      paid_minor: row.paid_minor,
      bill_date: row.date || req.body.as_at || new Date().toISOString().slice(0, 10),
      due_date: row.due_date || null,
      /*
       * Approved on arrival, and deliberately NOT posted: the money came in
       * with the opening balances, and posting these again would double the
       * payables. They are the detail behind a figure the ledger already has.
       */
      status: 'approved',
      description: `Brought forward — ${row.reference}`,
      created_by: req.user?.id ?? null,
      approved_by: req.user?.id ?? null,
      approved_at: new Date(),
    });
    made.push(reference);
  }

  return res.status(201).json({
    data: summary,
    message: `${made.length} open bill(s) brought in`
      + (summary.reconciles
        ? ' and they agree with the payables control account.'
        : `, but they total ${summary.total_minor} against a control account of ${controlBalance}.`),
  });
});

/**
 * Where this company has got to.
 *
 * Offered as one call because the order matters and somebody arriving mid-way
 * needs to know what is done: the chart, then the balances, then the open
 * items. Doing them out of order produces errors that read like file problems.
 */
const migrationStatus = asyncHandler(async (req, res) => {
  const companyId = req.user?.isSuperiorAdmin
    ? (req.query.company_id ?? null) : (req.user?.company_id ?? null);

  const [accounts] = await sequelize.query(
    `SELECT COUNT(*) AS n FROM ledger_accounts
      WHERE company_id ${companyId ? '= :companyId' : 'IS NULL'}`,
    { replacements: { companyId }, type: QueryTypes.SELECT },
  );
  const [opening] = await sequelize.query(
    `SELECT id, reference, entry_date FROM journal_entries
      WHERE source = 'opening_balance'
        AND company_id ${companyId ? '= :companyId' : 'IS NULL'}
      ORDER BY id DESC LIMIT 1`,
    { replacements: { companyId }, type: QueryTypes.SELECT },
  );
  const [invoices] = await sequelize.query(
    `SELECT COUNT(*) AS n FROM invoices
      WHERE source_type = 'migration'
        AND company_id ${companyId ? '= :companyId' : 'IS NULL'}`,
    { replacements: { companyId }, type: QueryTypes.SELECT },
  );
  const [suspense] = await sequelize.query(
    `SELECT COALESCE(SUM(l.debit_minor), 0) - COALESCE(SUM(l.credit_minor), 0) AS balance
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN ledger_accounts a ON a.id = l.account_id
      WHERE a.role = :role
        AND e.company_id ${companyId ? '= :companyId' : 'IS NULL'}`,
    { replacements: { role: ROLE.SUSPENSE, companyId }, type: QueryTypes.SELECT },
  );

  res.json({
    data: {
      accounts: Number(accounts?.n || 0),
      opening_balances: opening || null,
      migrated_invoices: Number(invoices?.n || 0),
      suspense_minor: Number(suspense?.balance || 0),
      types: Object.values(TYPE),
    },
  });
});

module.exports = {
  typeVocabulary,
  importChart,
  importOpeningBalances,
  importOpenItems,
  migrationStatus,
};

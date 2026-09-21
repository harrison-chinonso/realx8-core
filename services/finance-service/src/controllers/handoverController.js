const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize, Handover, Invoice } = require('../models');
const { buildCompanyScope } = require('../utils/crudFactory');
const { nextNumber } = require('../../../../shared/src/documentSequence');
const { postEvent } = require('../../../../shared/src/accounting/posting');
const { reverse } = require('../../../../shared/src/accounting/ledger');
const { ROLE } = require('../../../../shared/src/accounting/chart');
const { safeUploadUrl, UPLOAD_URL_MESSAGE } = require('../../../../shared/src/safeUrl');
const { releaseForUnit, policyFor } = require('../services/developmentCost');

/**
 * Handover: the moment a sale becomes revenue (ACC-8).
 *
 * ── What was wrong before this existed ──────────────────────────────────────
 *
 * The platform could say when an invoice was raised and when money arrived,
 * and neither of those is when a developer earns an off-plan sale. Under IFRS
 * 15 revenue follows CONTROL, and for a unit sold on a 24-month plan control
 * passes on handover — years after the invoice and often months after the last
 * payment. Every revenue figure the platform produced before this event was
 * really a figure about paperwork.
 *
 * ── Revenue and its cost, in one entry ──────────────────────────────────────
 *
 * Handover releases the deferred revenue AND the unit's share of what the
 * project cost to build, as a single journal. They cannot be split across two
 * postings, because a system that deferred revenue while costs hit the P&L as
 * contractors were paid would report eighteen months of losses and then a
 * month of pure margin. That is a worse answer than recognising everything on
 * the invoice date, since it is wrong in a way that looks deliberate.
 *
 * ── The acknowledgement gates the posting, not the record ───────────────────
 *
 * A handover can be recorded without the buyer's signed acknowledgement — the
 * event happened, and pretending otherwise would just move the lie. What it
 * cannot do without the document is MOVE REVENUE. That is the version of
 * "required" that survives a busy quarter, because the thing somebody wants
 * is the recognition and the document is what it costs.
 */

const scope = (req) => buildCompanyScope(req);

const companyOf = (req) => (req.user?.isSuperiorAdmin
  ? (req.body?.company_id ?? req.query?.company_id ?? null)
  : (req.user?.company_id ?? null));

/**
 * What is still sitting in contract liability for one invoice.
 *
 * Read from the journal rather than from the invoice, because the journal is
 * where the deferral actually happened — an invoice raised before the company
 * started posting has nothing deferred, however much it says it is worth, and
 * recognising against it would credit revenue out of nothing.
 */
const deferredFor = async (sequelize_, { companyId, invoiceId }) => {
  const [row] = await sequelize_.query(
    `SELECT COALESCE(SUM(l.credit_minor), 0) - COALESCE(SUM(l.debit_minor), 0) AS deferred
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN ledger_accounts a ON a.id = l.account_id
      WHERE a.role = :role
        AND e.source = 'invoice'
        AND e.source_id = :invoiceId
        AND e.company_id ${companyId ? '= :companyId' : 'IS NULL'}`,
    {
      replacements: {
        role: ROLE.CONTRACT_LIABILITY, invoiceId: String(invoiceId), companyId: companyId ?? null,
      },
      type: QueryTypes.SELECT,
    },
  );
  const raised = Number(row?.deferred || 0);

  const [taken] = await sequelize_.query(
    `SELECT COALESCE(SUM(revenue_recognised_minor), 0) AS taken
       FROM handovers
      WHERE invoice_id = :invoiceId AND status = 'recorded'
        AND company_id ${companyId ? '= :companyId' : 'IS NULL'}`,
    { replacements: { invoiceId, companyId: companyId ?? null }, type: QueryTypes.SELECT },
  );

  return Math.max(raised - Number(taken?.taken || 0), 0);
};

/** The unit an invoice is for, which lives on the payment plan rather than the invoice. */
const unitOf = async (sequelize_, invoiceId) => {
  const [row] = await sequelize_.query(
    `SELECT property_unit_id FROM invoice_payment_plans
      WHERE invoice_id = :invoiceId AND property_unit_id IS NOT NULL
      ORDER BY id LIMIT 1`,
    { replacements: { invoiceId }, type: QueryTypes.SELECT },
  );
  return row?.property_unit_id ?? null;
};

const listHandovers = asyncHandler(async (req, res) => {
  const companyId = req.user?.isSuperiorAdmin
    ? (req.query.company_id ?? null) : (req.user?.company_id ?? null);

  const rows = await sequelize.query(
    `SELECT h.*, i.invoice_id AS invoice_reference, u.name AS client_name,
            p.name AS property_name, pu.name AS unit_name
       FROM handovers h
       LEFT JOIN invoices i ON i.id = h.invoice_id
       LEFT JOIN users u ON u.id = h.client_id
       LEFT JOIN properties p ON p.id = h.property_id
       LEFT JOIN property_units pu ON pu.id = h.property_unit_id
      WHERE h.company_id ${companyId ? '= :companyId' : 'IS NULL'}
        ${req.query.property_id ? 'AND h.property_id = :propertyId' : ''}
      ORDER BY h.handover_date DESC, h.id DESC
      LIMIT 500`,
    {
      replacements: { companyId, propertyId: req.query.property_id },
      type: QueryTypes.SELECT,
    },
  );
  res.json({ data: rows });
});

/**
 * Contract liability by the invoice that raised it.
 *
 * ── Why this is not a join ──────────────────────────────────────────────────
 *
 * `journal_entries.source_id` is TEXT, because not every source has a numeric
 * id — a cost catch-up is keyed by project and date. Joining it to
 * `invoices.id` therefore needs a cast, and on MySQL a cast produces a
 * different collation from the stored column: "Illegal mix of collations",
 * which is a runtime failure on the live database and silent in most tests.
 * Casting the other way is worse, because on Postgres a non-numeric source_id
 * would make the whole query throw.
 *
 * So the match happens in JavaScript. The set is small — invoices with revenue
 * still deferred — and two simple queries that cannot fail on either engine
 * beat one clever one that fails on both for different reasons.
 */
const deferredBySource = async (companyId) => {
  const rows = await sequelize.query(
    `SELECT e.source_id AS source_id,
            COALESCE(SUM(l.credit_minor), 0) - COALESCE(SUM(l.debit_minor), 0) AS raised
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN ledger_accounts a ON a.id = l.account_id
      WHERE a.role = 'CONTRACT_LIABILITY'
        AND e.source = 'invoice'
        AND e.company_id ${companyId ? '= :companyId' : 'IS NULL'}
      GROUP BY e.source_id`,
    { replacements: { companyId }, type: QueryTypes.SELECT },
  );
  return new Map(rows.map((row) => [String(row.source_id), Number(row.raised) || 0]));
};

/** What each invoice has already had recognised against it. */
const recognisedByInvoice = async (companyId) => {
  const rows = await sequelize.query(
    `SELECT invoice_id, COALESCE(SUM(revenue_recognised_minor), 0) AS taken
       FROM handovers
      WHERE status = 'recorded'
        AND company_id ${companyId ? '= :companyId' : 'IS NULL'}
      GROUP BY invoice_id`,
    { replacements: { companyId }, type: QueryTypes.SELECT },
  );
  return new Map(rows.map((row) => [String(row.invoice_id), Number(row.taken) || 0]));
};

/** The invoices behind a set of ids, with the names a person reads. */
const invoicesByIds = async (ids) => {
  if (!ids.length) return [];
  return sequelize.query(
    `SELECT i.id, i.invoice_id AS reference, i.client_id, i.property_id, i.amount,
            u.name AS client_name, p.name AS property_name,
            ipp.property_unit_id, pu.name AS unit_name
       FROM invoices i
       LEFT JOIN users u ON u.id = i.client_id
       LEFT JOIN properties p ON p.id = i.property_id
       LEFT JOIN invoice_payment_plans ipp ON ipp.invoice_id = i.id
       LEFT JOIN property_units pu ON pu.id = ipp.property_unit_id
      WHERE i.id IN (:ids)
      ORDER BY i.id DESC`,
    { replacements: { ids }, type: QueryTypes.SELECT },
  );
};

/** The balance on the contract liability control account. */
const contractLiabilityBalance = async (companyId) => {
  const [row] = await sequelize.query(
    `SELECT COALESCE(SUM(l.credit_minor), 0) - COALESCE(SUM(l.debit_minor), 0) AS balance
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN ledger_accounts a ON a.id = l.account_id
      WHERE a.role = 'CONTRACT_LIABILITY'
        AND e.company_id ${companyId ? '= :companyId' : 'IS NULL'}`,
    { replacements: { companyId }, type: QueryTypes.SELECT },
  );
  return Number(row?.balance || 0);
};

/** Deferred revenue per invoice: raised, recognised, and what is left. */
const openDeferred = async (companyId) => {
  const [raised, taken] = await Promise.all([
    deferredBySource(companyId), recognisedByInvoice(companyId),
  ]);
  const ids = [...raised.keys()].filter((id) => /^\d+$/.test(id)).map(Number);
  const invoices = await invoicesByIds(ids);

  return invoices.map((invoice) => {
    const raisedMinor = raised.get(String(invoice.id)) || 0;
    const recognisedMinor = taken.get(String(invoice.id)) || 0;
    return {
      ...invoice,
      raised_minor: raisedMinor,
      recognised_minor: recognisedMinor,
      deferred_minor: raisedMinor - recognisedMinor,
    };
  });
};

/**
 * Invoices that could be handed over: a property sale with revenue still
 * deferred and no handover recorded against it.
 *
 * Offered as a list rather than asking somebody to type an invoice number,
 * because the set is small, knowable, and every item in it is money waiting
 * to be recognised — which is exactly the queue a finance team wants to see.
 */
const awaitingHandover = asyncHandler(async (req, res) => {
  const companyId = req.user?.isSuperiorAdmin
    ? (req.query.company_id ?? null) : (req.user?.company_id ?? null);

  const open = (await openDeferred(companyId)).filter((row) => row.deferred_minor > 0);
  if (!open.length) return res.json({ data: [] });

  const handed = await sequelize.query(
    `SELECT DISTINCT invoice_id FROM handovers
      WHERE status = 'recorded' AND invoice_id IN (:ids)`,
    { replacements: { ids: open.map((row) => row.id) }, type: QueryTypes.SELECT },
  );
  const done = new Set(handed.map((row) => Number(row.invoice_id)));

  res.json({ data: open.filter((row) => !done.has(Number(row.id))) });
});

/**
 * The recognition itself — deferred revenue out, revenue in, cost of sales up,
 * work in progress down. One entry.
 *
 * Shared by recording and by attaching the acknowledgement afterwards, so
 * there is exactly one place that decides what a handover posts.
 */
const recogniseFor = async (req, handover, invoice) => {
  const companyId = handover.company_id;

  if (!handover.acknowledgement_url) {
    return {
      posted: false,
      message: 'Recorded. Revenue will not move until the buyer\'s signed acknowledgement is attached — '
        + 'it is the document an auditor asks for when they ask why revenue moved.',
    };
  }

  const [deferred, release, policy] = await Promise.all([
    deferredFor(sequelize, { companyId, invoiceId: handover.invoice_id }),
    releaseForUnit(sequelize, {
      companyId, propertyId: handover.property_id, unitId: handover.property_unit_id,
    }),
    policyFor(sequelize, { companyId, propertyId: handover.property_id }),
  ]);

  /*
   * A sale recognised on invoice has nothing deferred, and that is not an
   * error — the revenue was taken at the tax point and this event is here for
   * the cost release, the defect-liability clock and the record. The rule
   * drops the empty legs, so the entry is the cost pair alone.
   */
  if (!deferred && !release.cost_minor) {
    return {
      posted: false,
      message: policy.revenue_recognition === 'ON_INVOICE'
        ? 'Recorded. This property recognises revenue when it is invoiced, so there was nothing deferred to release, '
          + 'and nothing has been capitalised against the project to charge.'
        : 'Recorded, but nothing posted: this sale has no deferred revenue in the ledger and the project has no capitalised cost.',
    };
  }

  const result = await postEvent(sequelize, {
    rule: 'handover',
    companyId,
    entryDate: handover.handover_date,
    source: 'handover',
    sourceId: String(handover.id),
    memo: `${handover.reference} — ${invoice?.invoice_id || `invoice ${handover.invoice_id}`}`,
    createdBy: req.user?.id ?? null,
    input: {
      revenueMinor: deferred,
      costMinor: release.cost_minor,
      dimensions: {
        property_id: handover.property_id ?? null,
        party_id: handover.client_id ?? null,
        party_type: 'client',
      },
    },
  });

  if (result?.skipped) {
    return {
      posted: false,
      message: result.skipped === 'posting_disabled'
        ? 'Recorded. This company is not posting to the ledger yet, so nothing was recognised.'
        : `Recorded, but nothing posted (${result.skipped}).`,
    };
  }

  /*
   * What was actually posted, kept on the row. The pool this cost was a share
   * of keeps moving as later bills land, so without the figure recorded here
   * the catch-up in ACC-10.4 has nothing to measure against.
   */
  await handover.update({
    revenue_recognised_minor: deferred,
    cost_released_minor: release.cost_minor,
  });

  return {
    posted: true,
    message: `Recognised ${deferred} and charged ${release.cost_minor} to cost of sales.`,
    entry: result?.reference ?? null,
  };
};

/**
 * Record a handover, and recognise against it.
 *
 * The two happen together where the acknowledgement is present. Where it is
 * not, the row is written and the posting is refused with a message saying
 * which document is missing — and attaching it later posts, through the same
 * endpoint, because a handover recorded and then evidenced is the ordinary
 * case rather than an exception.
 */
const recordHandover = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);

  const invoice = await Invoice.findOne({ where: { id: req.body.invoice_id, ...scope(req) } });
  if (!invoice) return res.status(422).json({ message: 'Choose an invoice this company raised.' });
  if (invoice.type === 'service_fee') {
    return res.status(422).json({
      message: 'A service fee has no handover — it was earned when it was invoiced.',
    });
  }
  if (!req.body.handover_date) {
    return res.status(400).json({ message: 'Say the date control actually passed, not the date you are entering it.' });
  }

  let acknowledgementUrl = null;
  if (req.body.acknowledgement_url) {
    acknowledgementUrl = safeUploadUrl(req.body.acknowledgement_url);
    if (!acknowledgementUrl) return res.status(422).json({ message: UPLOAD_URL_MESSAGE });
  }

  const [already] = await sequelize.query(
    `SELECT id, reference FROM handovers
      WHERE invoice_id = :invoiceId AND status = 'recorded'
        AND company_id ${companyId ? '= :companyId' : 'IS NULL'}
      LIMIT 1`,
    { replacements: { invoiceId: invoice.id, companyId }, type: QueryTypes.SELECT },
  );
  if (already) {
    return res.status(409).json({
      message: `This sale was already handed over on ${already.reference}. Reverse that one if it was wrong.`,
    });
  }

  const propertyUnitId = req.body.property_unit_id || await unitOf(sequelize, invoice.id);
  const reference = await nextNumber(sequelize, {
    docType: 'handovers', table: 'handovers', field: 'reference', prefix: 'HO-', companyId,
  });

  const handover = await Handover.create({
    company_id: companyId,
    reference,
    invoice_id: invoice.id,
    client_id: invoice.client_id,
    property_id: invoice.property_id,
    property_unit_id: propertyUnitId,
    handover_date: req.body.handover_date,
    acknowledgement_url: acknowledgementUrl,
    notes: req.body.notes || null,
    status: 'recorded',
    recorded_by: req.user?.id ?? null,
  });

  const posted = await recogniseFor(req, handover, invoice);
  res.status(201).json({ data: handover, ...posted });
});

/** Attach the acknowledgement to a handover already recorded, and recognise. */
const attachAcknowledgement = asyncHandler(async (req, res) => {
  const handover = await Handover.findOne({ where: { id: req.params.id, ...scope(req) } });
  if (!handover) return res.status(404).json({ message: 'Handover not found' });
  if (handover.status !== 'recorded') {
    return res.status(409).json({ message: 'This handover has been reversed.' });
  }

  const url = safeUploadUrl(req.body.acknowledgement_url);
  if (!url) return res.status(422).json({ message: UPLOAD_URL_MESSAGE });

  await handover.update({ acknowledgement_url: url });

  if (handover.revenue_recognised_minor || handover.cost_released_minor) {
    return res.json({ data: handover, posted: false, message: 'Document attached. This handover had already been recognised.' });
  }

  const invoice = await Invoice.findByPk(handover.invoice_id);
  const posted = await recogniseFor(req, handover, invoice);
  res.json({ data: handover, ...posted });
});

/**
 * ACC-8.5 — what is sitting in contract liability, and against what.
 *
 * Finance asks for this in the first week, and it is also the reconciliation
 * of the contract liability control account: the sum of the rows below must
 * equal the account's balance, and a difference means revenue was deferred
 * against something this report cannot see.
 */
const deferredRevenue = asyncHandler(async (req, res) => {
  const companyId = req.user?.isSuperiorAdmin
    ? (req.query.company_id ?? null) : (req.user?.company_id ?? null);

  const rows = (await openDeferred(companyId)).filter((row) => row.deferred_minor !== 0);
  const control = await contractLiabilityBalance(companyId);
  const total = rows.reduce((sum, row) => sum + row.deferred_minor, 0);

  res.json({
    data: {
      rows,
      total_minor: total,
      control_balance_minor: control,
      unexplained_minor: control - total,
    },
  });
});

/**
 * A handover recorded in error.
 *
 * The row goes to 'reversed' and the journal behind it is reversed by its own
 * dated entry — never edited, never deleted. Deleting it would leave revenue
 * recognised with nothing to explain it, which is the one outcome worse than
 * the mistake.
 */
const reverseHandover = asyncHandler(async (req, res) => {
  const handover = await Handover.findOne({ where: { id: req.params.id, ...scope(req) } });
  if (!handover) return res.status(404).json({ message: 'Handover not found' });
  if (handover.status === 'reversed') {
    return res.status(409).json({ message: 'This handover has already been reversed.' });
  }
  const reason = String(req.body.reason || '').trim();
  if (!reason) {
    return res.status(400).json({ message: 'Say why. Revenue moving back needs a reason somebody can read.' });
  }

  const [entry] = await sequelize.query(
    `SELECT id FROM journal_entries
      WHERE source = 'handover' AND source_id = :id
        AND company_id ${handover.company_id ? '= :companyId' : 'IS NULL'}
      ORDER BY id DESC LIMIT 1`,
    {
      replacements: { id: String(handover.id), companyId: handover.company_id },
      type: QueryTypes.SELECT,
    },
  );

  let reversalReference = null;
  if (entry) {
    const reversal = await reverse(sequelize, entry.id, {
      reason, createdBy: req.user?.id ?? null,
    }).catch((error) => {
      console.error(`[accounting] handover ${handover.reference} reversal failed: ${error.message}`);
      return null;
    });
    reversalReference = reversal?.reference ?? null;
  }

  await handover.update({
    status: 'reversed',
    reversal_reason: reason,
    reversed_by: req.user?.id ?? null,
    reversed_at: new Date(),
  });

  res.json({
    data: handover,
    message: reversalReference
      ? `Reversed. Journal ${reversalReference} puts the revenue and the cost back.`
      : 'Reversed. There was no journal behind it to put back.',
  });
});

module.exports = {
  listHandovers,
  awaitingHandover,
  recordHandover,
  attachAcknowledgement,
  deferredRevenue,
  reverseHandover,
};

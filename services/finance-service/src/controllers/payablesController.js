const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const {
  sequelize, Vendor, Bill, LedgerAccount,
} = require('../models');
const { buildCompanyScope } = require('../utils/crudFactory');
const { nextNumber } = require('../../../../shared/src/documentSequence');
const { asMinor, toMajor } = require('../../../../shared/src/money');
const { postEvent } = require('../../../../shared/src/accounting/posting');
const { ROLE } = require('../../../../shared/src/accounting/chart');
const { safeUploadUrl, UPLOAD_URL_MESSAGE } = require('../../../../shared/src/safeUrl');

/**
 * Money going out: vendors, bills and what is owed on them (ACC-4).
 *
 * ── The half of the books that did not exist ────────────────────────────────
 *
 * Realx8 knew everything about money coming in and almost nothing about money
 * going out — every naira that left did so as a commission payout or, until
 * ACC-0, as a debit note wearing the wrong name. A P&L with no cost side is
 * not a P&L, and for a developer the cost side is most of the story.
 *
 * ── Raised, approved, paid — and each step means something different ────────
 *
 * Raising records what a vendor says they are owed. Approving commits the
 * company to it and is the moment the payable and the expense are posted.
 * Paying moves the money. Collapsing any two of them removes the only point
 * at which somebody checks a contractor's invoice against what was actually
 * delivered.
 */

const scope = (req) => buildCompanyScope(req);

const companyOf = (req) => (req.user?.isSuperiorAdmin
  ? (req.body?.company_id ?? req.query?.company_id ?? null)
  : (req.user?.company_id ?? null));

// ── Vendors (ACC-4.1) ───────────────────────────────────────────────────────

const listVendors = asyncHandler(async (req, res) => {
  const where = { ...scope(req) };
  if (req.query.active === 'true') where.is_active = true;
  const rows = await Vendor.findAll({ where, order: [['name', 'ASC']] });
  res.json({ data: rows });
});

const createVendor = asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ message: 'A vendor needs a name.' });

  const vendor = await Vendor.create({
    ...req.body,
    name,
    company_id: companyOf(req),
    created_by: req.user?.id ?? null,
  });
  res.status(201).json({ data: vendor });
});

const updateVendor = asyncHandler(async (req, res) => {
  const vendor = await Vendor.findOne({ where: { id: req.params.id, ...scope(req) } });
  if (!vendor) return res.status(404).json({ message: 'Vendor not found' });
  await vendor.update({ ...req.body, id: vendor.id, company_id: vendor.company_id });
  res.json({ data: vendor });
});

// ── Bills (ACC-4.2) ─────────────────────────────────────────────────────────

const listBills = asyncHandler(async (req, res) => {
  const companyId = req.user?.isSuperiorAdmin ? (req.query.company_id ?? null) : (req.user?.company_id ?? null);
  const filters = [];
  const replacements = { companyId };
  if (req.query.status) { filters.push('AND b.status = :status'); replacements.status = req.query.status; }
  if (req.query.vendor_id) { filters.push('AND b.vendor_id = :vendorId'); replacements.vendorId = req.query.vendor_id; }
  if (req.query.property_id) { filters.push('AND b.property_id = :propertyId'); replacements.propertyId = req.query.property_id; }

  const rows = await sequelize.query(
    `SELECT b.*, v.name AS vendor_name, a.code AS account_code, a.name AS account_name
       FROM bills b
       LEFT JOIN vendors v ON v.id = b.vendor_id
       LEFT JOIN ledger_accounts a ON a.id = b.account_id
      WHERE b.company_id ${companyId ? '= :companyId' : 'IS NULL'} ${filters.join(' ')}
      ORDER BY b.bill_date DESC, b.id DESC
      LIMIT 500`,
    { replacements, type: QueryTypes.SELECT },
  );
  res.json({ data: rows });
});

const createBill = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);

  const vendor = await Vendor.findOne({ where: { id: req.body.vendor_id, ...scope(req) } });
  if (!vendor) return res.status(422).json({ message: 'Choose a vendor this company has on its books.' });

  const net = asMinor(req.body.net_minor);
  if (!(net > 0)) return res.status(400).json({ message: 'A bill needs an amount.' });
  if (!req.body.bill_date) return res.status(400).json({ message: 'A bill needs the date the vendor raised it.' });

  /*
   * The vendor's invoice, through the ordinary upload guard.
   *
   * A supplier bill is the document an auditor asks to see, and a link typed
   * in by hand is one nobody else can open — the same reasoning that gates a
   * KYC document and a proof of payment.
   */
  let documentUrl = null;
  if (req.body.document_url) {
    documentUrl = safeUploadUrl(req.body.document_url);
    if (!documentUrl) return res.status(422).json({ message: UPLOAD_URL_MESSAGE });
  }

  /*
   * Withholding defaults to the vendor's own rate.
   *
   * Nigerian WHT is 5% on most services and 10% on others, and a developer
   * pays both — so the rate belongs to the vendor rather than to the company.
   * A bill may still state its own figure, because an invoice occasionally
   * disagrees with the standing rate and the invoice is the document.
   */
  const rate = Number(vendor.withholding_rate) || 0;
  const withholding = req.body.withholding_minor !== undefined
    ? asMinor(req.body.withholding_minor)
    : Math.round((net * rate) / 100);

  const reference = await nextNumber(sequelize, {
    docType: 'bills', table: 'bills', field: 'reference', prefix: 'BILL-', companyId,
  });

  const bill = await Bill.create({
    company_id: companyId,
    reference,
    vendor_reference: req.body.vendor_reference || null,
    vendor_id: vendor.id,
    type: req.body.type === 'credit_note' ? 'credit_note' : 'bill',
    capitalise: Boolean(req.body.capitalise),
    net_minor: net,
    tax_minor: asMinor(req.body.tax_minor || 0),
    withholding_minor: Math.min(Math.max(withholding, 0), net),
    account_id: req.body.account_id || null,
    property_id: req.body.property_id || null,
    branch_id: req.body.branch_id || null,
    description: req.body.description || null,
    document_url: documentUrl,
    bill_date: req.body.bill_date,
    due_date: req.body.due_date || null,
    status: 'pending_approval',
    created_by: req.user?.id ?? null,
  });

  res.status(201).json({ data: bill });
});

/**
 * Which account a bill's expense lands in.
 *
 * The account chosen on the bill wins. Where none was chosen it falls to cost
 * of sales, and where the cost capitalises it goes to development WIP instead
 * — ACC-10's rule, honoured here so that when the expense types arrive the
 * posting does not have to move.
 */
const expenseRoleFor = async (bill) => {
  if (bill.capitalise) return ROLE.DEVELOPMENT_WIP;
  if (bill.account_id) {
    const account = await LedgerAccount.findByPk(bill.account_id);
    if (account) return account.role || account.code;
  }
  return ROLE.COST_OF_SALES;
};

const approveBill = asyncHandler(async (req, res) => {
  const bill = await Bill.findOne({ where: { id: req.params.id, ...scope(req) } });
  if (!bill) return res.status(404).json({ message: 'Bill not found' });

  if (bill.status !== 'pending_approval') {
    return res.status(409).json({
      message: `This bill is ${bill.status.replace(/_/g, ' ')}, so it cannot be approved again.`,
    });
  }
  /*
   * Not your own. The person who raised a payable should not be the one who
   * commits the company to paying it — the same separation every other
   * approval in this codebase keeps.
   */
  if (Number(bill.created_by) === Number(req.user?.id) && !req.user?.isSuperiorAdmin) {
    return res.status(403).json({ message: 'You cannot approve a bill you raised yourself.' });
  }

  await bill.update({
    status: 'approved',
    approved_by: req.user?.id ?? null,
    approved_at: new Date(),
    rejection_reason: null,
  });

  /*
   * ACC-3.6. Approval is the moment the company is committed, so it is the
   * moment the expense and the payable are recognised — not when the money
   * moves, which is a later and different event.
   */
  const dimensions = {
    property_id: bill.property_id ?? null,
    branch_id: bill.branch_id ?? null,
    party_id: bill.vendor_id,
    party_type: 'vendor',
  };
  await postEvent(sequelize, {
    rule: bill.type === 'credit_note' ? 'supplier_credit_note' : 'bill',
    companyId: bill.company_id ?? null,
    entryDate: bill.bill_date,
    source: bill.type === 'credit_note' ? 'supplier_credit_note' : 'bill',
    sourceId: String(bill.id),
    memo: `${bill.reference}${bill.description ? ` — ${String(bill.description).slice(0, 160)}` : ''}`,
    createdBy: req.user?.id ?? null,
    input: {
      netMinor: bill.net_minor,
      taxMinor: bill.tax_minor,
      withholdingMinor: bill.withholding_minor,
      expenseRole: await expenseRoleFor(bill),
      dimensions,
    },
  });

  res.json({ data: bill });
});

const rejectBill = asyncHandler(async (req, res) => {
  const bill = await Bill.findOne({ where: { id: req.params.id, ...scope(req) } });
  if (!bill) return res.status(404).json({ message: 'Bill not found' });
  if (bill.status !== 'pending_approval') {
    return res.status(409).json({ message: `This bill is ${bill.status.replace(/_/g, ' ')}.` });
  }
  const reason = String(req.body.reason || '').trim();
  if (!reason) {
    return res.status(400).json({ message: 'Say why it is being refused. The vendor will ask.' });
  }
  await bill.update({
    status: 'rejected',
    rejection_reason: reason,
    approved_by: req.user?.id ?? null,
    approved_at: new Date(),
  });
  res.json({ data: bill });
});

/** What is left to pay on a bill: net + tax, less what was withheld and paid. */
const payableOf = (bill) => Math.max(
  asMinor(bill.net_minor) + asMinor(bill.tax_minor)
    - asMinor(bill.withholding_minor) - asMinor(bill.paid_minor),
  0,
);

const payBill = asyncHandler(async (req, res) => {
  const bill = await Bill.findOne({ where: { id: req.params.id, ...scope(req) } });
  if (!bill) return res.status(404).json({ message: 'Bill not found' });

  if (bill.status !== 'approved') {
    return res.status(409).json({
      message: bill.status === 'paid'
        ? 'This bill has already been paid.'
        : 'A bill must be approved before it can be paid.',
    });
  }

  const outstanding = payableOf(bill);
  const amount = req.body.amount_minor !== undefined ? asMinor(req.body.amount_minor) : outstanding;
  if (!(amount > 0)) return res.status(400).json({ message: 'Enter the amount being paid.' });
  if (amount > outstanding) {
    return res.status(422).json({
      message: `That is more than the ${toMajor(outstanding)} outstanding on this bill.`,
    });
  }

  await sequelize.transaction(async (transaction) => {
    const paid = asMinor(bill.paid_minor) + amount;
    await bill.update({
      paid_minor: paid,
      // A part payment keeps it approved; only the last one closes it.
      status: paid >= asMinor(bill.net_minor) + asMinor(bill.tax_minor) - asMinor(bill.withholding_minor)
        ? 'paid'
        : 'approved',
    }, { transaction });

    // The cash book, beside the ledger — the same placement every other
    // outgoing payment uses since ACC-0.6.
    await sequelize.query(
      `INSERT INTO transactions
         (user_id, type, entry_type, amount, description, payment_method, status, reference, company_id, created_at)
       VALUES (NULL, 'bill_payment', 'debit', :amount, :description, :method, 'completed', :reference, :companyId, NOW())`,
      {
        replacements: {
          amount: toMajor(amount),
          description: `Bill ${bill.reference}`,
          method: String(req.body.payment_method || 'transfer'),
          reference: String(req.body.reference || '').trim() || `${bill.reference}-PAY`,
          companyId: bill.company_id ?? null,
        },
        type: QueryTypes.INSERT,
        transaction,
      },
    ).catch((error) => {
      if (!/duplicate|unique/i.test(error.message || '')) throw error;
    });

    await postEvent(sequelize, {
      rule: 'bill_payment',
      companyId: bill.company_id ?? null,
      entryDate: new Date(),
      source: 'bill_payment',
      sourceId: `${bill.id}:${paid}`,
      memo: `Paid ${bill.reference}`,
      createdBy: req.user?.id ?? null,
      input: {
        amountMinor: amount,
        dimensions: {
          property_id: bill.property_id ?? null,
          party_id: bill.vendor_id,
          party_type: 'vendor',
        },
      },
    }, { transaction });
  });

  res.json({ data: bill });
});

/**
 * Aged payables (ACC-4.5).
 *
 * Bucketed by how long a bill has been due, which is the question somebody
 * paying suppliers actually asks — not "what do we owe" but "what is late".
 * Buckets are the conventional 30/60/90; making them configurable is ACC-5.5's
 * job and belongs with aged receivables so the two cannot disagree.
 */
const agedPayables = asyncHandler(async (req, res) => {
  const companyId = req.user?.isSuperiorAdmin ? (req.query.company_id ?? null) : (req.user?.company_id ?? null);
  const asAt = req.query.as_at || new Date().toISOString().slice(0, 10);

  const rows = await sequelize.query(
    `SELECT v.id AS vendor_id, v.name AS vendor_name,
            b.reference, b.bill_date, b.due_date,
            (b.net_minor + b.tax_minor - b.withholding_minor - b.paid_minor) AS outstanding_minor,
            DATEDIFF(:asAt, COALESCE(b.due_date, b.bill_date)) AS days_due
       FROM bills b
       LEFT JOIN vendors v ON v.id = b.vendor_id
      WHERE b.company_id ${companyId ? '= :companyId' : 'IS NULL'}
        AND b.status IN ('approved')
        AND b.${sequelize.getDialect() === 'postgres' ? '"type"' : '`type`'} = 'bill'
        AND (b.net_minor + b.tax_minor - b.withholding_minor - b.paid_minor) > 0
      ORDER BY v.name, b.bill_date`,
    { replacements: { companyId, asAt }, type: QueryTypes.SELECT },
  );

  const bucketOf = (days) => {
    if (days <= 0) return 'not_yet_due';
    if (days <= 30) return 'days_1_30';
    if (days <= 60) return 'days_31_60';
    if (days <= 90) return 'days_61_90';
    return 'days_over_90';
  };

  const byVendor = new Map();
  for (const row of rows) {
    const key = Number(row.vendor_id);
    if (!byVendor.has(key)) {
      byVendor.set(key, {
        vendor_id: key,
        vendor_name: row.vendor_name,
        not_yet_due: 0,
        days_1_30: 0,
        days_31_60: 0,
        days_61_90: 0,
        days_over_90: 0,
        total_minor: 0,
        bills: [],
      });
    }
    const line = byVendor.get(key);
    const amount = asMinor(row.outstanding_minor);
    line[bucketOf(Number(row.days_due) || 0)] += amount;
    line.total_minor += amount;
    line.bills.push({
      reference: row.reference,
      bill_date: row.bill_date,
      due_date: row.due_date,
      outstanding_minor: amount,
      days_due: Number(row.days_due) || 0,
    });
  }

  const vendors = [...byVendor.values()].sort((a, b) => b.total_minor - a.total_minor);
  res.json({
    data: {
      as_at: asAt,
      vendors,
      total_minor: vendors.reduce((sum, v) => sum + v.total_minor, 0),
    },
  });
});

module.exports = {
  listVendors, createVendor, updateVendor,
  listBills, createBill, approveBill, rejectBill, payBill, agedPayables,
};

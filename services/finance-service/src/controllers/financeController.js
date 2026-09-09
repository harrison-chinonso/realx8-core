const crypto = require('crypto');
const { fn, col, Op, QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { buildCrudController, buildCompanyScope, withCompanyAudit } = require('../utils/crudFactory');
const {
  Invoice, InvoicePayment, InvoiceProduct, Transaction, Tax, PaymentPlan,
  BankAccount, CreditNote, DebitNote, PaymentReminder, Commission,
  CommissionRule, Receipt,
  ReferralSetting, ReferralTransaction,
} = require('../models');
const { sequelize } = require('../models');
const { createNotifier } = require('../../../../shared/src/notifier');
const { resolveViewableUser } = require('../../../../shared/src/viewerAccess');
const { appUrl } = require('../../../../shared/src/appOrigin');
const { GATEWAYS, paymentSettingsFor } = require('../utils/paymentGateways');
const { notifyUser, findRealtorForClient } = createNotifier(sequelize);

const companyScope = (req) => buildCompanyScope(req);

/**
 * The profile the caller is ACTING as. A dual-profile user switched to their
 * client profile must be scoped as a client even though users.type says realtor.
 */
const actingType = (req) => req.user?.effectiveType || req.user?.type;

/**
 * Clients and realtors see only their own money. Everyone else (staff of any
 * kind) keeps the company-wide view they already had.
 *
 * Without this, company scope alone let any authenticated client list every
 * invoice and payment belonging to every other client in their company.
 */
const isSelfScoped = (req) => !req.user?.isSuperiorAdmin && ['client', 'realtor'].includes(actingType(req));

/**
 * Invoices are owned by the client they are billed to.
 *
 * Buyers also never see a draft: draft means "not yet issued", and until an
 * admin sends it there is nothing for the client to act on.
 */
const invoiceScope = (req) => {
  const base = companyScope(req);
  // Plain keys, deliberately: crudFactory spreads the search filter (an Op.or)
  // over this object, so an Op.or here would be silently overwritten.
  return isSelfScoped(req)
    ? { ...base, client_id: req.user.id, status: { [Op.ne]: 'draft' } }
    : base;
};

/** Transactions (payments) are owned by the user they were recorded against. */
const transactionScope = (req) => {
  const base = companyScope(req);
  return isSelfScoped(req) ? { ...base, user_id: req.user.id } : base;
};

/**
 * Next reference in a prefixed sequence, e.g. INV-0007.
 *
 * Derived from the HIGHEST number in use, not from the newest row. Reading only
 * the newest row reissued a number that already existed whenever the last row
 * was deleted, or whenever any reference did not end in digits — and these
 * columns are uniquely indexed, so the insert then failed.
 */
const buildSequence = async (Model, field, prefix) => {
  const rows = await Model.findAll({ attributes: [field], raw: true });
  const highest = rows.reduce((max, row) => {
    const value = String(row?.[field] ?? '');
    if (!value.startsWith(prefix)) return max;
    const suffix = Number(value.slice(prefix.length));
    return Number.isInteger(suffix) && suffix > max ? suffix : max;
  }, 0);
  return `${prefix}${String(highest + 1).padStart(4, '0')}`;
};

const invoiceCrud = buildCrudController(Invoice, {
  include: ['payments', 'products', 'tax'], searchFields: ['invoice_id', 'status'],
  defaultWhere: invoiceScope, scopeWhere: invoiceScope,
  beforeCreate: async (req) => ({
    ...withCompanyAudit(req),
    invoice_id: await buildSequence(Invoice, 'invoice_id', 'INV-'),
  }),
  /**
   * ?status= filters the list. `due` is not a stored status but a derived
   * condition — still owing money AND past its date — matching how the payment
   * views elsewhere define it. The Invoicing menu has always linked to a "due"
   * view; nothing read the parameter, so it showed every invoice.
   */
  whereBuilder: (req) => {
    const status = String(req.query.status || '').trim();
    // crudFactory spreads this AFTER defaultWhere, so a plain `status` key here
    // would overwrite the scope's draft exclusion — letting a client ask for
    // ?status=draft and see invoices that were never issued to them. Everything
    // goes under Op.and so both conditions survive.
    const conditions = [];
    if (status === 'due') {
      conditions.push({ status: { [Op.notIn]: ['paid', 'cancelled'] }, due_date: { [Op.lt]: new Date() } });
    } else if (status) {
      conditions.push({ status });
    }
    if (isSelfScoped(req)) conditions.push({ status: { [Op.ne]: 'draft' } });
    return conditions.length ? { [Op.and]: conditions } : {};
  },

  /**
   * crudFactory hands req.body straight to entity.update, so anything the
   * caller sends lands on the row. Two things must not pass unchecked.
   */
  /**
   * An invoice with money against it is an accounting record, not a draft —
   * deleting it would orphan payments and transactions that really happened.
   * Only an unpaid invoice with no installment recorded can be removed.
   */
  beforeDelete: async (invoice) => {
    const money = await outstandingFor(invoice);
    if (money.paid > 0) {
      throw Object.assign(
        new Error('This invoice has payments recorded against it and cannot be deleted. Cancel it instead.'),
        { status: 409 },
      );
    }
    if (invoice.status === 'paid') {
      throw Object.assign(new Error('A settled invoice cannot be deleted.'), { status: 409 });
    }
  },
  beforeUpdate: async (req, invoice) => {
    const payload = { ...req.body };

    if (Object.prototype.hasOwnProperty.call(payload, 'bank_account_id')) {
      const raw = payload.bank_account_id;
      if (raw == null || raw === '') {
        payload.bank_account_id = null;
      } else {
        // The chosen account is shown to the buyer, so it must belong to the
        // invoice's own company — otherwise assigning another tenant's account
        // would publish their bank details.
        const account = await BankAccount.findOne({ where: { id: Number(raw) } });
        if (!account) throw Object.assign(new Error('That bank account does not exist.'), { status: 400 });
        if (Number(account.company_id) !== Number(invoice.company_id)) {
          throw Object.assign(new Error('That bank account belongs to another company.'), { status: 400 });
        }
        payload.bank_account_id = account.id;
      }
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'amount')) {
      // The total is fixed once money has been received against it; dropping it
      // below what is already paid would produce a negative balance.
      const [row] = await sequelize.query(
        `SELECT COALESCE(SUM(amount), 0) AS paid FROM invoice_payments
          WHERE invoice_id = :id AND status = 'completed'`,
        { replacements: { id: invoice.id }, type: QueryTypes.SELECT },
      );
      const paid = Number(row?.paid) || 0;
      if (Number(payload.amount) < paid) {
        throw Object.assign(new Error(`This invoice already has ${paid} paid against it; the total cannot be lower.`), { status: 400 });
      }
    }

    return payload;
  },
});
const taxCrud = buildCrudController(Tax, {
  searchFields: ['name'],
  defaultWhere: companyScope, scopeWhere: companyScope,
  beforeCreate: (req) => withCompanyAudit(req),
});
const transactionCrud = buildCrudController(Transaction, {
  searchFields: ['type', 'status', 'reference'],
  defaultWhere: transactionScope, scopeWhere: transactionScope,
  // ?status= / ?type= actually filter now. The Payments menu has always linked
  // to a "pending" view, but nothing read the parameter, so that page showed
  // the same unfiltered list as "All Payments".
  whereBuilder: (req) => {
    const where = {};
    const status = String(req.query.status || '').trim();
    const type = String(req.query.type || '').trim();
    if (status) where.status = status;
    if (type) where.type = type;
    return where;
  },
  beforeCreate: (req) => withCompanyAudit(req),
});
const paymentPlanCrud = buildCrudController(PaymentPlan, {
  searchFields: ['name'],
  defaultWhere: companyScope, scopeWhere: companyScope,
  beforeCreate: (req) => withCompanyAudit(req),
});
/**
 * Blank numerics arrive as '' from HTML forms, and MySQL rejects '' for a
 * DECIMAL column — which failed every save that left the opening balance out.
 * Normalise here so no caller has to remember.
 */
const normaliseBankAccount = (body) => {
  const payload = { ...body };
  if ('opening_balance' in payload) {
    const raw = String(payload.opening_balance ?? '').replace(/,/g, '').trim();
    payload.opening_balance = raw === '' ? null : Number(raw);
    if (Number.isNaN(payload.opening_balance)) payload.opening_balance = null;
  }
  return payload;
};

const bankAccountCrud = buildCrudController(BankAccount, {
  searchFields: ['name', 'bank_name', 'account_number'],
  defaultWhere: companyScope, scopeWhere: companyScope,
  beforeCreate: (req) => normaliseBankAccount(withCompanyAudit(req)),
  beforeUpdate: (req) => normaliseBankAccount(req.body),
});
const creditNoteCrud = buildCrudController(CreditNote, {
  include: ['tax'], searchFields: ['credit_note_id', 'status'],
  defaultWhere: companyScope, scopeWhere: companyScope,
  beforeCreate: async (req) => ({
    ...withCompanyAudit(req),
    credit_note_id: await buildSequence(CreditNote, 'credit_note_id', 'CN-'),
  }),
});
const debitNoteCrud = buildCrudController(DebitNote, {
  include: ['tax'], searchFields: ['debit_note_id', 'status'],
  defaultWhere: companyScope, scopeWhere: companyScope,
  beforeCreate: async (req) => ({
    ...withCompanyAudit(req),
    debit_note_id: await buildSequence(DebitNote, 'debit_note_id', 'DN-'),
  }),
});
const paymentReminderCrud = buildCrudController(PaymentReminder, {
  include: ['invoice'], searchFields: ['status'],
  defaultWhere: companyScope, scopeWhere: companyScope,
  beforeCreate: (req) => withCompanyAudit(req),
});
const commissionCrud = buildCrudController(Commission, {
  searchFields: ['title', 'type', 'status'],
  defaultWhere: companyScope, scopeWhere: companyScope,
  beforeCreate: (req) => withCompanyAudit(req),
});

/**
 * Issue an invoice to the client.
 *
 * Until this runs the invoice is a draft and the client cannot see it at all.
 * Sending both makes it visible AND tells them — the button used to only flip a
 * status, so "sent" was a claim nobody acted on.
 */
const sendInvoice = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findOne({ where: { id: req.params.id, ...companyScope(req) } });
  if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

  if (['paid', 'cancelled'].includes(invoice.status)) {
    return res.status(409).json({ message: `This invoice is already ${invoice.status}.` });
  }

  const wasDraft = invoice.status === 'draft';
  if (wasDraft) await invoice.update({ status: 'sent' });

  const money = await outstandingFor(invoice);
  const fmt = await formatMoneyFor(invoice.company_id ?? null);
  const due = invoice.due_date ? new Date(invoice.due_date).toDateString() : null;

  // Fire-and-forget: a notification failure must not undo the issue.
  notifyUser({
    userId: invoice.client_id,
    title: `Invoice ${invoice.invoice_id} is ready`,
    body: `An invoice of ${fmt(money.total)} has been issued to you.`
      + `${due ? ` It is due on ${due}.` : ''}`
      + '\n\nYou can view it and submit your payment from your invoices page.',
    type: 'invoice_sent',
    data: { invoice_id: invoice.id, amount: money.total },
    companyId: invoice.company_id ?? null,
    actionLabel: 'View invoice',
    actionUrl: appUrl(`finance/invoices/${invoice.id}`, req),
  }).catch((err) => console.error('[invoice] send notification failed:', err.message));

  res.json({
    message: wasDraft ? 'Invoice issued and the client notified.' : 'The client was notified again.',
    data: invoice,
  });
});

/** Notifies a client's realtor about a payment. Silent when no realtor resolves. */
const notifyRealtorOfPayment = async ({ invoice, amount, paidInFull, pending = false }) => {
  const [client] = await sequelize.query(
    'SELECT id, name, email FROM users WHERE id = :id LIMIT 1',
    { replacements: { id: invoice.client_id }, type: QueryTypes.SELECT },
  );
  if (!client?.email) return;

  const realtorId = await findRealtorForClient({ email: client.email, companyId: invoice.company_id });
  if (!realtorId) return;

  await notifyUser({
    userId: realtorId,
    title: pending ? 'Your client submitted a payment'
      : paidInFull ? 'Your client paid an invoice in full' : 'Your client made a payment',
    body: `${client.name || 'A client'} paid ${Number(amount).toLocaleString()} towards invoice ${invoice.invoice_id}.`
      + (paidInFull ? ' The invoice is now settled.' : ''),
    type: 'client_payment',
    data: { invoice_id: invoice.id, invoice_ref: invoice.invoice_id, amount },
    companyId: invoice.company_id,
  });
};

const payInvoice = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findOne({ where: { id: req.params.id, ...companyScope(req) }, include: ['payments'] });
  if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

  const supported = ['stripe', 'paypal', 'flutterwave', 'paystack', 'bank_transfer', 'cash'];
  if (!supported.includes(req.body.payment_method)) {
    return res.status(400).json({ message: `Unsupported payment method. Use ${supported.join(', ')}` });
  }

  const money = await outstandingFor(invoice);
  if (money.balance <= 0) {
    return res.status(409).json({ message: 'This invoice is already settled.' });
  }

  // Default to clearing the balance; clamp so a recorded payment can never
  // exceed what is owed. The invoice total is fixed at issue — only the
  // outstanding balance moves.
  const requested = req.body.amount == null || req.body.amount === ''
    ? money.balance
    : Number(req.body.amount);
  if (!Number.isFinite(requested) || requested <= 0) {
    return res.status(400).json({ message: 'Enter the amount received.' });
  }
  const amount = Math.min(requested, money.balance);
  const reference = req.body.reference || crypto.randomUUID();
  const paymentCompanyId = req.user?.isSuperiorAdmin
    ? (req.body.company_id || invoice.company_id || null)
    : (req.user?.company_id || invoice.company_id || null);

  const payment = await InvoicePayment.create({
    invoice_id: invoice.id,
    amount,
    payment_method: req.body.payment_method,
    transaction_id: reference,
    status: req.body.status || 'completed',
    note: req.body.note,
    order_id: req.body.order_id,
    ...(paymentCompanyId != null ? { company_id: Number(paymentCompanyId) } : {}),
  });

  await Transaction.create({
    user_id: invoice.client_id,
    type: 'invoice_payment',
    amount,
    description: `Payment for invoice ${invoice.invoice_id}`,
    payment_method: req.body.payment_method,
    status: payment.status,
    reference,
    company_id: req.user?.isSuperiorAdmin ? (req.body.company_id || invoice.company_id) : req.user?.company_id,
  });

  const balance = Math.max(money.balance - amount, 0);
  if (balance <= 0) {
    await invoice.update({ status: 'paid' });
    invoice.status = 'paid';
    await closePurchaseRequestFor(invoice);
  } else if (invoice.status === 'payment_under_review') {
    // An admin recording money directly resolves the review.
    await invoice.update({ status: 'sent' });
    invoice.status = 'sent';
  }

  // Tell the client's realtor a payment landed. Fire-and-forget so a
  // notification failure can never fail the payment itself.
  notifyRealtorOfPayment({ invoice, amount, paidInFull: invoice.status === 'paid' })
    .catch((err) => console.error('[notify] payment notification failed:', err.message));

  res.status(201).json({
    data: payment,
    invoiceStatus: invoice.status,
    invoice: { id: invoice.id, total: money.total, paid: money.paid + amount, balance },
  });
});

/**
 * Every invoice and payment belonging to one user, with the totals the UI
 * summarises on.
 *
 * One endpoint serves two callers: a client asking for their own record, and an
 * admin or upline realtor inspecting a client's. Who may ask about whom is
 * decided by shared/src/viewerAccess — the same rule the business summary uses.
 *
 * An invoice is DUE when it still owes money and its due date has passed, and
 * PENDING when it owes money but is not yet due. Paid-ness is derived by
 * summing invoice_payments rather than trusting invoices.status, which only
 * flips to 'paid' once the balance clears and says nothing about part payment.
 */
const getPaymentAnalysis = asyncHandler(async (req, res) => {
  const access = await resolveViewableUser(sequelize, req, req.params.userId);
  if (!access.ok) return res.status(access.status).json({ message: access.message });
  const { target } = access;

  // A buyer looking at their own record must not see unissued drafts; an admin
  // or upline realtor inspecting them sees the full picture.
  const hideDrafts = isSelfScoped(req);

  const invoices = await sequelize.query(
    `SELECT i.id, i.invoice_id, i.amount, i.status, i.due_date, i.created_at,
            i.property_id, p.name AS property_name,
            COALESCE(SUM(CASE WHEN ip.status = 'completed' THEN ip.amount END), 0) AS paid
       FROM invoices i
       LEFT JOIN invoice_payments ip ON ip.invoice_id = i.id
       LEFT JOIN properties p ON p.id = i.property_id
      WHERE i.client_id = :userId
        ${hideDrafts ? "AND i.status <> 'draft'" : ''}
      GROUP BY i.id
      ORDER BY i.id DESC`,
    { replacements: { userId: target.id }, type: QueryTypes.SELECT },
  );

  const payments = await sequelize.query(
    `SELECT ip.id, ip.invoice_id, i.invoice_id AS invoice_ref, ip.amount,
            ip.payment_method, ip.status, ip.note, ip.created_at
       FROM invoice_payments ip
       JOIN invoices i ON i.id = ip.invoice_id
      WHERE i.client_id = :userId
        ${hideDrafts ? "AND i.status <> 'draft'" : ''}
      ORDER BY ip.id DESC`,
    { replacements: { userId: target.id }, type: QueryTypes.SELECT },
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const rows = invoices.map((row) => {
    const amount = Number(row.amount) || 0;
    const paid = Number(row.paid) || 0;
    const balance = Math.max(amount - paid, 0);
    const dueDate = row.due_date ? new Date(row.due_date) : null;
    const overdue = balance > 0 && dueDate != null && dueDate < today;
    return {
      ...row,
      amount,
      paid,
      balance,
      settled: balance <= 0,
      // 'due' / 'pending' / 'paid' — what the client's tabs filter on.
      state: balance <= 0 ? 'paid' : overdue ? 'due' : 'pending',
    };
  });

  const bucket = (predicate) => {
    const picked = rows.filter(predicate);
    return { count: picked.length, amount: picked.reduce((sum, r) => sum + r.balance, 0) };
  };

  return res.json({
    data: {
      user: { id: target.id, name: target.name, email: target.email, phone: target.phone, type: target.type },
      totals: {
        invoiced: { count: rows.length, amount: rows.reduce((sum, r) => sum + r.amount, 0) },
        paid: { count: rows.filter((r) => r.settled).length, amount: rows.reduce((sum, r) => sum + r.paid, 0) },
        due: bucket((r) => r.state === 'due'),
        pending: bucket((r) => r.state === 'pending'),
      },
      invoices: rows,
      payments: payments.map((row) => ({ ...row, amount: Number(row.amount) || 0 })),
    },
  });
});

// ── Buyer payment flow ───────────────────────────────────────────────────────

// Gateway list and settings lookup live in utils/paymentGateways.js, shared
// with the credential-check endpoints so there is one definition of which
// gateways exist and where their keys come from.

/**
 * Money as the company writes it, for text that reaches a person.
 *
 * Notifications previously interpolated raw numbers ("An invoice of 400000"),
 * which is not how the amount appears anywhere else in the product.
 */
const formatMoneyFor = async (companyId) => {
  let code = 'USD';
  try {
    const rows = await sequelize.query(
      `SELECT \`value\`, company_id FROM settings
        WHERE \`group\` = 'appearance' AND \`key\` = 'currency'
          AND (company_id IS NULL OR company_id = :companyId)`,
      { replacements: { companyId: companyId ?? null }, type: QueryTypes.SELECT },
    );
    // A company's own setting wins over the platform default.
    code = rows.find((r) => r.company_id != null)?.value || rows.find((r) => r.company_id == null)?.value || 'USD';
  } catch { /* fall back to the default below */ }

  return (value) => {
    const amount = Number(value) || 0;
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency', currency: code, currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: 0, maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      return `${code} ${amount.toLocaleString('en-US')}`;
    }
  };
};

/** What this invoice still owes, derived from completed payments. */
const outstandingFor = async (invoice) => {
  const [row] = await sequelize.query(
    `SELECT COALESCE(SUM(amount), 0) AS paid FROM invoice_payments
      WHERE invoice_id = :id AND status = 'completed'`,
    { replacements: { id: invoice.id }, type: QueryTypes.SELECT },
  );
  const paid = Number(row?.paid) || 0;
  const total = Number(invoice.amount) || 0;
  return { total, paid, balance: Math.max(total - paid, 0) };
};

/**
 * How a buyer may pay this invoice.
 *
 * Bank: the account an admin pinned to this invoice, else every active account
 * the company has. Online: the company's configured gateway — omitted entirely
 * when nothing is configured, so the UI never offers a dead button. Only the
 * PUBLIC key is exposed; secret keys never leave the server.
 */
const getPaymentOptions = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findOne({ where: { id: req.params.id, ...invoiceScope(req) } });
  if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

  const companyId = invoice.company_id ?? null;

  const bankWhere = invoice.bank_account_id
    ? { id: invoice.bank_account_id }
    : { is_active: true, ...(companyId ? { company_id: companyId } : {}) };
  const banks = await BankAccount.findAll({
    where: bankWhere,
    // Explicit list, not the whole row: this is the one place bank details are
    // shown to a buyer. IBAN and SWIFT are here so international transfers are
    // possible; routing number, opening balance and internal fields are not.
    attributes: ['id', 'name', 'bank_name', 'account_number', 'iban', 'swift_code'],
    order: [['id', 'ASC']],
  });

  const cfg = await paymentSettingsFor(sequelize, companyId);
  // "Active" = both keys present. First configured gateway in preference order.
  const gateway = GATEWAYS.find((g) => String(cfg[g.publicKey] || '').trim() && String(cfg[g.secretKey] || '').trim());

  const money = await outstandingFor(invoice);

  res.json({
    data: {
      invoice: {
        id: invoice.id,
        invoice_id: invoice.invoice_id,
        status: invoice.status,
        ...money,
      },
      bank: {
        // assigned = an admin chose this account for this invoice specifically
        assigned: Boolean(invoice.bank_account_id),
        accounts: banks,
      },
      online: gateway
        ? { key: gateway.key, label: gateway.label, public_key: cfg[gateway.publicKey] }
        : null,
    },
  });
});

/**
 * A buyer submits proof of payment.
 *
 * Records a pending receipt and moves the invoice to payment_under_review. It
 * never credits the invoice — only an admin verifying the receipt does that, so
 * an upload cannot reduce a balance on its own.
 */
const submitInvoiceReceipt = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findOne({ where: { id: req.params.id, ...invoiceScope(req) } });
  if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

  if (['paid', 'cancelled'].includes(invoice.status)) {
    return res.status(409).json({ message: `This invoice is already ${invoice.status}.` });
  }

  const documentUrl = String(req.body.document_url || '').trim();
  if (!documentUrl) return res.status(400).json({ message: 'Upload your proof of payment.' });

  const { balance } = await outstandingFor(invoice);
  const amount = Number(req.body.amount ?? balance);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ message: 'Enter the amount you paid.' });
  }
  if (amount > balance) {
    const fmt = await formatMoneyFor(invoice.company_id ?? null);
    return res.status(400).json({ message: `That is more than the outstanding balance (${fmt(balance)}).` });
  }

  const receipt = await Receipt.create({
    receipt_number: await generateReceiptNumber(),
    invoice_id: invoice.id,
    client_id: invoice.client_id,
    amount,
    payment_method: String(req.body.payment_method || 'bank_transfer'),
    document_url: documentUrl,
    reference: String(req.body.reference || '').trim() || null,
    notes: String(req.body.notes || '').trim() || null,
    status: 'pending',
    created_by: req.user?.id ?? null,
    company_id: invoice.company_id ?? null,
  });

  await invoice.update({ status: 'payment_under_review' });

  // Nobody was told a payment was waiting — an admin had to notice the queue.
  // Notify whoever raised the invoice, and the buyer's realtor.
  const fmtMoney = await formatMoneyFor(invoice.company_id ?? null);
  // Notify the company's admins — NOT invoice.created_by, which for a purchase
  // invoice is the buyer themselves, so they would be told about their own
  // upload while the people who must review it heard nothing.
  sequelize.query(
    `SELECT id FROM users
      WHERE type IN ('admin', 'super_admin')
        AND is_active = 1 AND deleted_at IS NULL
        AND company_id ${invoice.company_id ? '= :companyId' : 'IS NULL'}
      LIMIT 20`,
    { replacements: { companyId: invoice.company_id }, type: QueryTypes.SELECT },
  ).then((admins) => Promise.all(admins.map((admin) => notifyUser({
    userId: admin.id,
    title: `Payment proof submitted for ${invoice.invoice_id}`,
    body: `A payment of ${fmtMoney(amount)} has been submitted for review on invoice ${invoice.invoice_id}.`,
    type: 'invoice_receipt_submitted',
    data: { invoice_id: invoice.id, receipt_id: receipt.id },
    companyId: invoice.company_id ?? null,
    actionLabel: 'Review payment',
    actionUrl: appUrl(`finance/invoices/${invoice.id}`, req),
  })))).catch((err) => console.error('[invoice] review notification failed:', err.message));
  notifyRealtorOfPayment({ invoice, amount, paidInFull: false, pending: true }).catch(() => {});

  res.status(201).json({ data: receipt });
});

/**
 * Settle an invoice in one action.
 *
 * Records a single payment for whatever is still outstanding and marks the
 * invoice paid — the "I have confirmed the full amount" path, as opposed to
 * payInvoice which records a part payment. Never writes invoice.amount: the
 * total is fixed at issue, only the balance moves.
 */
const markInvoicePaid = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findOne({ where: { id: req.params.id, ...companyScope(req) } });
  if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

  const money = await outstandingFor(invoice);
  if (money.balance <= 0) {
    return res.status(409).json({ message: 'This invoice is already settled.' });
  }

  const method = String(req.body.payment_method || 'bank_transfer');
  const reference = String(req.body.reference || '').trim() || `PAID-${invoice.invoice_id}`;
  const companyId = invoice.company_id ?? req.user?.company_id ?? null;

  const transaction = await sequelize.transaction();
  try {
    const payment = await InvoicePayment.create({
      invoice_id: invoice.id,
      amount: money.balance,
      payment_method: method,
      transaction_id: reference,
      status: 'completed',
      note: String(req.body.notes || '').trim() || 'Marked paid in full',
      company_id: companyId,
    }, { transaction });

    await Transaction.create({
      user_id: invoice.client_id,
      type: 'invoice_payment',
      amount: money.balance,
      description: `Payment for invoice ${invoice.invoice_id}`,
      payment_method: method,
      status: 'completed',
      reference,
      company_id: companyId,
    }, { transaction });

    await invoice.update({ status: 'paid' }, { transaction });
    await transaction.commit();
    await closePurchaseRequestFor(invoice);

    notifyUser({
      userId: invoice.client_id,
      title: `Invoice ${invoice.invoice_id} settled`,
      body: `Your payment was confirmed and invoice ${invoice.invoice_id} is now fully settled.`,
      type: 'invoice_paid',
      data: { invoice_id: invoice.id },
      companyId,
    }).catch(() => {});

    return res.status(201).json({
      data: payment,
      invoice: { id: invoice.id, status: 'paid', total: money.total, paid: money.total, balance: 0 },
    });
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }
});

const getInvoicePayments = asyncHandler(async (req, res) => {
  // invoiceScope, not companyScope: a client must not read the payment history
  // of an invoice billed to someone else in the same company.
  const invoice = await Invoice.findOne({ where: { id: req.params.id, ...invoiceScope(req) } });
  if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
  const payments = await InvoicePayment.findAll({ where: { invoice_id: req.params.id, ...companyScope(req) }, order: [['id', 'DESC']] });
  res.json({ data: payments });
});

/**
 * Financial records are an audit trail. Transactions, payments and the notes
 * raised against them stay put; correcting them is an accounting action
 * (cancel, credit note), not a delete.
 */
/**
 * A settled invoice closes the purchase behind it.
 *
 * property_purchase_requests sat at 'pending' forever, so nothing downstream
 * could tell a paid purchase from an unpaid one. Best effort: the money is
 * already recorded, and this is bookkeeping on another service's table.
 */
const closePurchaseRequestFor = async (invoice) => {
  try {
    await sequelize.query(
      `UPDATE property_purchase_requests
          SET status = 'completed', updated_at = NOW()
        WHERE invoice_id = :invoiceId AND status = 'pending'`,
      { replacements: { invoiceId: invoice.id }, type: QueryTypes.UPDATE },
    );
  } catch (error) {
    console.error('[purchase] could not close the request:', error.message);
  }
};

const notDeletable = (what) => (req, res) => res.status(405).json({
  message: `${what} cannot be deleted. Records here are referenced by invoices and payments; `
    + 'edit it, or deactivate it where that is available.',
});

const revenueReport = asyncHandler(async (req, res) => {
  const totals = await InvoicePayment.findAll({
    attributes: [[fn('sum', col('amount')), 'revenue']],
    where: { status: 'completed', ...companyScope(req) },
    raw: true,
  });
  res.json({ data: { revenue: Number(totals[0]?.revenue || 0) } });
});

const transactionReport = asyncHandler(async (req, res) => {
  const rows = await Transaction.findAll({ where: companyScope(req), order: [['id', 'DESC']], limit: 100 });
  res.json({ data: rows });
});

const invoiceReport = asyncHandler(async (req, res) => {
  const where = { ...companyScope(req) };
  if (req.query.status) where.status = req.query.status;
  if (req.query.start_date || req.query.end_date) {
    where.createdAt = {};
    if (req.query.start_date) where.createdAt[Op.gte] = new Date(req.query.start_date);
    if (req.query.end_date) where.createdAt[Op.lte] = new Date(req.query.end_date);
  }
  const rows = await Invoice.findAll({ where, order: [['id', 'DESC']], limit: 200 });
  res.json({ data: rows });
});

const getReferralSetting = asyncHandler(async (req, res) => {
  const setting = await ReferralSetting.findOne({ where: companyScope(req), order: [['id', 'DESC']] });
  res.json({ data: setting || null });
});

const upsertReferralSetting = asyncHandler(async (req, res) => {
  const scope = companyScope(req);
  const existing = await ReferralSetting.findOne({ where: scope, order: [['id', 'DESC']] });
  const payload = withCompanyAudit(req);
  if (existing) {
    await existing.update(payload);
    return res.json({ data: existing });
  }
  const setting = await ReferralSetting.create(payload);
  res.status(201).json({ data: setting });
});

const listReferralTransactions = asyncHandler(async (req, res) => {
  const rows = await ReferralTransaction.findAll({ where: companyScope(req), order: [['id', 'DESC']] });
  res.json({ data: rows });
});

const createReferralTransaction = asyncHandler(async (req, res) => {
  const tx = await ReferralTransaction.create(withCompanyAudit(req));
  res.status(201).json({ data: tx });
});

const updateReferralTransaction = asyncHandler(async (req, res) => {
  const tx = await ReferralTransaction.findOne({ where: { id: req.params.id, ...companyScope(req) } });
  if (!tx) return res.status(404).json({ message: 'Referral transaction not found' });
  await tx.update(req.body);
  res.json({ data: tx });
});

// ── Commission approval workflow ───────────────────────────────────────────────

const approveCommission = asyncHandler(async (req, res) => {
  const commission = await Commission.findOne({ where: { id: req.params.id, ...companyScope(req) } });
  if (!commission) return res.status(404).json({ message: 'Commission not found' });
  if (commission.status !== 'pending') return res.status(400).json({ message: `Cannot approve a commission in '${commission.status}' state` });
  await commission.update({ status: 'approved' });
  res.json({ data: commission });
});

const payCommission = asyncHandler(async (req, res) => {
  const commission = await Commission.findOne({ where: { id: req.params.id, ...companyScope(req) } });
  if (!commission) return res.status(404).json({ message: 'Commission not found' });
  if (commission.status !== 'approved') return res.status(400).json({ message: 'Commission must be approved before payment' });
  await commission.update({ status: 'paid' });
  res.json({ data: commission });
});

// ── Commission rules ───────────────────────────────────────────────────────────

const commissionRuleCrud = buildCrudController(CommissionRule, {
  defaultWhere: companyScope, scopeWhere: companyScope,
  beforeCreate: (req) => withCompanyAudit(req),
});

const calculateCommission = asyncHandler(async (req, res) => {
  const { product_type, realtor_category, amount } = req.body;
  if (!amount) return res.status(400).json({ message: 'amount is required' });

  // Look for the most specific matching rule first, then fall back to 'any'
  const rule = await CommissionRule.findOne({
    where: {
      ...companyScope(req),
      product_type: [product_type || 'any', 'any'],
      realtor_category: [realtor_category || 'any', 'any'],
    },
    order: [
      // Prioritise exact product_type match
      [CommissionRule.sequelize.literal(`CASE WHEN product_type = '${product_type}' THEN 0 ELSE 1 END`), 'ASC'],
      [CommissionRule.sequelize.literal(`CASE WHEN realtor_category = '${realtor_category}' THEN 0 ELSE 1 END`), 'ASC'],
    ],
  });

  if (!rule) return res.status(404).json({ message: 'No matching commission rule found' });

  const commission = rule.type === 'percentage'
    ? (Number(amount) * Number(rule.value)) / 100
    : Number(rule.value);

  res.json({ data: { rule, commission: commission.toFixed(2) } });
});

// ── Receipts ───────────────────────────────────────────────────────────────────

const RECEIPT_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const generateReceiptNumber = async () => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    let rand = '';
    for (let i = 0; i < 6; i++) rand += RECEIPT_CHARSET[Math.floor(Math.random() * RECEIPT_CHARSET.length)];
    const number = `RCP-${datePart}-${rand}`;
    const exists = await Receipt.findOne({ where: { receipt_number: number } });
    if (!exists) return number;
  }
  throw new Error('Could not generate unique receipt number');
};

const receiptCrud = buildCrudController(Receipt, {
  searchFields: ['receipt_number', 'status', 'payment_method'],
  defaultWhere: companyScope, scopeWhere: companyScope,
});

const createReceipt = asyncHandler(async (req, res) => {
  const receipt_number = await generateReceiptNumber();
  const receipt = await Receipt.create({
    ...withCompanyAudit(req),
    receipt_number,
    invoice_id: req.body.invoice_id || null,
    invoice_payment_id: req.body.invoice_payment_id || null,
    client_id: req.body.client_id || null,
    amount: req.body.amount,
    payment_method: req.body.payment_method || null,
    notes: req.body.notes || null,
    status: 'pending',
  });
  res.status(201).json({ data: receipt });
});

/**
 * An admin confirms a receipt and credits the invoice.
 *
 * The credited amount defaults to what the buyer declared but the admin may
 * record a different figure — a part payment against a larger invoice. Either
 * way it is CLAMPED to the outstanding balance, and the invoice's own `amount`
 * is never written to: the total is fixed at issue, and only the balance moves.
 *
 * Everything happens in one transaction so a receipt can never end up verified
 * without its payment, or a payment recorded twice.
 */
const verifyReceipt = asyncHandler(async (req, res) => {
  const receipt = await Receipt.findOne({ where: { id: req.params.id, ...companyScope(req) } });
  if (!receipt) return res.status(404).json({ message: 'Receipt not found' });
  if (receipt.status !== 'pending') {
    return res.status(409).json({ message: `This receipt was already ${receipt.status}.` });
  }

  const invoice = receipt.invoice_id
    ? await Invoice.findOne({ where: { id: receipt.invoice_id } })
    : null;
  if (!invoice) return res.status(404).json({ message: 'The invoice for this receipt no longer exists.' });

  const before = await outstandingFor(invoice);
  if (before.balance <= 0) {
    return res.status(409).json({ message: 'This invoice is already settled.' });
  }

  const requested = req.body.amount == null ? Number(receipt.amount) : Number(req.body.amount);
  if (!Number.isFinite(requested) || requested <= 0) {
    return res.status(400).json({ message: 'Enter the amount being credited.' });
  }
  // Never let a payment exceed what is owed — that would be the only way the
  // effective total could move.
  const amount = Math.min(requested, before.balance);

  const reference = receipt.reference || `RCPT-${receipt.receipt_number}`;
  const transaction = await sequelize.transaction();
  try {
    const payment = await InvoicePayment.create({
      invoice_id: invoice.id,
      amount,
      payment_method: receipt.payment_method || 'bank_transfer',
      transaction_id: reference,
      status: 'completed',
      note: String(req.body.notes || receipt.notes || '').trim() || null,
      company_id: invoice.company_id ?? null,
    }, { transaction });

    await Transaction.create({
      user_id: invoice.client_id,
      type: 'invoice_payment',
      amount,
      description: `Payment for invoice ${invoice.invoice_id}`,
      payment_method: receipt.payment_method || 'bank_transfer',
      status: 'completed',
      reference,
      company_id: invoice.company_id ?? null,
    }, { transaction });

    await receipt.update({
      status: 'verified',
      amount,
      invoice_payment_id: payment.id,
      verified_by: req.user?.id ?? null,
      verified_at: new Date(),
    }, { transaction });

    const balance = Math.max(before.balance - amount, 0);
    const money = await formatMoneyFor(invoice.company_id ?? null);
    if (balance <= 0) await closePurchaseRequestFor(invoice);
    // Settled outright, or still owing after an installment.
    await invoice.update({ status: balance <= 0 ? 'paid' : 'sent' }, { transaction });

    await transaction.commit();

    // Best effort, after the money is safely recorded.
    notifyUser({
      userId: invoice.client_id,
      title: balance <= 0 ? `Invoice ${invoice.invoice_id} settled` : `Payment received for ${invoice.invoice_id}`,
      body: balance <= 0
        ? `Your payment was confirmed and invoice ${invoice.invoice_id} is now fully settled.`
        : `Your payment was confirmed. The outstanding balance on invoice ${invoice.invoice_id} is now ${money(balance)}.`,
      type: 'invoice_payment_verified',
      data: { invoice_id: invoice.id, amount, balance },
      companyId: invoice.company_id ?? null,
    }).catch(() => {});

    // The same money event as payInvoice, so the realtor hears about it either
    // way — previously only the direct-payment path told them.
    notifyRealtorOfPayment({ invoice, amount, paidInFull: balance <= 0 }).catch(() => {});

    return res.json({
      data: {
        receipt,
        payment: { id: payment.id, amount },
        invoice: { id: invoice.id, status: balance <= 0 ? 'paid' : 'sent', total: before.total, paid: before.paid + amount, balance },
      },
    });
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }
});

const rejectReceipt = asyncHandler(async (req, res) => {
  const receipt = await Receipt.findOne({ where: { id: req.params.id, ...companyScope(req) } });
  if (!receipt) return res.status(404).json({ message: 'Receipt not found' });
  if (receipt.status !== 'pending') {
    return res.status(409).json({ message: `This receipt was already ${receipt.status}.` });
  }

  const notes = String(req.body.notes || '').trim();
  if (!notes) return res.status(400).json({ message: 'Give a reason so the buyer knows what to fix.' });

  await receipt.update({ status: 'rejected', notes, verified_by: req.user?.id ?? null, verified_at: new Date() });

  // Hand the invoice back: leaving it under review would strand the buyer with
  // no way to resubmit.
  const invoice = receipt.invoice_id ? await Invoice.findOne({ where: { id: receipt.invoice_id } }) : null;
  if (invoice && invoice.status === 'payment_under_review') {
    await invoice.update({ status: 'sent' });
    notifyUser({
      userId: invoice.client_id,
      title: `Payment proof not accepted — ${invoice.invoice_id}`,
      body: `Your proof of payment was not accepted. Reason: ${notes}`,
      type: 'invoice_receipt_rejected',
      data: { invoice_id: invoice.id },
      companyId: invoice.company_id ?? null,
    }).catch(() => {});
  }

  res.json({ data: receipt });
});

module.exports = {
  notDeletable,
  getPaymentAnalysis,
  getPaymentOptions,
  submitInvoiceReceipt,
  invoiceCrud, taxCrud, transactionCrud, paymentPlanCrud,
  bankAccountCrud, creditNoteCrud, debitNoteCrud, paymentReminderCrud, commissionCrud,
  sendInvoice, payInvoice, markInvoicePaid, getInvoicePayments,
  revenueReport, transactionReport, invoiceReport,
  getReferralSetting, upsertReferralSetting,
  listReferralTransactions, createReferralTransaction, updateReferralTransaction,
  approveCommission, payCommission,
  commissionRuleCrud, calculateCommission,
  receiptCrud, createReceipt, verifyReceipt, rejectReceipt,
};

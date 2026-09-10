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
const { resolveViewableUser } = require('../../../../shared/src/viewerAccess');
const { appUrl } = require('../../../../shared/src/appOrigin');
const { GATEWAYS, paymentSettingsFor } = require('../utils/paymentGateways');
const { applyApprovedPayment } = require('../services/allocationService');
const { generateForSale, payOut, summaryFor } = require('../services/commissionService');
const { readPaymentPlan } = require('../../../../shared/src/paymentPlanGateway');
const { asMinor, toMinor, toMajor } = require('../../../../shared/src/money');
const { createPurchaseNotifier } = require('../../../../shared/src/purchaseNotifications');
const { createDispatcher } = require('../../../../shared/src/notificationDispatcher');
const purchaseNotifier = createPurchaseNotifier(sequelize);
// For events with no invoice behind them, such as commissions.
const notify = createDispatcher(sequelize);

const companyScope = (req) => buildCompanyScope(req);

/**
 * How money is recorded as having arrived.
 *
 * CONFIRMABLE are the methods an admin may pick when approving a buyer's proof
 * of payment. Each is something the proof itself evidences, which is why a
 * transaction reference is demanded alongside it — the reference is read off
 * the deposit slip or transfer receipt and is what reconciles the ledger
 * against a bank statement later.
 *
 * ADMIN_APPROVED is deliberately NOT in that list. It is the method stamped on
 * a payment created by "Mark invoice as paid", where an admin asserts on their
 * own authority that money arrived without producing proof or a reference. It
 * is not selectable, because choosing it would misrepresent a payment that did
 * have evidence; it is only ever applied by that one action, so a payment
 * carrying it stays identifiable as unevidenced.
 */
const CONFIRMABLE_PAYMENT_METHODS = ['bank_deposit', 'transfer', 'online_payment'];
const ADMIN_APPROVED_METHOD = 'admin_approved';

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

/**
 * Resolves the ids an invoice carries into the names a person can read.
 *
 * An invoice stores client_id and property_id, so a view rendered straight from
 * the row showed "Client 42" — which tells nobody anything. Both live in tables
 * this service does not own, so they are resolved in one query per page rather
 * than joined.
 */
const withInvoiceNames = async (rows) => {
  const list = Array.isArray(rows) ? rows : [rows];
  const clientIds = [...new Set(list.map((r) => r.client_id).filter(Boolean))];
  const propertyIds = [...new Set(list.map((r) => r.property_id).filter(Boolean))];

  const [clients, properties] = await Promise.all([
    clientIds.length
      ? sequelize.query('SELECT id, name, email, phone FROM users WHERE id IN (:ids)',
        { replacements: { ids: clientIds }, type: QueryTypes.SELECT }).catch(() => [])
      : [],
    propertyIds.length
      ? sequelize.query('SELECT id, name FROM properties WHERE id IN (:ids)',
        { replacements: { ids: propertyIds }, type: QueryTypes.SELECT }).catch(() => [])
      : [],
  ]);

  const clientById = new Map(clients.map((c) => [Number(c.id), c]));
  const propertyById = new Map(properties.map((p) => [Number(p.id), p]));

  const decorate = (row) => {
    const plain = row.get ? row.get({ plain: true }) : row;
    const client = clientById.get(Number(plain.client_id));
    return {
      ...plain,
      client_name: client ? (client.name || client.email) : null,
      client_email: client?.email ?? null,
      client_phone: client?.phone ?? null,
      property_name: propertyById.get(Number(plain.property_id))?.name ?? null,
    };
  };

  return Array.isArray(rows) ? list.map(decorate) : decorate(rows);
};

const invoiceCrud = buildCrudController(Invoice, {
  afterList: withInvoiceNames,
  afterGet: withInvoiceNames,
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
   * caller sends lands on the row.
   *
   * The CLIENT is stripped. An invoice is a commercial record addressed to one
   * party: repointing it at somebody else would move payments, schedules, the
   * inventory hold and any commission to a person who never agreed to the
   * purchase, while keeping the reference that was sent to the original buyer.
   * Cancel and reissue instead.
   */
  beforeUpdate: async (req, invoice) => {
    const { client_id: attempted, ...rest } = req.body;
    if (attempted != null && Number(attempted) !== Number(invoice.client_id)) {
      throw Object.assign(
        new Error('An invoice cannot be moved to a different client. Cancel it and raise a new one.'),
        { status: 409 },
      );
    }
    return rest;
  },
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
/**
 * Resolves the party a note is raised against, for the list column.
 *
 * A note now points at any user in the company, so an id alone is unreadable —
 * "#42" tells an admin nothing about whether it was a client or a realtor. One
 * query per page rather than a join, because notes and users live in tables
 * this service does not own on both sides.
 */
const withPartyNames = async (rows) => {
  const ids = [...new Set(rows.map((row) => row.client_id).filter(Boolean))];
  if (!ids.length) return rows;
  try {
    const users = await sequelize.query(
      'SELECT id, name, email, type FROM users WHERE id IN (:ids)',
      { replacements: { ids }, type: QueryTypes.SELECT },
    );
    const byId = new Map(users.map((u) => [Number(u.id), u]));
    return rows.map((row) => {
      const user = byId.get(Number(row.client_id));
      const plain = row.get ? row.get({ plain: true }) : row;
      return {
        ...plain,
        party_name: user ? (user.name || user.email) : null,
        // Falls back to the user's actual type where the note predates the
        // party_type column.
        party_type: plain.party_type || user?.type || 'client',
      };
    });
  } catch (error) {
    console.error('[notes] party lookup failed:', error.message);
    return rows;
  }
};

const creditNoteCrud = buildCrudController(CreditNote, {
  afterList: withPartyNames,
  include: ['tax'], searchFields: ['credit_note_id', 'status'],
  defaultWhere: companyScope, scopeWhere: companyScope,
  beforeCreate: async (req) => ({
    ...withCompanyAudit(req),
    credit_note_id: await buildSequence(CreditNote, 'credit_note_id', 'CN-'),
  }),
});
const debitNoteCrud = buildCrudController(DebitNote, {
  afterList: withPartyNames,
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
  purchaseNotifier.dispatch({
    eventKey: 'invoice_sent',
    invoiceId: invoice.id,
    type: 'invoice_sent',
    title: (role, ctx) => `Invoice ${ctx.invoice_id} is ready`,
    body: (role, ctx) => (role === 'client'
      ? `An invoice of ${fmt(money.total)} has been issued to you.`
        + `${due ? ` It is due on ${due}.` : ''}`
        + '\n\nYou can view it and submit your payment from your invoices page.'
      : `Invoice ${ctx.invoice_id} for ${fmt(money.total)} has been issued to `
        + `${ctx.client_name || 'the buyer'}.`),
    data: { amount: money.total },
    actionLabel: 'View invoice',
    actionUrl: appUrl(`finance/invoices/${invoice.id}`, req),
  }).catch(() => {});

  res.json({
    message: wasDraft ? 'Invoice issued and the client notified.' : 'The client was notified again.',
    data: invoice,
  });
});

/**
 * An admin records a payment against an invoice on the client's behalf
 * (FRD 13 — "Upload receipt: admin on behalf").
 *
 * Routed through the SAME allocator as a client's approved receipt (FRD 16), so
 * a payment an admin enters directly resolves across the schedules identically
 * — oldest first, fees before principal — and produces the same audit trail.
 * It used to have its own settle-the-balance logic, which knew nothing about
 * schedules or fees.
 */
const payInvoice = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findOne({ where: { id: req.params.id, ...companyScope(req) } });
  if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

  // The confirmable methods, plus the gateway and legacy names this endpoint
  // has always accepted. admin_approved is excluded on purpose: it belongs to
  // mark-as-paid alone.
  const supported = [
    ...CONFIRMABLE_PAYMENT_METHODS,
    'stripe', 'paypal', 'flutterwave', 'paystack', 'bank_transfer', 'cash',
  ];
  if (!supported.includes(req.body.payment_method)) {
    return res.status(400).json({ message: `Unsupported payment method. Use ${supported.join(', ')}` });
  }

  const money = await outstandingFor(invoice);
  if (money.balance <= 0) {
    return res.status(409).json({ message: 'This invoice is already settled.' });
  }

  // Defaults to clearing the balance. No longer clamped to it: an admin
  // recording what a client actually sent may legitimately exceed it, and
  // FRD 8.2 turns the surplus into a flagged credit balance rather than
  // discarding it.
  const requested = req.body.amount == null || req.body.amount === ''
    ? money.balance
    : Number(req.body.amount);
  if (!Number.isFinite(requested) || requested <= 0) {
    return res.status(400).json({ message: 'Enter the amount received.' });
  }

  const reference = req.body.reference || crypto.randomUUID();
  const result = await applyApprovedPayment({
    invoiceId: invoice.id,
    amountMinor: toMinor(requested),
    paymentMethod: req.body.payment_method,
    reference,
    note: req.body.note ?? null,
    approvedBy: req.user?.id ?? null,
    valueDate: req.body.value_date || req.body.payment_date || null,
    companyId: req.user?.isSuperiorAdmin
      ? (req.body.company_id || invoice.company_id || null)
      : (req.user?.company_id || invoice.company_id || null),
  });

  const fmt = await formatMoneyFor(invoice.company_id ?? null);
  purchaseNotifier.dispatch({
    eventKey: result.paidInFull ? 'invoice_fully_paid' : 'payment_approved',
    invoiceId: invoice.id,
    type: result.paidInFull ? 'invoice_paid' : 'invoice_payment_verified',
    title: (role, ctx) => (result.paidInFull
      ? `Invoice ${ctx.invoice_id} settled`
      : `Payment recorded for ${ctx.invoice_id}`),
    body: (role, ctx) => {
      const who = role === 'client' ? 'A' : `${ctx.client_name || 'A client'}'s`;
      const head = `${who} payment of ${fmt(toMajor(result.appliedMinor))} has been recorded against `
        + `invoice ${ctx.invoice_id} on ${purchaseNotifier.describeSubject(ctx)}.`;
      return result.paidInFull
        ? `${head}\n\nThe invoice is now fully settled.`
        : `${head}\nOutstanding balance: ${fmt(toMajor(result.balanceMinor))}.`;
    },
    data: { amount: toMajor(result.appliedMinor), balance: toMajor(result.balanceMinor) },
    actionLabel: 'View invoice',
    actionUrl: appUrl(`finance/invoices/${invoice.id}`, req),
  }).catch(() => {});

  res.status(201).json({
    data: { id: result.paymentId, amount: toMajor(result.appliedMinor) },
    invoiceStatus: result.invoice.status,
    invoice: {
      id: invoice.id,
      total: toMajor(result.totalMinor),
      paid: toMajor(result.paidMinor),
      balance: toMajor(result.balanceMinor),
    },
    allocations: (result.lines || []).map((line) => ({
      schedule_id: line.schedule_id,
      sequence: line.sequence,
      principal: toMajor(line.principal_minor),
      fee: toMajor(line.fee_minor),
    })),
    credit_balance: toMajor(result.creditBalanceMinor),
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

/**
 * What this invoice still owes.
 *
 * Where the invoice has a payment plan, the SCHEDULES are the truth: the
 * balance is their outstanding principal plus their accrued default fees, which
 * is a figure the sum of payments cannot produce — a fee applied after the due
 * date raises what is owed without any payment having moved (FRD 9.3).
 *
 * Invoices raised before the purchase journey existed have no plan, and for
 * those the balance is derived the way it always was, from the sum of completed
 * payments against invoices.amount.
 */
const outstandingFor = async (invoice) => {
  const [row] = await sequelize.query(
    `SELECT COALESCE(SUM(amount), 0) AS paid FROM invoice_payments
      WHERE invoice_id = :id AND status = 'completed'`,
    { replacements: { id: invoice.id }, type: QueryTypes.SELECT },
  );
  const paid = Number(row?.paid) || 0;

  const [ledger] = await sequelize.query(
    `SELECT COUNT(*) AS schedules,
            COALESCE(SUM(ps.principal_outstanding_minor), 0) AS principal_outstanding,
            COALESCE(SUM(ps.fee_outstanding_minor), 0) AS fee_outstanding,
            COALESCE(SUM(ps.fee_accrued_minor), 0) AS fee_accrued,
            MAX(ipp.total_minor) AS total_minor
       FROM invoice_payment_plans ipp
       JOIN payment_schedules ps ON ps.invoice_payment_plan_id = ipp.id
      WHERE ipp.invoice_id = :id`,
    { replacements: { id: invoice.id }, type: QueryTypes.SELECT },
  );

  if (Number(ledger?.schedules) > 0) {
    const feesAccrued = toMajor(asMinor(ledger.fee_accrued));
    return {
      // The agreed price. Fees are surfaced separately rather than folded in,
      // so "total" stays the figure the client agreed to and the UI can state
      // the fee and the resulting total payable (FRD 12.3).
      total: toMajor(asMinor(ledger.total_minor)),
      paid,
      balance: toMajor(asMinor(ledger.principal_outstanding) + asMinor(ledger.fee_outstanding)),
      principal_balance: toMajor(asMinor(ledger.principal_outstanding)),
      fees_accrued: feesAccrued,
      fees_outstanding: toMajor(asMinor(ledger.fee_outstanding)),
    };
  }

  const total = Number(invoice.amount) || 0;
  return { total, paid, balance: Math.max(total - paid, 0), fees_accrued: 0, fees_outstanding: 0 };
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

  /**
   * The payment plan and its schedule table (FRD 5.2).
   *
   * Returned from the same endpoint the payment page already calls, so
   * "Proceed to Payment" lands on a page that needs no further round trip —
   * which is half of what makes removing FRD 5's return-to-home trip work.
   *
   * Null for an invoice raised before the purchase journey existed; the page
   * falls back to the plain total and balance for those.
   */
  const loaded = await readPaymentPlan(sequelize, invoice.id);

  res.json({
    data: {
      invoice: {
        id: invoice.id,
        invoice_id: invoice.invoice_id,
        status: invoice.status,
        due_date: invoice.due_date,
        ...money,
      },
      payment_plan: loaded ? {
        id: loaded.plan.id,
        payment_type: loaded.plan.payment_type,
        plan_name: loaded.plan.snapshot_plan_name,
        duration_months: loaded.plan.snapshot_duration_months,
        quantity: loaded.plan.quantity,
        status: loaded.plan.status,
        base: toMajor(asMinor(loaded.plan.base_minor)),
        // Stated explicitly rather than folded into the total (FRD 4.1), so the
        // plan charge is still visible on the invoice long after purchase.
        surcharge: toMajor(asMinor(loaded.plan.surcharge_minor)),
        total: toMajor(asMinor(loaded.plan.total_minor)),
        credit_balance: toMajor(asMinor(loaded.plan.credit_balance_minor)),
        terms: {
          grace_period_days: loaded.plan.snapshot_grace_period_days,
          default_fee_type: loaded.plan.snapshot_default_fee_type,
          default_fee_value: Number(loaded.plan.snapshot_default_fee_value) || 0,
          default_fee_recurrence: loaded.plan.snapshot_default_fee_recurrence,
        },
      } : null,
      // Due dates, amounts and BOTH status dimensions (FRD 9.2) — a schedule
      // can be overdue and part paid at once, and one status could not say so.
      schedules: (loaded?.schedules || []).map((schedule) => ({
        id: schedule.id,
        sequence: schedule.sequence,
        due_date: schedule.due_date,
        principal: toMajor(asMinor(schedule.principal_minor)),
        principal_outstanding: toMajor(asMinor(schedule.principal_outstanding_minor)),
        fee_accrued: toMajor(asMinor(schedule.fee_accrued_minor)),
        fee_outstanding: toMajor(asMinor(schedule.fee_outstanding_minor)),
        // Principal plus accrued fee — what actually has to be paid for this
        // schedule to reach PAID (FRD 9.3).
        payable: toMajor(asMinor(schedule.principal_outstanding_minor) + asMinor(schedule.fee_outstanding_minor)),
        timing_status: schedule.timing_status,
        settlement_status: schedule.settlement_status,
      })),
      bank: {
        // assigned = an admin chose this account for this invoice specifically
        assigned: Boolean(invoice.bank_account_id),
        accounts: banks,
      },
      online: gateway
        ? { key: gateway.key, label: gateway.label, public_key: cfg[gateway.publicKey] }
        : null,
      // The methods an admin may confirm a payment as, served from the same
      // constant the validation uses so the picker and the check cannot drift.
      confirmable_payment_methods: CONFIRMABLE_PAYMENT_METHODS,
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

  // FRD 7.1: submission is permitted on any invoice still awaiting money.
  // Multiple payments per invoice are expected and normal.
  if (!['draft', 'sent', 'payment_under_review', 'partially_paid'].includes(invoice.status)) {
    return res.status(409).json({ message: `This invoice is ${invoice.status} and cannot take a payment.` });
  }

  const documentUrl = String(req.body.document_url || '').trim();
  if (!documentUrl) return res.status(400).json({ message: 'Upload your proof of payment.' });

  const { balance } = await outstandingFor(invoice);
  const amount = Number(req.body.amount ?? balance);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ message: 'Enter the amount you paid.' });
  }
  /**
   * An amount above the outstanding balance used to be rejected here. It is
   * accepted now, because this figure is a CLAIM about money the client says
   * they have already transferred (FRD 5.3) — refusing to record it does not
   * unsend the transfer, it just leaves the admin nothing to reconcile against.
   * The admin may correct it at approval, and any genuine surplus becomes a
   * flagged credit balance (FRD 8.2) rather than being discarded.
   */

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

  /**
   * The review queue.
   *
   * This used to select every admin and super_admin in the company by
   * users.type and mail them directly. The people who need telling are the ones
   * who can APPROVE a payment, which is finance.invoices.manage — a company
   * with a dedicated finance officer had no way to say so, and one whose admins
   * do not handle payments got the mail anyway.
   *
   * The buyer gets an acknowledgement from the same event, which is why the
   * body differs by role.
   */
  const fmtMoney = await formatMoneyFor(invoice.company_id ?? null);
  purchaseNotifier.dispatch({
    eventKey: 'payment_receipt_submitted',
    invoiceId: invoice.id,
    type: 'invoice_receipt_submitted',
    title: (role, ctx) => (role === 'client'
      ? `Payment submitted for ${ctx.invoice_id}`
      : `Payment proof submitted for ${ctx.invoice_id}`),
    body: (role, ctx) => (role === 'client'
      ? `Your payment of ${fmtMoney(amount)} has been submitted for review. You will be told once `
        + 'it has been confirmed.'
      : `A payment of ${fmtMoney(amount)} has been submitted for review on invoice ${ctx.invoice_id} `
        + `(${purchaseNotifier.describeSubject(ctx)}).`),
    data: { receipt_id: receipt.id, amount },
    actionLabel: 'Review payment',
    actionUrl: appUrl(`finance/invoices/${invoice.id}`, req),
  }).catch(() => {});

  res.status(201).json({ data: receipt });
});

/**
 * Settle an invoice in one action.
 *
 * The "I have confirmed the full amount" path, as opposed to payInvoice which
 * records a part payment. Routed through the same allocator (FRD 16) so
 * settling in one go still clears each schedule in order and still settles
 * accrued default fees before principal — the balance it pays off is the
 * schedules' outstanding principal PLUS their fees, which is why it reads that
 * figure from outstandingFor rather than from invoices.amount.
 */
const markInvoicePaid = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findOne({ where: { id: req.params.id, ...companyScope(req) } });
  if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

  const money = await outstandingFor(invoice);
  if (money.balance <= 0) {
    return res.status(409).json({ message: 'This invoice is already settled.' });
  }

  /**
   * The method is forced, not taken from the request.
   *
   * This path creates a payment with no proof and no transaction reference — an
   * admin asserting that money arrived. Letting the caller name the method
   * would allow an unevidenced payment to be recorded as a bank deposit, which
   * is exactly the distinction anyone auditing the ledger later needs.
   */
  const method = ADMIN_APPROVED_METHOD;
  const reference = `ADMIN-APPROVED-${invoice.invoice_id}`;

  const result = await applyApprovedPayment({
    invoiceId: invoice.id,
    amountMinor: toMinor(money.balance),
    paymentMethod: method,
    reference,
    note: String(req.body.notes || '').trim() || 'Marked paid in full',
    approvedBy: req.user?.id ?? null,
    valueDate: req.body.value_date || null,
    companyId: invoice.company_id ?? req.user?.company_id ?? null,
  });

  await closePurchaseRequestFor(invoice);

  const fmt = await formatMoneyFor(invoice.company_id ?? null);
  purchaseNotifier.dispatch({
    eventKey: 'invoice_fully_paid',
    invoiceId: invoice.id,
    type: 'invoice_paid',
    title: (role, ctx) => `Invoice ${ctx.invoice_id} settled`,
    body: (role, ctx) => (role === 'client'
      ? `Your payment of ${fmt(toMajor(result.appliedMinor))} was confirmed and invoice ${ctx.invoice_id} `
        + `on ${purchaseNotifier.describeSubject(ctx)} is now fully settled.`
      : `${ctx.client_name || 'A client'} has fully settled invoice ${ctx.invoice_id} on `
        + `${purchaseNotifier.describeSubject(ctx)}.`),
    data: { amount: toMajor(result.appliedMinor) },
    actionLabel: 'View invoice',
    actionUrl: appUrl(`finance/invoices/${invoice.id}`, req),
  }).catch(() => {});

  return res.status(201).json({
    data: {
      id: result.paymentId,
      amount: toMajor(result.appliedMinor),
      payment_method: method,
      reference,
      // Stated plainly in the response: this payment has no proof behind it.
      evidenced: false,
    },
    invoice: {
      id: invoice.id,
      status: result.invoice.status,
      total: toMajor(result.totalMinor),
      paid: toMajor(result.paidMinor),
      balance: toMajor(result.balanceMinor),
    },
  });
});

const getInvoicePayments = asyncHandler(async (req, res) => {
  // invoiceScope, not companyScope: a client must not read the payment history
  // of an invoice billed to someone else in the same company.
  const invoice = await Invoice.findOne({ where: { id: req.params.id, ...invoiceScope(req) } });
  if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
  const payments = await InvoicePayment.findAll({
    where: { invoice_id: req.params.id, ...companyScope(req) },
    order: [['id', 'DESC']],
  });

  /**
   * Each payment carries the proof of payment it was approved from.
   *
   * Once a proof is confirmed it leaves the review queue, so the document
   * became unreachable — the only record that a payment had evidence at all was
   * the receipt row nobody could navigate to. Attaching it here means the
   * history is the permanent home for it, which is also where anyone auditing
   * the payment would look.
   */
  const receipts = await Receipt.findAll({
    where: { invoice_id: req.params.id },
    attributes: ['id', 'receipt_number', 'document_url', 'status', 'invoice_payment_id', 'reference'],
  });
  const byPaymentId = new Map(
    receipts.filter((r) => r.invoice_payment_id).map((r) => [Number(r.invoice_payment_id), r]),
  );

  res.json({
    data: payments.map((payment) => {
      const receipt = byPaymentId.get(Number(payment.id));
      return {
        ...payment.get({ plain: true }),
        proof: receipt ? {
          receipt_id: receipt.id,
          receipt_number: receipt.receipt_number,
          document_url: receipt.document_url,
          status: receipt.status,
        } : null,
      };
    }),
    // The proofs still awaiting a decision, so a caller does not have to
    // re-derive that from an unfiltered list.
    pending_proofs: receipts
      .filter((r) => r.status === 'pending')
      .map((r) => ({ receipt_id: r.id, receipt_number: r.receipt_number, document_url: r.document_url })),
  });
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

/**
 * Commission approval and payment.
 *
 * Both were silent — a realtor's commission could be approved and paid without
 * them being told either time, which is the one thing they most want to hear.
 * The subject is the earner; the wider group is whoever holds
 * finance.commissions.view.
 */
const announceCommission = (commission, req, { eventKey, title, subjectLine, othersLine }) => {
  const amount = Number(commission.amount) || 0;
  notify.dispatch({
    eventKey,
    subjectUserId: commission.employee_id ?? null,
    companyId: commission.company_id ?? null,
    context: { commission },
    title: () => title,
    body: (role, ctx) => (role === 'subject'
      ? subjectLine(amount, commission)
      : othersLine(amount, commission, ctx.subject?.name || 'A team member')),
    data: { commission_id: commission.id, amount },
    actionLabel: 'View commissions',
    actionUrl: appUrl('finance/commissions', req),
  }).catch(() => {});
};

/**
 * The commission payout sequence: request, approve, pay.
 *
 * One actor per step, and each refuses to skip: an earner cannot approve their
 * own commission, and a commission cannot be paid before it is approved. The
 * status is the gate rather than a role check alone, so the order holds even
 * for someone who could legitimately do two of the steps.
 */

/** The commission, scoped so nobody reads another company's. */
const findCommission = async (req) => Commission.findOne({
  where: { id: req.params.id, ...companyScope(req) },
});

/**
 * The earner asks to be paid.
 *
 * Requested in FULL — there is no amount on this request, because a commission
 * is a single obligation and a partial payout would leave a remainder with no
 * due date. The amount is whatever the commission says.
 */
const requestCommissionPayout = asyncHandler(async (req, res) => {
  const commission = await Commission.findOne({ where: { id: req.params.id } });
  if (!commission) return res.status(404).json({ message: 'Commission not found' });

  // Strictly the earner's own. An admin wanting to move it along approves it.
  if (Number(commission.employee_id) !== Number(req.user?.id)) {
    return res.status(403).json({ message: 'You can only request payment of your own commission.' });
  }
  if (commission.status !== 'created') {
    return res.status(409).json({
      message: commission.status === 'payment_requested'
        ? 'You have already requested payment of this commission.'
        : `This commission is ${commission.status.replace(/_/g, ' ')} and cannot be requested.`,
    });
  }

  await commission.update({ status: 'payment_requested', requested_at: new Date() });

  notify.dispatch({
    eventKey: 'commission_approved',
    subjectUserId: commission.employee_id,
    companyId: commission.company_id ?? null,
    type: 'commission_payment_requested',
    title: () => 'Commission payment requested',
    body: (role, ctx) => (role === 'subject'
      ? `Your request to be paid ${Number(commission.amount).toLocaleString()} for "${commission.title}" `
        + 'has been submitted for approval.'
      : `${ctx.subject?.name || 'A realtor'} has requested payment of `
        + `${Number(commission.amount).toLocaleString()} for "${commission.title}".`),
    data: { commission_id: commission.id, amount: Number(commission.amount) },
    actionLabel: 'Review commissions',
    actionUrl: appUrl('commissions', req),
  }).catch(() => {});

  res.json({ data: commission });
});

const approveCommission = asyncHandler(async (req, res) => {
  const commission = await findCommission(req);
  if (!commission) return res.status(404).json({ message: 'Commission not found' });

  // Approvable from created or payment_requested: an admin may approve ahead of
  // the earner asking, which is a courtesy, not a different outcome.
  if (!['created', 'payment_requested'].includes(commission.status)) {
    return res.status(409).json({
      message: `Cannot approve a commission that is ${commission.status.replace(/_/g, ' ')}.`,
    });
  }
  if (Number(commission.employee_id) === Number(req.user?.id) && !req.user?.isSuperiorAdmin) {
    return res.status(403).json({ message: 'You cannot approve your own commission.' });
  }

  await commission.update({
    status: 'approved',
    approved_at: new Date(),
    approved_by: req.user?.id ?? null,
  });

  const fmt = await formatMoneyFor(commission.company_id ?? null);
  announceCommission(commission, req, {
    eventKey: 'commission_approved',
    title: 'Commission approved',
    subjectLine: (amount, c) => `Your commission of ${fmt(amount)} for "${c.title}" has been approved `
      + 'and is awaiting payment.',
    othersLine: (amount, c, who) => `${who}'s commission of ${fmt(amount)} for "${c.title}" was approved.`,
  });

  res.json({ data: commission });
});

/**
 * Pays an approved commission, in full, writing the ledger DEBIT.
 *
 * The amount is not an input. Accepting one would allow a part payment, which
 * this deliberately does not support — see the commission model.
 */
const payCommission = asyncHandler(async (req, res) => {
  const commission = await findCommission(req);
  if (!commission) return res.status(404).json({ message: 'Commission not found' });
  if (commission.status !== 'approved') {
    return res.status(409).json({
      message: commission.status === 'paid'
        ? 'This commission has already been paid.'
        : 'A commission must be approved before it can be paid.',
    });
  }

  const { transactionId, amount } = await payOut({
    commission,
    paidBy: req.user?.id ?? null,
    method: String(req.body.payment_method || 'transfer'),
    reference: String(req.body.reference || '').trim() || null,
  });

  const fmt = await formatMoneyFor(commission.company_id ?? null);
  announceCommission(commission, req, {
    eventKey: 'commission_paid',
    title: 'Commission paid',
    subjectLine: () => `Your commission of ${fmt(amount)} for "${commission.title}" has been paid in full.`,
    othersLine: (a, c, who) => `${who}'s commission of ${fmt(amount)} for "${c.title}" was paid.`,
  });

  res.json({
    data: commission,
    // The ledger entry, so a caller can reconcile the payout immediately.
    transaction: { id: transactionId, entry_type: 'debit', amount },
  });
});

/** What the signed-in earner is owed. Drives their own commissions page. */
const getMyCommissions = asyncHandler(async (req, res) => {
  const employeeId = req.user?.id;
  const companyId = req.user?.company_id ?? null;

  const commissions = await Commission.findAll({
    where: { employee_id: employeeId, ...(companyId ? { company_id: companyId } : {}) },
    order: [['id', 'DESC']],
    limit: 200,
  });

  res.json({
    data: commissions,
    summary: await summaryFor({ employeeId, companyId }),
  });
});

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
  /**
   * ?status= filters the list.
   *
   * It looked as though it already did, because `status` is in searchFields —
   * but that only backs ?search=. So the review queue asking for
   * ?status=pending received EVERY receipt, and a caller picking the first one
   * for an invoice could land on a proof that had already been approved or
   * declined and offer to decide it again.
   */
  whereBuilder: (req) => {
    const status = String(req.query.status || '').trim();
    return status ? { status } : {};
  },
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
 * An admin approves a receipt, and the payment is allocated (FRD 7.2, 8).
 *
 * The credited amount defaults to what the buyer declared but the admin may
 * record a different figure, and may correct the value date with it — a
 * transfer confirmed today may have left the client's account last week, and
 * the schedules it settles are dated. Allocation uses the ADMIN-APPROVED
 * amount, never the client-entered claim (FRD 5.3).
 *
 * Two things this deliberately no longer does:
 *
 *   It does not CLAMP the amount to the outstanding balance. FRD 8.2 requires a
 *   surplus beyond every schedule to become a credit balance flagged for an
 *   admin; clamping silently discarded money a client had actually sent.
 *
 *   It does not decide anything about the ledger itself. Allocation, fee
 *   settlement, the inventory hold and every status recalculation are one
 *   transaction inside allocationService (FRD 7.3, 16), shared with every other
 *   way a payment can be recorded.
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

  const requested = req.body.amount == null ? Number(receipt.amount) : Number(req.body.amount);
  if (!Number.isFinite(requested) || requested <= 0) {
    return res.status(400).json({ message: 'Enter the amount being credited.' });
  }

  /**
   * The method and the transaction reference are REQUIRED, and come from the
   * admin rather than from the receipt.
   *
   * Both used to be inherited from what the buyer typed on upload, falling back
   * to 'bank_transfer' and a synthesised `RCPT-…` string. That meant the ledger
   * recorded the buyer's unverified claim about how they paid, and carried a
   * reference that corresponds to nothing at the bank — so a payment could not
   * be reconciled against a statement, which is the main thing a reference is
   * for.
   *
   * The admin is looking at the proof of payment when they approve, so they are
   * the one who can read the real reference off it.
   */
  const method = String(req.body.payment_method || '').trim().toLowerCase();
  if (!CONFIRMABLE_PAYMENT_METHODS.includes(method)) {
    return res.status(400).json({
      message: 'Choose how the payment was made: '
        + `${CONFIRMABLE_PAYMENT_METHODS.join(', ')}.`,
      payment_methods: CONFIRMABLE_PAYMENT_METHODS,
    });
  }

  const reference = String(req.body.reference || '').trim();
  if (!reference) {
    return res.status(400).json({
      message: 'Enter the transaction reference from the proof of payment. '
        + 'It is what reconciles this payment against the bank statement.',
    });
  }

  // The receipt update joins the allocation's transaction, so a receipt can
  // never end up verified without its payment — nor a payment recorded against
  // a receipt that stayed pending.
  const transaction = await sequelize.transaction();
  let result;
  try {
    result = await applyApprovedPayment({
      invoiceId: invoice.id,
      amountMinor: toMinor(requested),
      paymentMethod: method,
      reference,
      note: String(req.body.notes || receipt.notes || '').trim() || null,
      approvedBy: req.user?.id ?? null,
      valueDate: req.body.value_date || req.body.payment_date || null,
      companyId: invoice.company_id ?? null,
    }, transaction);

    await receipt.update({
      status: 'verified',
      amount: requested,
      // Overwritten with the admin's figures: the buyer's guess at the method
      // and reference is superseded by what was actually confirmed.
      payment_method: method,
      reference,
      invoice_payment_id: result.paymentId,
      verified_by: req.user?.id ?? null,
      verified_at: new Date(),
    }, { transaction });

    await transaction.commit();
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }

  // Everything below is after the commit: the money is recorded, and a failing
  // SMTP host must not undo it.
  const fmt = await formatMoneyFor(invoice.company_id ?? null);
  const balance = toMajor(result.balanceMinor);

  purchaseNotifier.dispatch({
    eventKey: result.paidInFull ? 'invoice_fully_paid' : 'payment_approved',
    invoiceId: invoice.id,
    type: result.paidInFull ? 'invoice_paid' : 'invoice_payment_verified',
    title: (role, ctx) => (result.paidInFull
      ? `Invoice ${ctx.invoice_id} settled`
      : `Payment received for ${ctx.invoice_id}`),
    /**
     * FRD 12.3: property and unit, invoice reference, amount due and due date,
     * and where a default fee has been applied, the fee and the resulting total
     * payable. The realtor's copy names the client, because FRD 12.2's stated
     * intent for the realtor is to engage them and drive collection.
     */
    body: (role, ctx) => {
      const who = role === 'client' ? 'Your' : `${ctx.client_name || 'A client'}'s`;
      const subject = purchaseNotifier.describeSubject(ctx);
      const head = `${who} payment of ${fmt(toMajor(result.appliedMinor))} on ${subject} `
        + `(invoice ${ctx.invoice_id}) has been approved.`;
      if (result.paidInFull) return `${head}\n\nThe invoice is now fully settled.`;

      const nextDue = (result.schedules || []).find((s) => s.settlement_status !== 'paid');
      const fees = result.schedules
        ? result.schedules.reduce((sum, s) => sum + asMinor(s.fee_outstanding_minor), 0)
        : 0;
      return [
        head,
        `Outstanding balance: ${fmt(balance)}.`,
        fees > 0 ? `That includes ${fmt(toMajor(fees))} in default fees.` : null,
        nextDue ? `Next payment of ${fmt(toMajor(asMinor(nextDue.principal_outstanding_minor) + asMinor(nextDue.fee_outstanding_minor)))} is due on ${purchaseNotifier.onDate(nextDue.due_date)}.` : null,
      ].filter(Boolean).join('\n');
    },
    data: { amount: toMajor(result.appliedMinor), balance },
    actionLabel: 'View invoice',
    actionUrl: appUrl(`finance/invoices/${invoice.id}`, req),
  }).catch(() => {});

  /**
   * The sale is complete, so the commission on it is now owed.
   *
   * Generated here rather than at purchase because this is the point at which
   * the company actually holds the money — a commission raised at purchase
   * would be a payable for a sale that might never complete. After the commit,
   * and swallowing its own failures: a missing commission rule must not undo a
   * payment that has already been approved.
   */
  if (result.paidInFull) {
    generateForSale({ invoice, basisAmount: toMajor(result.totalMinor) })
      .then((outcome) => {
        if (!outcome.created) return;
        const earned = Number(outcome.created.amount) || 0;
        notify.dispatch({
          eventKey: 'commission_approved',
          subjectUserId: outcome.created.employee_id,
          companyId: outcome.created.company_id ?? null,
          type: 'commission_created',
          title: () => 'Commission earned',
          body: (role, ctx) => (role === 'subject'
            ? `You have earned ${fmt(earned)} on "${outcome.created.title}". `
              + 'You can request payment of it from your commissions page.'
            : `${ctx.subject?.name || 'A realtor'} earned ${fmt(earned)} on `
              + `"${outcome.created.title}".`),
          data: { commission_id: outcome.created.id, amount: earned },
          actionLabel: 'View commissions',
          actionUrl: appUrl('commissions/mine', req),
        }).catch(() => {});
      })
      .catch((err) => console.error('[commission] generation failed:', err.message));
  }

  if (result.planCompleted) {
    purchaseNotifier.dispatch({
      eventKey: 'payment_plan_completed',
      invoiceId: invoice.id,
      type: 'payment_plan_completed',
      title: (role, ctx) => `Payment plan completed — ${ctx.invoice_id}`,
      body: (role, ctx) => (role === 'client'
        ? `Every installment on ${purchaseNotifier.describeSubject(ctx)} has been paid. Invoice ${ctx.invoice_id} is complete.`
        : `${ctx.client_name || 'A client'} has completed their payment plan on ${purchaseNotifier.describeSubject(ctx)} (invoice ${ctx.invoice_id}).`),
    }).catch(() => {});
  }

  /**
   * FRD 10.3 contention: this payment placed a hold that other open invoices on
   * the same unit can no longer be fulfilled against.
   *
   * Their clients AND their realtors are told the newly available quantity and
   * that their invoice cannot be filled in full. The invoices are NOT cancelled
   * — FRD 10.3 is explicit that they stay open pending client or admin action.
   */
  (result.contended || []).forEach((other) => {
    purchaseNotifier.dispatch({
      eventKey: 'availability_reduced',
      invoiceId: other.id,
      type: 'availability_reduced',
      title: () => `Availability reduced on ${other.unit_name}`,
      body: (role) => {
        const available = result.availableAfter ?? 0;
        const remaining = available === 0
          ? `There are now no units of "${other.unit_name}" left on ${other.property_name}.`
          : `Only ${available} unit${available === 1 ? '' : 's'} of "${other.unit_name}" on ${other.property_name} remain.`;
        const subject = role === 'client'
          ? `your invoice ${other.invoice_id} is for ${other.quantity}`
          : `${other.client_name || 'your client'}'s invoice ${other.invoice_id} is for ${other.quantity}`;
        return [
          `${remaining} Because ${subject}, it can no longer be fulfilled in full.`,
          '',
          'The invoice has NOT been cancelled. An admin can reduce its quantity to what is '
            + 'available, or cancel it so a new one can be raised.',
        ].join('\n');
      },
      data: { quantity_available: result.availableAfter ?? 0, invoiced_quantity: other.quantity },
      actionLabel: 'View invoice',
      actionUrl: appUrl(`finance/invoices/${other.id}`, req),
    }).catch(() => {});
  });

  /**
   * Surplus beyond every schedule needs a human.
   *
   * This used to fetch every admin in the company and mail them directly.
   * It is now a configured event, so it reaches whoever holds
   * finance.payment-schedules.view — the people who can actually allocate or
   * refund it — and a company can retarget it without a code change.
   */
  if (result.creditBalanceMinor > 0) {
    purchaseNotifier.dispatch({
      eventKey: 'invoice_credit_balance',
      invoiceId: invoice.id,
      type: 'invoice_credit_balance',
      title: (role, ctx) => `Overpayment on invoice ${ctx.invoice_id}`,
      body: (role, ctx) => `${fmt(toMajor(result.creditBalanceMinor))} was paid beyond every schedule on `
        + `invoice ${ctx.invoice_id} (${purchaseNotifier.describeSubject(ctx)}) and is being held as a `
        + 'credit balance. It needs allocating or refunding.',
      data: { credit_balance: toMajor(result.creditBalanceMinor) },
      actionLabel: 'View invoice',
      actionUrl: appUrl(`finance/invoices/${invoice.id}`, req),
    }).catch(() => {});
  }

  return res.json({
    data: {
      receipt,
      payment: { id: result.paymentId, amount: toMajor(result.appliedMinor) },
      invoice: {
        id: invoice.id,
        status: result.invoice.status,
        total: toMajor(result.totalMinor),
        paid: toMajor(result.paidMinor),
        balance,
      },
      // The line-level trail this approval produced (FRD 8.4), so the admin
      // sees where their approval actually landed rather than only a new
      // balance.
      allocations: (result.lines || []).map((line) => ({
        schedule_id: line.schedule_id,
        sequence: line.sequence,
        due_date: line.due_date,
        principal: toMajor(line.principal_minor),
        fee: toMajor(line.fee_minor),
        settlement_status: line.next.settlement_status,
      })),
      credit_balance: toMajor(result.creditBalanceMinor),
      hold: result.hold,
      contended_invoices: (result.contended || []).map((o) => ({
        id: o.id, invoice_id: o.invoice_id, quantity: o.quantity,
      })),
    },
  });
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
    // Hand the invoice back so the client can resubmit (FRD 7.2). Back to
    // partially_paid rather than sent where money has already been approved
    // against it, so a rejected receipt does not erase the payments that stand.
    const money = await outstandingFor(invoice);
    await invoice.update({ status: money.paid > 0 ? 'partially_paid' : 'sent' });

    // FRD 12.2 sends a rejection to the realtor as well as the client — they
    // are the one who will chase the corrected proof.
    purchaseNotifier.dispatch({
      eventKey: 'payment_rejected',
      invoiceId: invoice.id,
      type: 'invoice_receipt_rejected',
      title: (role, ctx) => `Payment proof not accepted — ${ctx.invoice_id}`,
      body: (role, ctx) => (role === 'client'
        ? `Your proof of payment for ${purchaseNotifier.describeSubject(ctx)} was not accepted.\n\n`
          + `Reason: ${notes}\n\nYou can submit a corrected receipt from the invoice page.`
        : `${ctx.client_name || 'A client'}'s proof of payment on invoice ${ctx.invoice_id} was not `
          + `accepted.\n\nReason: ${notes}`),
      data: { receipt_id: receipt.id, reason: notes },
      actionLabel: 'View invoice',
      actionUrl: appUrl(`finance/invoices/${invoice.id}`, req),
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
  approveCommission, payCommission, requestCommissionPayout, getMyCommissions,
  commissionRuleCrud, calculateCommission,
  receiptCrud, createReceipt, verifyReceipt, rejectReceipt,
};

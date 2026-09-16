const crypto = require('crypto');
const { q, castText } = require('../../../../shared/src/dialect');
const { fn, col, Op, QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { buildCrudController, buildCompanyScope, withCompanyAudit } = require('../utils/crudFactory');
const { nextNumber } = require('../../../../shared/src/documentSequence');
const {
  Invoice, InvoicePayment, InvoiceProduct, Transaction, Tax, PaymentPlan,
  BankAccount, CreditNote, DebitNote, PaymentReminder, Commission,
  CommissionRule, Receipt, InvoiceDocument,
  ReferralSetting, ReferralTransaction,
} = require('../models');
const { sequelize } = require('../models');
const { resolveViewableUser } = require('../../../../shared/src/viewerAccess');
const { appUrl } = require('../../../../shared/src/appOrigin');
const { GATEWAYS, paymentSettingsFor } = require('../utils/paymentGateways');
const { applyApprovedPayment } = require('../services/allocationService');
const { generateForSale, payOut, summaryFor } = require('../services/commissionService');
const { companyEarnings } = require('../../../../shared/src/commissionEarnings');
const commissionEngine = require('../services/commissionBridge');
const { readPaymentPlan } = require('../../../../shared/src/paymentPlanGateway');
const { requiresCompanyReceipt } = require('../../../../shared/src/receiptPolicy');
const { applyInvoiceDiscount } = require('../services/discountService');
const { payableFor } = require('../../../../shared/src/invoiceDiscount');
const { asMinor, toMinor, toMajor } = require('../../../../shared/src/money');
const { createPurchaseNotifier } = require('../../../../shared/src/purchaseNotifications');
const { createDispatcher } = require('../../../../shared/src/notificationDispatcher');
const {
  realtorVerification, realtorBlockedMessage, staffBlockedMessage,
} = require('../../../../shared/src/realtorVerification');
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

/**
 * A receipt is owned by the client whose payment it evidences.
 *
 * Without this the receipts endpoints stayed staff-only, which is why a buyer
 * had nowhere to see a payment they had submitted: the row existed, carried a
 * status, and was unreachable by the one person waiting on it.
 */
const receiptScope = (req) => {
  const base = companyScope(req);
  return isSelfScoped(req) ? { ...base, client_id: req.user.id } : base;
};

/** Transactions (payments) are owned by the user they were recorded against. */
const transactionScope = (req) => {
  const base = companyScope(req);
  return isSelfScoped(req) ? { ...base, user_id: req.user.id } : base;
};

/** How many times a reference collision is retried before giving up. */
const REFERENCE_ATTEMPTS = 5;

/**
 * Creates a row with a generated reference.
 *
 * The number comes from an atomic per-company counter (see
 * utils/documentSequence.js), so concurrent creates do not contend for the
 * same one — the earlier MAX()+1 approach had twelve simultaneous creates
 * fighting over the same number and exhausting their retries.
 *
 * The retry is kept as a BACKSTOP, not as the mechanism. It covers the case
 * where the counter and the data disagree — a row inserted directly, a
 * restored backup — because the unique index refuses the write and the next
 * attempt re-seeds the counter from what is actually there.
 */
const createWithReference = async (Model, { field, prefix, companyId, payload, transaction = null }) => {
  const docType = Model.getTableName();
  let lastError;

  for (let attempt = 0; attempt < REFERENCE_ATTEMPTS; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const reference = await nextNumber(sequelize, {
      docType, table: docType, field, prefix, companyId, transaction,
    });
    try {
      // eslint-disable-next-line no-await-in-loop
      return await Model.create({ ...payload, [field]: reference }, { transaction });
    } catch (error) {
      const isDuplicate = error.name === 'SequelizeUniqueConstraintError'
        || error.original?.code === 'ER_DUP_ENTRY'
        || error.parent?.code === 'ER_DUP_ENTRY';
      if (!isDuplicate) throw error;
      lastError = error;
    }
  }

  throw Object.assign(
    new Error('Could not assign a reference number. Please try again.'),
    { status: 409, cause: lastError },
  );
};

/**
 * Resolves the ids an invoice carries into the names a person can read, and
 * attaches what was actually bought.
 *
 * An invoice stores client_id and property_id, so a view rendered straight from
 * the row showed "Client 42" — which tells nobody anything. Both live in tables
 * this service does not own, so they are resolved in one query per page rather
 * than joined.
 *
 * `purchase` is the same idea one step further: the invoice says WHICH property
 * but not which unit configuration or how many, and those are what a buyer
 * recognises their own invoice by. They live on the purchase request that
 * raised it — which already denormalises unit_label and unit_price precisely so
 * they survive the unit being deleted — so they are read from there rather than
 * copied onto the invoice, where a second copy could disagree with the first.
 *
 * Every lookup is best-effort. property_purchase_requests belongs to
 * property-service and in a split deployment may be in another database
 * entirely; an invoice that renders without its unit line is a lesser failure
 * than an invoice list that 500s.
 */
const withInvoiceNames = async (rows) => {
  const list = Array.isArray(rows) ? rows : [rows];
  const clientIds = [...new Set(list.map((r) => r.client_id).filter(Boolean))];
  const propertyIds = [...new Set(list.map((r) => r.property_id).filter(Boolean))];

  const invoiceIds = [...new Set(list.map((r) => r.id).filter(Boolean))];

  /**
   * The purchase requests are read FIRST, not alongside the rest.
   *
   * They can name a property the invoice row itself does not, and the property
   * lookup below batches by id — so resolving them in parallel would leave
   * exactly the invoices that need the fallback without a name for it.
   */
  const purchases = invoiceIds.length
    ? await sequelize.query(
      `SELECT invoice_id, property_id, unit_id, unit_label, unit_price, quantity, payment_mode
         FROM property_purchase_requests
        WHERE invoice_id IN (:ids)
        ORDER BY id ASC`,
      { replacements: { ids: invoiceIds }, type: QueryTypes.SELECT }).catch(() => [])
    : [];

  const allPropertyIds = [...new Set([
    ...propertyIds,
    ...purchases.map((r) => r.property_id).filter(Boolean),
  ])];

  const [clients, properties] = await Promise.all([
    clientIds.length
      ? sequelize.query('SELECT id, name, email, phone FROM users WHERE id IN (:ids)',
        { replacements: { ids: clientIds }, type: QueryTypes.SELECT }).catch(() => [])
      : [],
    allPropertyIds.length
      ? sequelize.query('SELECT id, name FROM properties WHERE id IN (:ids)',
        { replacements: { ids: allPropertyIds }, type: QueryTypes.SELECT }).catch(() => [])
      : [],
  ]);

  const clientById = new Map(clients.map((c) => [Number(c.id), c]));
  const propertyById = new Map(properties.map((p) => [Number(p.id), p]));
  // First request wins: ORDER BY id ASC above makes "first" the original one,
  // so a later duplicate cannot silently restate what an invoice was for.
  const purchaseByInvoice = new Map();
  for (const row of purchases) {
    const key = Number(row.invoice_id);
    if (!purchaseByInvoice.has(key)) purchaseByInvoice.set(key, row);
  }

  const decorate = (row) => {
    const plain = row.get ? row.get({ plain: true }) : row;
    const client = clientById.get(Number(plain.client_id));
    const purchase = purchaseByInvoice.get(Number(plain.id));
    /**
     * property_id falls back to the purchase request's own.
     *
     * They agree on everything raised through the purchase flow. They can
     * differ on an older invoice written before the column was populated, and
     * there the request is the one that actually knows.
     */
    const propertyId = plain.property_id ?? purchase?.property_id ?? null;
    return {
      ...plain,
      property_id: propertyId,
      client_name: client ? (client.name || client.email) : null,
      client_email: client?.email ?? null,
      client_phone: client?.phone ?? null,
      property_name: propertyById.get(Number(propertyId))?.name ?? null,
      // null, not an empty object: "this invoice was not raised against a
      // purchase" and "it was, for nothing" are different answers.
      purchase: purchase ? {
        property_id: purchase.property_id ?? null,
        unit_id: purchase.unit_id ?? null,
        unit_label: purchase.unit_label ?? null,
        unit_price: purchase.unit_price == null ? null : Number(purchase.unit_price),
        quantity: Number(purchase.quantity) || 1,
        payment_mode: purchase.payment_mode ?? null,
      } : null,
    };
  };

  return Array.isArray(rows) ? list.map(decorate) : decorate(rows);
};

/**
 * Searching by the name of a person, on a table that stores only their id.
 *
 * Reused by every list whose rows are ABOUT somebody — invoices, payments,
 * receipts, commissions. "Find Ada's invoices" is the most natural thing to
 * type into an invoice search and matched nothing before this, because an
 * invoice knows a client_id and nothing else about the client.
 *
 * Phone and email are included alongside the name because they are what a
 * person on a support call actually reads out.
 */
const PERSON_FIELDS = ['name', 'email', 'phone'];
const personRelation = (column) => ({ column, table: 'users', fields: PERSON_FIELDS });
const propertyRelation = (column) => ({ column, table: 'properties', fields: ['name', 'address', 'city'] });

const invoiceCrud = buildCrudController(Invoice, {
  afterList: withInvoiceNames,
  afterGet: withInvoiceNames,
  /**
   * A changed discount is spread across the installments still to be paid.
   *
   * `invoices.discount` used to be a display field — it showed on the invoice,
   * fed the commission base, and changed nothing about what the buyer owed. The
   * schedule ledger still demanded the full amount, so somebody granted a
   * discount was chased for it anyway.
   *
   * Run after the row is saved rather than before, so the spread is computed
   * from the discount that was actually stored. Its own transaction, and its
   * failure is logged rather than thrown: the edit the admin made has already
   * succeeded, and the spread is re-derived from scratch on the next change.
   */
  afterUpdate: async (entity, req) => {
    if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'discount')) return entity;
    await applyInvoiceDiscount(entity.id).catch((error) => {
      console.error(`[discount] invoice ${entity.id}: ${error.message}`);
    });
    return entity;
  },
  include: ['payments', 'products', 'tax'],
  searchFields: ['invoice_id', 'status', 'notes', 'reference'],
  searchRelations: [personRelation('client_id'), propertyRelation('property_id')],
  defaultWhere: invoiceScope, scopeWhere: invoiceScope,
  beforeCreate: async (req) => withCompanyAudit(req),
  createWith: (payload) => createWithReference(Invoice, {
    field: 'invoice_id', prefix: 'INV-', companyId: payload.company_id ?? null, payload,
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
  /**
   * ONE beforeUpdate, deliberately.
   *
   * There were two keys with this name in this object. JavaScript keeps the
   * last, so the earlier one — the guard stopping an invoice being moved to a
   * different client — was silently dead: the property it defined was
   * overwritten before the object ever reached buildCrudController, and every
   * edit could reassign the client. Both sets of rules live here now.
   */
  beforeUpdate: async (req, invoice) => {
    const { client_id: attempted, invoice_id: _reference, ...payload } = req.body;

    /**
     * Reassigning the client is refused, not ignored.
     *
     * Moving an invoice to another person would carry its payments, its
     * inventory hold and any commission to someone who never agreed to the
     * purchase, while keeping the reference already sent to the original
     * buyer. Cancel and reissue instead.
     */
    if (attempted != null && Number(attempted) !== Number(invoice.client_id)) {
      throw Object.assign(
        new Error('An invoice cannot be moved to a different client. Cancel it and raise a new one.'),
        { status: 409 },
      );
    }

    // The reference is the invoice's identity in the ledger and on whatever
    // the client was sent. Assigned once, never edited.

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
/**
 * A completed payment is a record of money that moved, not a draft.
 *
 * Every `INSERT INTO transactions` in this codebase writes `status:
 * 'completed'` — the row is created BECAUSE a payment settled, so by the time
 * one exists the amount has been allocated against an invoice, reported, and
 * possibly had commission paid on it. Editing it in place would change all
 * three silently and leave nothing saying what the figure used to be.
 *
 * Correcting a settled payment is an accounting action — a credit note, a
 * reversing entry — which is why this refuses rather than warns. `receipts`
 * states the same rule for a verified payment: approved means frozen.
 *
 * Enforced here and not only in the UI. The Payments table hides its Edit
 * button on a completed row, but a hidden button is a courtesy, not a
 * permission: the PUT is still reachable by anyone who can open a console.
 */
const FROZEN_TRANSACTION_STATUSES = ['completed', 'approved', 'paid', 'verified', 'cancelled', 'reversed'];

const refuseFrozenEdit = (req, entity) => {
  const status = String(entity?.status || '').toLowerCase();
  if (FROZEN_TRANSACTION_STATUSES.includes(status)) {
    const error = new Error(
      `This payment is ${status} and can no longer be edited. `
      + 'Raise a credit note or a reversing entry to correct it.',
    );
    error.status = 409;
    throw error;
  }
  return req.body;
};

const transactionCrud = buildCrudController(Transaction, {
  searchFields: ['type', 'status', 'reference', 'description', 'payment_method'],
  searchRelations: [personRelation('user_id')],
  defaultWhere: transactionScope, scopeWhere: transactionScope,
  beforeUpdate: refuseFrozenEdit,
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

/**
 * A document number is assigned by the system and never edited.
 *
 * Stripped on UPDATE rather than merely ignored on create: the number is the
 * document's identity in the ledger and in whatever the client was sent, so
 * letting an edit rewrite it would silently break the link between them — and
 * would let two documents be pointed at the same reference by hand, which is
 * exactly what the unique index exists to prevent.
 */
const withoutReference = (field) => (req) => {
  const { [field]: _ignored, ...rest } = req.body || {};
  return rest;
};

/**
 * Fields on a credit or debit note that only the approval workflow may set.
 *
 * A note moves money — a credit note writes off what is owed to the company, a
 * debit note creates something owed out of it — so its state is the record of a
 * decision somebody took, not a value the person raising it can choose. Stripped
 * on both create and update, which means the ordinary edit screen can no longer
 * approve a note by saving it with a different status.
 */
const APPROVAL_FIELDS = ['status', 'approved_by', 'approved_at', 'rejection_reason'];

const withoutApprovalFields = (payload = {}) => {
  const rest = { ...payload };
  APPROVAL_FIELDS.forEach((field) => { delete rest[field]; });
  return rest;
};

const creditNoteCrud = buildCrudController(CreditNote, {
  afterList: withPartyNames,
  include: ['tax'], searchFields: ['credit_note_id', 'status', 'reason'],
  searchRelations: [personRelation('client_id')],
  defaultWhere: companyScope, scopeWhere: companyScope,
  // The reference is assigned by createWith, so the body's is not consulted,
  // and the status is assigned by the model default — every note is raised
  // as pending_approval whatever the caller sent.
  beforeCreate: async (req) => withoutApprovalFields(await withCompanyAudit(req)),
  createWith: (payload) => createWithReference(CreditNote, {
    field: 'credit_note_id', prefix: 'CN-', companyId: payload.company_id ?? null, payload,
  }),
  beforeUpdate: (req) => withoutApprovalFields(withoutReference('credit_note_id')(req)),
});
/**
 * A debit note against a realtor is a payment instruction, so it obeys the same
 * rule as every other one: an unverified realtor cannot be paid.
 *
 * Caught HERE rather than at settlement, because by settlement an approver has
 * already signed something that was never payable, and the correction is a
 * reversal rather than a message. The note refuses to exist in the first place.
 *
 * Only for `party_type: 'realtor'`. A note against a client or a member of
 * staff has nothing to do with realtor verification, and blocking those would
 * be a rule nobody asked for.
 */
const assertRealtorPayable = async (req) => {
  if (req.body?.party_type !== 'realtor') return;

  const realtorId = req.body?.client_id;
  const verification = await realtorVerification(sequelize, realtorId);
  if (verification.verified) return;

  const [rows] = await sequelize.query(
    'SELECT name FROM users WHERE id = :id LIMIT 1',
    { replacements: { id: realtorId } },
  );

  const error = new Error(staffBlockedMessage(rows?.[0]?.name, verification.status));
  error.status = 422;
  throw error;
};

const debitNoteCrud = buildCrudController(DebitNote, {
  afterList: withPartyNames,
  include: ['tax'], searchFields: ['debit_note_id', 'status', 'reason'],
  searchRelations: [personRelation('client_id')],
  defaultWhere: companyScope, scopeWhere: companyScope,
  beforeCreate: async (req) => {
    await assertRealtorPayable(req);
    return withoutApprovalFields(await withCompanyAudit(req));
  },
  createWith: (payload) => createWithReference(DebitNote, {
    field: 'debit_note_id', prefix: 'DN-', companyId: payload.company_id ?? null, payload,
  }),
  beforeUpdate: (req) => withoutApprovalFields(withoutReference('debit_note_id')(req)),
});
const paymentReminderCrud = buildCrudController(PaymentReminder, {
  include: ['invoice'], searchFields: ['status'],
  defaultWhere: companyScope, scopeWhere: companyScope,
  beforeCreate: (req) => withCompanyAudit(req),
});
const commissionCrud = buildCrudController(Commission, {
  searchFields: ['title', 'type', 'status', 'notes'],
  // The earner. `employee_id` by name, a realtor in practice — so searching a
  // commission list by realtor name is the obvious thing to want.
  searchRelations: [personRelation('employee_id'), propertyRelation('property_id')],
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
            /**
             * What was actually bought, not just where.
             *
             * A buyer choosing which invoice to pay was shown the reference and
             * the property, and two invoices against the same development are
             * then indistinguishable — the unit is the thing they recognise.
             *
             * Correlated subqueries rather than a join, for the reason the
             * payments query below gives: this SELECT already aggregates
             * payments, and a second join multiplying the rows would multiply
             * the paid total with them. A subquery cannot. LIMIT 1 because
             * nothing enforces one request per invoice, and a duplicate should
             * cost a label rather than break the figure.
             */
            (SELECT r.unit_label FROM property_purchase_requests r
              WHERE r.invoice_id = i.id ORDER BY r.id LIMIT 1) AS unit_label,
            (SELECT r.quantity FROM property_purchase_requests r
              WHERE r.invoice_id = i.id ORDER BY r.id LIMIT 1) AS quantity,
            COALESCE(SUM(CASE WHEN ip.status = 'completed' THEN ip.amount END), 0) AS paid
       FROM invoices i
       LEFT JOIN invoice_payments ip ON ip.invoice_id = i.id
       LEFT JOIN properties p ON p.id = i.property_id
      WHERE i.client_id = :userId
        ${hideDrafts ? "AND i.status <> 'draft'" : ''}
      /**
       * p.name is grouped explicitly, not just i.id.
       *
       * MySQL infers it: i.id is the invoice PK, p is joined on its own PK, so
       * it calls p.name functionally dependent and allows it. Postgres only
       * extends that inference to the table whose PK is grouped, so it rejects
       * a column from the joined table outright — "p.name must appear in the
       * GROUP BY clause". Naming it satisfies both, and cannot split a group:
       * each invoice already joins to at most one property.
       */
      GROUP BY i.id, p.name
      ORDER BY i.id DESC`,
    { replacements: { userId: target.id }, type: QueryTypes.SELECT },
  );

  const payments = await sequelize.query(
    `SELECT ip.id, ip.invoice_id, i.invoice_id AS invoice_ref, ip.amount,
            ip.payment_method, ip.status, ip.note, ip.created_at,
            /**
             * The company's receipt, carried from the approval that created
             * this payment (receipts.invoice_payment_id).
             *
             * Correlated subqueries rather than a LEFT JOIN on purpose. A join
             * multiplies this row if two receipts ever point at one payment —
             * which should not happen, and if it did the buyer would see the
             * same payment listed twice and conclude they had been charged
             * twice. A subquery cannot change the row count whatever the data
             * looks like.
             */
            (SELECT r.company_receipt_url FROM receipts r
              WHERE r.invoice_payment_id = ip.id AND r.company_receipt_url IS NOT NULL
              ORDER BY r.id LIMIT 1) AS company_receipt_url,
            (SELECT r.receipt_number FROM receipts r
              WHERE r.invoice_payment_id = ip.id
              ORDER BY r.id LIMIT 1) AS receipt_number,
            -- The receipt's own id, so this row can ask for the property, the
            -- unit and the balance when somebody opens it.
            (SELECT r.id FROM receipts r
              WHERE r.invoice_payment_id = ip.id
              ORDER BY r.id LIMIT 1) AS receipt_id
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
      /**
       * 'due' / 'in_progress' / 'pending' / 'paid' — what the client's tabs
       * filter on and what each row is labelled with.
       *
       * `in_progress` is an invoice that has taken money and still owes some.
       * It used to read as `pending`, which is the same word used for an
       * invoice nobody has paid a penny against — so a buyer part way through
       * an installment plan saw no acknowledgement that anything had landed.
       *
       * `due` still wins over it. A part-paid invoice past its date is overdue,
       * and that is the more urgent thing to say about it.
       */
      state: balance <= 0 ? 'paid'
        : overdue ? 'due'
        : paid > 0 ? 'in_progress'
        : 'pending',
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
        /**
         * Money outstanding and not yet overdue, whether or not something has
         * already been paid against it.
         *
         * Written as a condition rather than `state === 'pending'` on purpose:
         * splitting `in_progress` out of that state would otherwise have
         * dropped every part-paid invoice out of this total silently, and the
         * tile would have started understating what the buyer still owes.
         */
        pending: bucket((r) => !r.settled && r.state !== 'due'),
        in_progress: bucket((r) => r.state === 'in_progress'),
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
      `SELECT ${q(sequelize, 'value')}, company_id FROM settings
        WHERE ${q(sequelize, 'group')} = 'appearance' AND ${q(sequelize, 'key')} = 'currency'
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
            /**
             * Discounts are summed but never subtracted from the principal in
             * the database. Every schedule's principal still adds up to the
             * plan's total, which is what lets "total" and "paid + balance"
             * describe the same invoice — the discount is the third term that
             * makes them reconcile.
             */
            COALESCE(SUM(ps.discount_minor), 0) AS discount,
            MAX(ipp.total_minor) AS total_minor
       FROM invoice_payment_plans ipp
       JOIN payment_schedules ps ON ps.invoice_payment_plan_id = ipp.id
      WHERE ipp.invoice_id = :id`,
    { replacements: { id: invoice.id }, type: QueryTypes.SELECT },
  );

  if (Number(ledger?.schedules) > 0) {
    const feesAccrued = toMajor(asMinor(ledger.fee_accrued));
    const discount = asMinor(ledger.discount);
    /**
     * The balance is what the buyer must actually send: the outstanding
     * principal, less any discount on it, plus the fees. Reporting it without
     * the discount is what made a discount decorative — the invoice said one
     * thing and the payment page demanded another.
     */
    const principalDue = Math.max(asMinor(ledger.principal_outstanding) - discount, 0);
    return {
      // The agreed price. Fees are surfaced separately rather than folded in,
      // so "total" stays the figure the client agreed to and the UI can state
      // the fee and the resulting total payable (FRD 12.3). The discount is
      // stated too, for the same reason: it is a reduction against that price,
      // not a smaller price.
      total: toMajor(asMinor(ledger.total_minor)),
      paid,
      discount: toMajor(discount),
      balance: toMajor(principalDue + asMinor(ledger.fee_outstanding)),
      principal_balance: toMajor(principalDue),
      fees_accrued: feesAccrued,
      fees_outstanding: toMajor(asMinor(ledger.fee_outstanding)),
    };
  }

  const total = Number(invoice.amount) || 0;
  const discount = Number(invoice.discount) || 0;
  return {
    total,
    paid,
    discount,
    balance: Math.max(total - discount - paid, 0),
    fees_accrued: 0,
    fees_outstanding: 0,
  };
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
        discount: toMajor(asMinor(loaded.plan.discount_minor)),
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
        /**
         * The discount is stated beside the principal rather than folded into
         * it, so the installment still shows what it was agreed at. `payable`
         * is what the buyer must actually send — the figure the payment page
         * uses, so the page and the invoice cannot disagree.
         */
        discount: toMajor(asMinor(schedule.discount_minor)),
        payable: toMajor(payableFor(schedule)),
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
      /**
       * Whether this company requires its own receipt on approval.
       *
       * Returned from the endpoint the approval screen ALREADY calls when it
       * opens a review, so the screen can mark the upload required and refuse
       * to submit without one. Asking the settings API instead would need the
       * approving admin to hold the permission that edits settings, which the
       * approvals screen does not otherwise require.
       *
       * This is what the screen uses to explain itself. It is not the
       * enforcement — that is in verifyReceipt, where it cannot be skipped.
       */
      requires_company_receipt: await requiresCompanyReceipt(sequelize, companyId),
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
    attributes: [
      'id', 'receipt_number', 'document_url', 'status', 'invoice_payment_id', 'reference',
      // The receipt the COMPANY issued back, which is the one the buyer keeps.
      // `document_url` above is their own proof that they paid.
      'company_receipt_url',
    ],
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
          // Selecting the column was not enough — the object handed to the
          // client is built field by field, so it had to be named here too.
          company_receipt_url: receipt.company_receipt_url,
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

/**
 * Commission, for the finance reports — from BOTH systems.
 *
 * ── Why this endpoint exists at all ─────────────────────────────────────────
 *
 * The reports page read `/commissions`, which is the older flat-rate table, and
 * summed it in the browser. On a company running the engine that table is
 * empty, so the page reported "Commissions Paid 0" beside a Total Revenue of
 * ₦29m — while the engine held ₦1.1m paid. Two tables, one screen, and the
 * screen knew about the wrong one.
 *
 * Summing in the browser was the other half of the problem: it can only total
 * the rows the page happened to fetch, which is one page of ten. A figure
 * labelled "total" that is really "total of the first ten" is worse than no
 * figure, because nothing about it looks partial.
 */
const commissionReport = asyncHandler(async (req, res) => {
  const companyId = companyScope(req).company_id ?? null;
  const { from = null, to = null } = req.query;

  const totals = await companyEarnings(sequelize, { companyId, from, to });

  /**
   * The rows behind it, unioned so the tab and the headline agree. A screen
   * whose total says ₦1.1m over an empty table is one nobody believes.
   */
  /*
   * `status` is cast to text on both sides: commission_entitlements.status is a
   * VARCHAR created by migration while commissions.status is a Sequelize ENUM,
   * and Postgres refuses to union the two — "UNION types character varying and
   * enum_commissions_status cannot be matched". MySQL unions them happily,
   * which is why this only ever failed in production.
   */
  const rows = await sequelize.query(
    `SELECT id, earner_id, title, amount, status, earned_at, source FROM (
       SELECT e.id, e.realtor_id AS earner_id,
              CONCAT('Commission — ', e.deal_ref) AS title,
              (e.constrained_minor - e.forfeited_minor - e.clawed_back_minor) / 100 AS amount,
              ${castText(sequelize, 'e.status')} AS status, e.attribution_date AS earned_at, 'engine' AS source
         FROM commission_entitlements e
        WHERE 1 = 1 ${companyId ? 'AND e.company_id = :companyId' : ''}
          ${from ? 'AND e.attribution_date >= :from' : ''}
          ${to ? 'AND e.attribution_date <= :to' : ''}
       UNION ALL
       SELECT c.id, c.employee_id AS earner_id, c.title, c.amount,
              ${castText(sequelize, 'c.status')} AS status,
              c.created_at AS earned_at, 'flat_rate' AS source
         FROM commissions c
        WHERE 1 = 1 ${companyId ? 'AND c.company_id = :companyId' : ''}
          ${from ? 'AND c.created_at >= :from' : ''}
          ${to ? 'AND c.created_at <= :to' : ''}
     ) AS earned
     ORDER BY earned_at DESC, id DESC
     LIMIT 500`,
    {
      replacements: {
        ...(companyId ? { companyId } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}),
      },
      type: QueryTypes.SELECT,
    },
  ).catch(() => []);

  const earnerIds = [...new Set(rows.map((row) => row.earner_id).filter(Boolean))];
  const names = earnerIds.length
    ? await sequelize.query('SELECT id, name FROM users WHERE id IN (:ids)',
      { replacements: { ids: earnerIds }, type: QueryTypes.SELECT }).catch(() => [])
    : [];
  const nameOf = new Map(names.map((row) => [Number(row.id), row.name]));

  res.json({
    data: rows.map((row) => ({
      ...row,
      amount: Number(row.amount) || 0,
      earner_name: nameOf.get(Number(row.earner_id)) || null,
    })),
    /**
     * Totalled on the SERVER, over everything — not over the rows above, which
     * are capped. The cap is stated so a company past it knows the list is a
     * sample while the totals are not.
     */
    totals: {
      ...totals,
      rows_returned: rows.length,
      rows_capped: rows.length >= 500,
    },
  });
});

const revenueReport = asyncHandler(async (req, res) => {
  const totals = await InvoicePayment.findAll({
    attributes: [[fn('sum', col('amount')), 'revenue']],
    where: { status: 'completed', ...companyScope(req) },
    raw: true,
  });
  res.json({ data: { revenue: Number(totals[0]?.revenue || 0) } });
});

/**
 * Top performing properties, units and clients — by money actually RECEIVED.
 *
 * ── Why received, and not invoiced ──────────────────────────────────────────
 *
 * Ranking by invoice value flatters whoever raised the biggest unpaid invoice.
 * A "top performer" table that puts an unpaid ₦400m listing above a fully
 * settled ₦120m one is worse than no table, because it is confidently wrong in
 * the direction people act on. Only completed payments count here.
 *
 * ── Where the unit comes from ───────────────────────────────────────────────
 *
 * An invoice stores property_id but no unit: the unit lives on the
 * purchase_request that produced the invoice, which is the one place it is
 * recorded for OUTRIGHT purchases as well as instalment ones. Reading it from
 * invoice_payment_plans instead would have silently limited this to instalment
 * sales — roughly a report of one payment type wearing the label of all of
 * them.
 *
 * Sales made without going through the purchase flow therefore have no unit and
 * are counted in the property and client tables but not the unit one. That is
 * reported as `units_unattributed` rather than left to look like zero.
 *
 * Computed in SQL and in one round trip per table. The alternative — shipping
 * every invoice and payment to the browser to be grouped there — is what the
 * dashboard already does elsewhere, and it does not scale past a few thousand
 * rows.
 */
const topPerformersReport = asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 25);
  const scope = companyScope(req);
  const companyId = scope.company_id ?? null;
  // A platform admin has no company and sees everything; a company admin is
  // bounded to their own. Written as a fragment because it is applied to three
  // different queries over different tables.
  const companyFilter = (alias) => (companyId == null ? '' : `AND ${alias}.company_id = :companyId`);
  const replacements = {
    limit,
    ...(companyId == null ? {} : { companyId }),
    ...(req.query.start_date ? { startDate: new Date(req.query.start_date) } : {}),
    ...(req.query.end_date ? { endDate: new Date(req.query.end_date) } : {}),
  };
  // Payments are dated by when the money landed, not when the invoice was cut.
  const dateFilter = [
    req.query.start_date ? 'AND p.created_at >= :startDate' : '',
    req.query.end_date ? 'AND p.created_at <= :endDate' : '',
  ].join(' ');

  /**
   * Ranking companies only makes sense for a caller who can see more than one.
   *
   * A company admin is bounded to their own, so grouping by company_id would
   * return a single row — a "leaderboard" of one, which says nothing and looks
   * broken. null tells the UI there is nothing to show rather than handing it
   * an empty list to render as "no data".
   */
  const crossCompany = companyId == null;

  const [properties, units, clients, unattributed, companies, branches] = await Promise.all([
    sequelize.query(
      `SELECT i.property_id AS id,
              COUNT(DISTINCT i.id) AS invoices,
              SUM(p.amount)        AS received
         FROM invoice_payments p
         JOIN invoices i ON i.id = p.invoice_id
        WHERE p.status = 'completed'
          AND i.property_id IS NOT NULL
          ${companyFilter('i')} ${dateFilter}
        GROUP BY i.property_id
        ORDER BY received DESC
        LIMIT :limit`,
      { replacements, type: QueryTypes.SELECT },
    ),
    sequelize.query(
      `SELECT pr.unit_id            AS id,
              MAX(pr.unit_label)    AS label,
              MAX(pr.property_id)   AS property_id,
              COUNT(DISTINCT i.id)  AS invoices,
              SUM(p.amount)         AS received
         FROM invoice_payments p
         JOIN invoices i ON i.id = p.invoice_id
         JOIN property_purchase_requests pr ON pr.invoice_id = i.id
        WHERE p.status = 'completed'
          AND pr.unit_id IS NOT NULL
          ${companyFilter('i')} ${dateFilter}
        GROUP BY pr.unit_id
        ORDER BY received DESC
        LIMIT :limit`,
      { replacements, type: QueryTypes.SELECT },
    ).catch((error) => {
      /**
       * property_purchase_requests belongs to property-service. In a split
       * deployment it may live in another database entirely, in which case the
       * unit table is simply unavailable — a missing section, not a failed
       * dashboard.
       *
       * ── But only THAT error is tolerated ────────────────────────────────
       *
       * This used to swallow everything, and it was hiding a typo: the query
       * named `purchase_requests` and the table is `property_purchase_requests`.
       * The card sat empty for as long as that catch existed, on companies
       * selling units every day, and nothing anywhere said why — the warning
       * went to a server log nobody reads while the screen showed the same
       * blank panel it would show if there were genuinely no sales.
       *
       * A missing table is a deployment shape. Anything else is a bug, and
       * re-throwing is what makes it one somebody notices.
       */
      const missingTable = error?.original?.code === 'ER_NO_SUCH_TABLE'
        || error?.parent?.code === 'ER_NO_SUCH_TABLE'
        || /does not exist|doesn't exist/i.test(error?.message || '');
      if (!missingTable) throw error;
      console.warn('[finance] top units unavailable:', error.message.split('\n')[0]);
      return null;
    }),
    sequelize.query(
      `SELECT i.client_id AS id,
              COUNT(DISTINCT i.id) AS invoices,
              SUM(p.amount)        AS received
         FROM invoice_payments p
         JOIN invoices i ON i.id = p.invoice_id
        WHERE p.status = 'completed'
          AND i.client_id IS NOT NULL
          ${companyFilter('i')} ${dateFilter}
        GROUP BY i.client_id
        ORDER BY received DESC
        LIMIT :limit`,
      { replacements, type: QueryTypes.SELECT },
    ),
    sequelize.query(
      `SELECT COALESCE(SUM(p.amount), 0) AS received
         FROM invoice_payments p
         JOIN invoices i ON i.id = p.invoice_id
         LEFT JOIN property_purchase_requests pr ON pr.invoice_id = i.id
        WHERE p.status = 'completed'
          AND pr.unit_id IS NULL
          ${companyFilter('i')} ${dateFilter}`,
      { replacements, type: QueryTypes.SELECT },
    ).catch(() => null),
    /**
     * Ranked on the same basis as everything else on this panel: money
     * RECEIVED, not invoiced. A company that raised the largest unpaid
     * invoices is not the platform's strongest tenant.
     */
    crossCompany
      ? sequelize.query(
        `SELECT i.company_id AS id,
                COUNT(DISTINCT i.id) AS invoices,
                SUM(p.amount)        AS received
           FROM invoice_payments p
           JOIN invoices i ON i.id = p.invoice_id
          WHERE p.status = 'completed'
            AND i.company_id IS NOT NULL
            ${dateFilter}
          GROUP BY i.company_id
          ORDER BY received DESC
          LIMIT :limit`,
        { replacements, type: QueryTypes.SELECT },
      ).catch(() => null)
      : Promise.resolve(null),

    /**
     * Branches, on the same basis as everything else here: money RECEIVED.
     *
     * A branch has no invoices of its own — it earns through the properties
     * assigned to it, so the money is followed from the payment to the invoice
     * to the property to the branch. A property with no branch contributes to
     * nobody's total, which is why the panel also reports what is unassigned
     * rather than letting the ranking quietly appear to be the whole picture.
     */
    sequelize.query(
      `SELECT pr.branch_id         AS id,
              COUNT(DISTINCT i.id) AS invoices,
              SUM(p.amount)        AS received
         FROM invoice_payments p
         JOIN invoices i ON i.id = p.invoice_id
         JOIN properties pr ON pr.id = i.property_id
        WHERE p.status = 'completed'
          AND pr.branch_id IS NOT NULL
          ${companyFilter('i')} ${dateFilter}
        GROUP BY pr.branch_id
        ORDER BY received DESC
        LIMIT :limit`,
      { replacements, type: QueryTypes.SELECT },
    ).catch((error) => {
      /*
       * Branches arrived after this report. On a database that predates them
       * the column is missing, and the honest answer is that this company has
       * no branches to rank — a section that does not appear, not a dashboard
       * that fails. Narrowed to exactly that, for the reason the units query
       * sets out above: a catch-all here hid a typo for weeks.
       */
      const missing = /ER_NO_SUCH_TABLE|ER_BAD_FIELD_ERROR/.test(error?.original?.code || error?.parent?.code || '')
        || /does not exist|doesn't exist|unknown column/i.test(error?.message || '');
      if (!missing) throw error;
      console.warn('[finance] top branches unavailable:', error.message.split('\n')[0]);
      return null;
    }),
  ]);

  const names = async (table, ids) => {
    if (!ids.length) return {};
    try {
      const rows = await sequelize.query(
        `SELECT id, name FROM ${table} WHERE id IN (:ids)`,
        { replacements: { ids }, type: QueryTypes.SELECT },
      );
      return Object.fromEntries(rows.map((row) => [Number(row.id), row.name]));
    } catch {
      return {};
    }
  };

  const [propertyNames, clientNames, companyNames, branchNames] = await Promise.all([
    names('properties', [...new Set([
      ...properties.map((r) => Number(r.id)),
      ...(units || []).map((r) => Number(r.property_id)).filter(Boolean),
    ])]),
    names('users', clients.map((r) => Number(r.id))),
    names('companies', (companies || []).map((r) => Number(r.id))),
    names('branches', (branches || []).map((r) => Number(r.id))),
  ]);

  /**
   * Money received against properties in no branch.
   *
   * Reported for the same reason the units card reports its unattributed
   * total: without it, a branch ranking that covers a third of the revenue
   * looks like a branch ranking that covers all of it, and somebody draws a
   * conclusion about which office is performing from a number that was never
   * the whole picture.
   */
  const [branchless] = branches === null ? [null] : await sequelize.query(
    `SELECT COALESCE(SUM(p.amount), 0) AS received
       FROM invoice_payments p
       JOIN invoices i ON i.id = p.invoice_id
       LEFT JOIN properties pr ON pr.id = i.property_id
      WHERE p.status = 'completed'
        AND (pr.branch_id IS NULL OR i.property_id IS NULL)
        ${companyFilter('i')} ${dateFilter}`,
    { replacements, type: QueryTypes.SELECT },
  ).catch(() => [null]);

  const shape = (rows, label) => rows.map((row) => ({
    id: Number(row.id),
    name: label(row),
    invoices: Number(row.invoices) || 0,
    received: Number(row.received) || 0,
  }));

  res.json({
    data: {
      properties: shape(properties, (r) => propertyNames[Number(r.id)] || `Property #${r.id}`),
      units: units === null ? null : shape(units, (r) => {
        const property = propertyNames[Number(r.property_id)];
        return property ? `${r.label || `Unit #${r.id}`} — ${property}` : (r.label || `Unit #${r.id}`);
      }),
      clients: shape(clients, (r) => clientNames[Number(r.id)] || `Client #${r.id}`),
      // null for a company-bounded caller — see crossCompany above.
      companies: companies === null ? null : shape(companies, (r) => companyNames[Number(r.id)] || `Company #${r.id}`),
      // Money received against sales with no unit recorded, so the unit table
      // can say what it is not counting instead of appearing complete.
      units_unattributed: Number(unattributed?.[0]?.received) || 0,

      /*
       * null where branches do not exist for this company — the section is
       * absent rather than empty, because an empty leaderboard reads as "no
       * sales" when the truth is "no branches set up".
       */
      branches: branches === null || !branches.length
        ? null
        : shape(branches, (r) => branchNames[Number(r.id)] || `Branch #${r.id}`),
      branches_unassigned: Number(branchless?.received) || 0,
    },
  });
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

  /*
   * Verified before it can be asked for. The commission itself is untouched —
   * it stays `created` and keeps its value — so nothing is lost by waiting.
   */
  const verification = await realtorVerification(sequelize, commission.employee_id);
  if (!verification.verified) {
    return res.status(403).json({
      message: realtorBlockedMessage(verification.status),
      verification_status: verification.status || 'none',
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
  searchFields: ['receipt_number', 'status', 'payment_method', 'reference', 'notes'],
  searchRelations: [personRelation('client_id')],
  defaultWhere: receiptScope, scopeWhere: receiptScope,
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

  /**
   * The company's own receipt, where the company requires one.
   *
   * Checked HERE rather than only in the approval screen. The screen disables
   * its submit button without one, which stops the mistake being made — but
   * this is an ordinary authenticated endpoint, and a compulsory rule enforced
   * only in a browser is a rule anybody reaching the API can skip. Then
   * "compulsory" describes the UI and not the policy.
   *
   * Resolved from the INVOICE's company rather than the approving admin's, so a
   * platform admin acting on a company's behalf is held to that company's rule
   * rather than to none.
   */
  const companyReceiptUrl = String(req.body.company_receipt_url || '').trim();
  const receiptRequired = await requiresCompanyReceipt(sequelize, invoice.company_id ?? null);
  if (receiptRequired && !companyReceiptUrl) {
    return res.status(422).json({
      message: 'This company requires its own receipt to be attached before a payment '
        + 'is approved. Upload the receipt and try again.',
      requires_company_receipt: true,
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
      /**
       * Stored whether or not the company requires it — an admin who attaches a
       * receipt on a company that has not switched the rule on still expects
       * the buyer to receive it.
       *
       * Written in the same transaction as the allocation, so a receipt is
       * never issued against a payment that failed to record, and a payment is
       * never recorded having quietly dropped the document the buyer was told
       * they would get.
       */
      ...(companyReceiptUrl ? {
        company_receipt_url: companyReceiptUrl,
        company_receipt_public_id: String(req.body.company_receipt_public_id || '').trim() || null,
        company_receipt_uploaded_by: req.user?.id ?? null,
        company_receipt_uploaded_at: new Date(),
      } : {}),
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
   * Commission, on every approved payment rather than only at settlement.
   *
   * Raised here rather than at purchase because this is the point at which the
   * company actually holds money — a commission raised at purchase would be a
   * payable for a sale that might never complete. After the commit, and
   * swallowing its own failures: a missing commission rule must not undo a
   * payment that has already been approved.
   *
   * ── Why it is no longer gated on paidInFull ─────────────────────────────────
   *
   * It used to be, because the engine had one release trigger and there was
   * nothing to do until an invoice was settled. A plan may now release
   * pro-rata, on a threshold, or on the first deposit — and on a twenty-four
   * month instalment plan that is where almost every release falls. Called only
   * at settlement, such a plan would sit silent for two years and then vest
   * everything at once.
   *
   * The LEGACY flat-rate path is still settlement-only, because that is what it
   * has always done and switching a company's plan must not change the timing
   * of a system it is not using. So the engine is offered every payment, and
   * the fallback is reached only when the invoice is fully paid.
   */
  {
    /**
     * The engine first; the flat rate only if no plan is in force.
     *
     * Exactly one of the two pays — see services/commissionBridge.js for the
     * switch and why it is the plan's own resolution rather than a separate
     * question. Both running would pay every participant twice, and it would
     * be discovered at payout, after the money.
     */
    commissionEngine.handlePayment({
      invoice,
      totalMinor: result.totalMinor,
      // Cumulative, not this instalment — see the bridge.
      receivedMinor: result.paidMinor,
      paidInFull: result.paidInFull,
    })
      .then((engineOutcome) => {
        if (engineOutcome.handled) {
          if (engineOutcome.accrued || engineOutcome.released) {
            console.log(`[commission] ${engineOutcome.deal_ref}: ${engineOutcome.accrued} accrued, `
              + `${engineOutcome.released} released, ${engineOutcome.forfeited} forfeited `
              + `(plan version ${engineOutcome.plan_version_id})`);
          }
          // The engine has dealt with this sale. Nothing further to raise.
          return null;
        }
        // No plan in force. The flat-rate path raises only on a completed sale.
        if (!result.paidInFull) return null;
        return generateForSale({ invoice, basisAmount: toMajor(result.totalMinor) });
      })
      .then((outcome) => {
        if (!outcome?.created) return;
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

/**
 * Takes an invoice out of "payment under review" once nothing is waiting on it.
 *
 * An invoice moves to payment_under_review the moment a buyer submits proof.
 * If that proof then goes away — refused, withdrawn — and nothing else is
 * pending, leaving the invoice there strands the buyer: the status says someone
 * is looking at it and nobody is.
 *
 * It returns to partially_paid rather than sent where approved money already
 * stands against it, so losing one proof does not erase the payments that hold.
 *
 * Checks for OTHER pending receipts first, because an invoice can carry several
 * and releasing it while one is still in the queue would understate it. Returns
 * the invoice when it released one, and null otherwise, so callers can decide
 * whether there is anything to announce.
 */
const releaseInvoiceIfNothingPending = async (receipt) => {
  if (!receipt.invoice_id) return null;
  const invoice = await Invoice.findOne({ where: { id: receipt.invoice_id } });
  if (!invoice || invoice.status !== 'payment_under_review') return null;

  const stillPending = await Receipt.count({
    where: { invoice_id: invoice.id, status: 'pending', id: { [Op.ne]: receipt.id } },
  });
  if (stillPending > 0) return null;

  const money = await outstandingFor(invoice);
  await invoice.update({ status: money.paid > 0 ? 'partially_paid' : 'sent' });
  return invoice;
};

/**
 * Tells the review queue a corrected payment is back.
 *
 * Reuses the submission event rather than inventing a resubmission one: to
 * everybody downstream this IS a submission awaiting a decision, and a second
 * event would have to be configured separately by every company before anyone
 * was told — the silent failure being a corrected payment nobody looks at.
 */
const notifyResubmitted = async (invoice, receipt, req) => {
  const fmtMoney = await formatMoneyFor(invoice.company_id ?? null);
  const amount = Number(receipt.amount) || 0;
  return purchaseNotifier.dispatch({
    eventKey: 'payment_receipt_submitted',
    invoiceId: invoice.id,
    type: 'invoice_receipt_submitted',
    title: (role, ctx) => (role === 'client'
      ? `Payment resubmitted for ${ctx.invoice_id}`
      : `Corrected payment proof submitted for ${ctx.invoice_id}`),
    body: (role, ctx) => (role === 'client'
      ? `Your corrected payment of ${fmtMoney(amount)} has been sent back for review.`
      : `A corrected payment of ${fmtMoney(amount)} has been resubmitted on invoice ${ctx.invoice_id} `
        + `(${purchaseNotifier.describeSubject(ctx)}).`),
    data: { receipt_id: receipt.id, amount, resubmitted: true },
    actionLabel: 'Review payment',
    actionUrl: appUrl(`finance/invoices/${invoice.id}`, req),
  }).catch(() => {});
};

/**
 * The states a buyer may still act on.
 *
 * `verified` is absent deliberately and permanently: an approved payment has
 * been allocated against the invoice and possibly across a schedule, so
 * changing its amount after the fact would silently contradict the money
 * already moved. Correcting an approved payment is an accounting action — a
 * credit note — not a field edit.
 *
 * `cancelled` is absent too: a withdrawn request is finished. Re-opening one
 * would make "cancelled" mean "paused", and the buyer can always submit a
 * fresh proof instead.
 */
const BUYER_EDITABLE = ['pending', 'rejected'];

/**
 * Finds a receipt the CALLER is allowed to act on, or explains why not.
 *
 * receiptScope pins a buyer to their own rows, so a wrong id is a 404 rather
 * than a 403 — a buyer must not be able to learn that someone else's receipt
 * exists by probing ids.
 */
const findActionableReceipt = async (req, res) => {
  const receipt = await Receipt.findOne({ where: { id: req.params.id, ...receiptScope(req) } });
  if (!receipt) {
    res.status(404).json({ message: 'Payment not found' });
    return null;
  }
  if (!BUYER_EDITABLE.includes(receipt.status)) {
    res.status(409).json({
      message: receipt.status === 'verified'
        ? 'This payment has been approved and can no longer be changed.'
        : 'This payment was cancelled and can no longer be changed.',
    });
    return null;
  }
  return receipt;
};

/**
 * A buyer corrects a payment they have already submitted.
 *
 * Allowed while it is still pending, and after a rejection — which is the whole
 * point of rejecting with a reason rather than deleting: the buyer fixes what
 * was wrong and sends the same request back.
 *
 * A corrected rejection returns to `pending`, which puts it back in the review
 * queue and takes the invoice back under review. Anything else would leave a
 * fixed payment sitting in a state that reads as refused.
 */
const updateOwnReceipt = asyncHandler(async (req, res) => {
  const receipt = await findActionableReceipt(req, res);
  if (!receipt) return undefined;

  const changes = {};

  if (req.body.document_url !== undefined) {
    const documentUrl = String(req.body.document_url || '').trim();
    // Proof cannot be removed, only replaced: a submitted payment with no
    // evidence is not something an admin can act on.
    if (!documentUrl) return res.status(400).json({ message: 'Upload your proof of payment.' });
    changes.document_url = documentUrl;
  }

  if (req.body.amount !== undefined) {
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: 'Enter the amount you paid.' });
    }
    /**
     * Deliberately NOT capped at the outstanding balance, matching submission:
     * this figure is a claim about money already transferred, and refusing to
     * record it does not unsend the transfer. A genuine surplus becomes a
     * flagged credit balance at approval.
     */
    changes.amount = amount;
  }

  if (req.body.reference !== undefined) {
    changes.reference = String(req.body.reference || '').trim() || null;
  }
  if (req.body.notes !== undefined) {
    changes.notes = String(req.body.notes || '').trim() || null;
  }

  if (!Object.keys(changes).length) {
    return res.status(400).json({ message: 'Nothing to change.' });
  }

  const wasRejected = receipt.status === 'rejected';
  if (wasRejected) {
    changes.status = 'pending';
    // The previous refusal is cleared along with the decision that caused it,
    // so the buyer is not left reading a reason for a version they have
    // already corrected.
    changes.rejection_reason = null;
    changes.verified_by = null;
    changes.verified_at = null;
  }

  await receipt.update(changes);

  if (wasRejected) {
    const invoice = await Invoice.findOne({ where: { id: receipt.invoice_id } });
    // Back under review, and the queue told, exactly as a first submission does.
    if (invoice && ['sent', 'partially_paid'].includes(invoice.status)) {
      await invoice.update({ status: 'payment_under_review' });
    }
    if (invoice) await notifyResubmitted(invoice, receipt, req);
  }

  return res.json({ data: receipt });
});

/**
 * A buyer withdraws a payment they submitted.
 *
 * It never counted toward the invoice and still does not: only approval creates
 * an invoice_payment, so cancelling changes no figure. What it does change is
 * the queue — an admin should not be left deciding a payment the buyer has
 * abandoned — and the invoice, which is handed back if nothing else is pending.
 *
 * Cancelling is not a delete. The row stays, with its evidence, because a
 * payment that was claimed and withdrawn is part of the account's history.
 */
const cancelOwnReceipt = asyncHandler(async (req, res) => {
  const receipt = await findActionableReceipt(req, res);
  if (!receipt) return undefined;

  await receipt.update({ status: 'cancelled' });
  await releaseInvoiceIfNothingPending(receipt);

  return res.json({
    data: receipt,
    message: 'Payment cancelled. It does not count toward your invoice.',
  });
});

/**
 * Everything a buyer owns, assembled in one call.
 *
 * "My Properties" answers a question no existing endpoint did: what did I buy,
 * what did it cost, how have I paid, where do my proofs stand, and what
 * paperwork do I have. Those five answers live in five tables, and a page that
 * fetched them separately would either make five round trips per property or
 * quietly show one of them stale.
 *
 * Built in finance-service because the INVOICE is the spine — it is the only
 * row that links the buyer to the property, the payments, the receipts and the
 * documents at once.
 *
 * Scoped through resolveViewableUser rather than trusting a query parameter, so
 * the same endpoint serves a client reading their own and an admin inspecting
 * theirs, with the rule stated once.
 */
const getMyProperties = asyncHandler(async (req, res) => {
  const targetId = req.params.userId || req.user?.id;
  const access = await resolveViewableUser(sequelize, req, targetId);
  if (!access.ok) return res.status(access.status).json({ message: access.message });
  const { target } = access;

  /**
   * Purchases first: they are what the page is a list OF.
   *
   * A correlated subquery for the paid figure rather than a JOIN with GROUP BY
   * — grouping would mean naming every selected column to satisfy Postgres,
   * which is the exact failure the client invoice page hit.
   */
  const purchases = await sequelize.query(
    `SELECT pr.id, pr.property_id, pr.unit_id, pr.unit_label, pr.unit_price, pr.quantity,
            pr.amount, pr.payment_mode, pr.status, pr.created_at,
            pr.invoice_id, pr.invoice_ref,
            i.amount AS invoice_amount, i.status AS invoice_status, i.due_date,
            p.name AS property_name, p.address, p.city, p.state, p.country,
            p.description, p.images, p.type AS property_type,
            COALESCE((SELECT SUM(ip.amount) FROM invoice_payments ip
                       WHERE ip.invoice_id = i.id AND ip.status = 'completed'), 0) AS paid
       FROM property_purchase_requests pr
       LEFT JOIN invoices i ON i.id = pr.invoice_id
       LEFT JOIN properties p ON p.id = pr.property_id
      WHERE pr.user_id = :userId AND pr.status <> 'cancelled'
      ORDER BY pr.id DESC`,
    { replacements: { userId: target.id }, type: QueryTypes.SELECT },
  ).catch(() => []);

  const invoiceIds = [...new Set(purchases.map((r) => r.invoice_id).filter(Boolean))];
  const propertyIds = [...new Set(purchases.map((r) => r.property_id).filter(Boolean))];

  const [payments, receipts, documents, propertyDocs] = await Promise.all([
    // Money that has actually been applied.
    invoiceIds.length
      ? sequelize.query(
        `SELECT id, invoice_id, amount, payment_method, status, created_at
           FROM invoice_payments
          WHERE invoice_id IN (:ids) AND status = 'completed'
          ORDER BY id DESC`,
        { replacements: { ids: invoiceIds }, type: QueryTypes.SELECT }).catch(() => [])
      : [],
    /**
     * The buyer's own proofs, in every state — including rejected and
     * cancelled. This page is where they answer "did my payment go through",
     * and a refused proof silently missing is the failure that question exists
     * to catch.
     */
    invoiceIds.length
      ? sequelize.query(
        `SELECT id, invoice_id, receipt_number, amount, status, document_url,
                reference, rejection_reason, created_at,
                -- The receipt the company issued back, where one was attached.
                company_receipt_url
           FROM receipts
          WHERE invoice_id IN (:ids)
          ORDER BY id DESC`,
        { replacements: { ids: invoiceIds }, type: QueryTypes.SELECT }).catch(() => [])
      : [],
    invoiceIds.length
      ? sequelize.query(
        `SELECT id, invoice_id, name, url, type, size
           FROM invoice_documents
          WHERE invoice_id IN (:ids)
          ORDER BY id DESC`,
        { replacements: { ids: invoiceIds }, type: QueryTypes.SELECT }).catch(() => [])
      : [],
    /**
     * Property paperwork, and ONLY what has been marked shareable.
     *
     * The filter is in the query, so an unshared deed is never loaded here at
     * all. These are view-only for a buyer — unlike the invoice documents
     * above, which were attached to them deliberately and are theirs to keep.
     */
    propertyIds.length
      ? sequelize.query(
        `SELECT id, property_id, name, url, type
           FROM property_documents
          WHERE property_id IN (:ids) AND is_shareable = TRUE
          ORDER BY id DESC`,
        { replacements: { ids: propertyIds }, type: QueryTypes.SELECT }).catch(() => [])
      : [],
  ]);

  const groupBy = (rows, key) => rows.reduce((map, row) => {
    const id = Number(row[key]);
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(row);
    return map;
  }, new Map());

  const paymentsBy = groupBy(payments, 'invoice_id');
  const receiptsBy = groupBy(receipts, 'invoice_id');
  const documentsBy = groupBy(documents, 'invoice_id');
  const propertyDocsBy = groupBy(propertyDocs, 'property_id');

  /**
   * `images` is a JSON column and arrives parsed on one driver and as a string
   * on another. Normalised here so the page never has to know which.
   */
  const parseImages = (raw) => {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string' && raw.trim()) {
      try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
    }
    return [];
  };

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const data = purchases.map((row) => {
    const billed = Number(row.invoice_amount) || 0;
    const paid = Number(row.paid) || 0;
    const balance = Math.max(billed - paid, 0);
    const dueDate = row.due_date ? new Date(row.due_date) : null;

    const paymentState = (() => {
      if (!row.invoice_id) return 'unbilled';
      if (billed > 0 && paid >= billed) return 'paid';
      if (dueDate && dueDate < startOfToday) return 'due';
      return paid > 0 ? 'in_progress' : 'pending';
    })();

    return {
      id: row.id,
      property: {
        id: row.property_id,
        name: row.property_name,
        type: row.property_type,
        description: row.description,
        location: [row.address, row.city, row.state, row.country].filter(Boolean).join(', '),
        // Images and videos together, exactly as the property stores them; the
        // client already knows how to tell one from the other.
        media: parseImages(row.images),
      },
      unit: {
        id: row.unit_id,
        label: row.unit_label,
        price: Number(row.unit_price) || 0,
        quantity: Number(row.quantity) || 0,
      },
      purchased_at: row.created_at,
      payment_mode: row.payment_mode,
      amount: Number(row.amount) || 0,
      invoice: row.invoice_id ? {
        id: row.invoice_id,
        reference: row.invoice_ref,
        amount: billed,
        paid,
        balance,
        status: row.invoice_status,
        due_date: row.due_date,
        state: paymentState,
      } : null,
      payments: (paymentsBy.get(Number(row.invoice_id)) || []).map((p) => ({
        ...p, amount: Number(p.amount) || 0,
      })),
      proofs: (receiptsBy.get(Number(row.invoice_id)) || []).map((r) => ({
        ...r, amount: Number(r.amount) || 0,
      })),
      // Theirs to keep.
      documents: (documentsBy.get(Number(row.invoice_id)) || []).map((d) => ({
        ...d, can_download: true,
      })),
      // Shared for reading only.
      property_documents: (propertyDocsBy.get(Number(row.property_id)) || []).map((d) => ({
        ...d, can_download: false,
      })),
    };
  });

  return res.json({
    data,
    totals: {
      properties: new Set(data.map((r) => r.property.id).filter(Boolean)).size,
      purchases: data.length,
      value: data.reduce((sum, r) => sum + r.amount, 0),
      paid: data.reduce((sum, r) => sum + (r.invoice?.paid || 0), 0),
      balance: data.reduce((sum, r) => sum + (r.invoice?.balance || 0), 0),
    },
  });
});

/**
 * Documents an admin attaches to an invoice for the buyer.
 *
 * Agreements, receipts, a copy of the title — anything pertaining to that
 * payment, that invoice, or the property behind it. Scoped through the invoice
 * rather than carrying their own access rule: `invoiceScope` already answers
 * "may this caller see this invoice", and a document is only ever as private as
 * the invoice it hangs off.
 *
 * Unlike a property document, these carry no shareable flag. Attaching one to
 * somebody's invoice IS the act of sharing it with them, and the buyer may both
 * view and download the original — it is their agreement, their receipt.
 */

/** What the buyer is looking at. Free-form, but these are the ones offered. */
const DOCUMENT_TYPES = ['agreement', 'receipt', 'property_document', 'title', 'other'];

/** The invoice, if this caller may see it at all. */
const findScopedInvoice = (req, id) => Invoice.findOne({
  where: { id, ...invoiceScope(req) },
});

const listInvoiceDocuments = asyncHandler(async (req, res) => {
  const invoice = await findScopedInvoice(req, req.params.id);
  if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

  const docs = await InvoiceDocument.findAll({
    where: { invoice_id: invoice.id },
    order: [['id', 'DESC']],
  });

  return res.json({
    data: docs.map((doc) => ({
      ...doc.get({ plain: true }),
      // Stated rather than assumed by the UI: an attached document is the
      // buyer's to keep, which is the whole difference from a property
      // document shared for viewing only.
      can_download: true,
    })),
    types: DOCUMENT_TYPES,
  });
});

const attachInvoiceDocument = asyncHandler(async (req, res) => {
  // companyScope, not invoiceScope: attaching is staff-only (the route enforces
  // that), and staff are not self-scoped, but going through the same helper
  // keeps a company admin inside their own tenant.
  const invoice = await findScopedInvoice(req, req.params.id);
  if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

  const name = String(req.body.name || '').trim();
  const url = String(req.body.url || '').trim();
  if (!name || !url) {
    return res.status(400).json({ message: 'A document needs a name and an uploaded file.' });
  }

  const type = String(req.body.type || 'other').trim().toLowerCase();

  const doc = await InvoiceDocument.create({
    invoice_id: invoice.id,
    name,
    url,
    // Not restricted to DOCUMENT_TYPES: the list is what the picker offers, not
    // a constraint. Refusing an unlisted value here would mean a vocabulary
    // change could not ship without a migration.
    type: type || 'other',
    size: Number(req.body.size) || null,
    public_id: String(req.body.public_id || '').trim() || null,
    uploaded_by: req.user?.id ?? null,
    company_id: invoice.company_id ?? null,
  });

  /**
   * The buyer is told. A document nobody mentions is a document nobody reads,
   * and the whole point of attaching an agreement is that they see it.
   */
  purchaseNotifier.dispatch({
    eventKey: 'invoice_document_attached',
    invoiceId: invoice.id,
    type: 'invoice_document_attached',
    title: (role, ctx) => `A document was added to ${ctx.invoice_id}`,
    body: (role, ctx) => (role === 'client'
      ? `"${name}" has been attached to your invoice ${ctx.invoice_id}. You can view or download it `
        + 'from the invoice page.'
      : `"${name}" was attached to invoice ${ctx.invoice_id}.`),
    data: { document_id: doc.id, name, type },
    actionLabel: 'View invoice',
    actionUrl: appUrl(`finance/invoices/${invoice.id}`, req),
  }).catch(() => {});

  return res.status(201).json({ data: doc });
});

const deleteInvoiceDocument = asyncHandler(async (req, res) => {
  /**
   * Found through the invoice, so a document id from another company cannot be
   * reached by guessing an integer.
   */
  const doc = await InvoiceDocument.findOne({
    where: { id: req.params.docId },
    include: [{ model: Invoice, as: 'invoice', required: true, where: companyScope(req) }],
  });
  if (!doc) return res.status(404).json({ message: 'Document not found' });

  await doc.destroy();
  return res.json({ message: 'Document removed.' });
});

const rejectReceipt = asyncHandler(async (req, res) => {
  const receipt = await Receipt.findOne({ where: { id: req.params.id, ...companyScope(req) } });
  if (!receipt) return res.status(404).json({ message: 'Receipt not found' });
  if (receipt.status !== 'pending') {
    return res.status(409).json({ message: `This receipt was already ${receipt.status}.` });
  }

  /**
   * The reason is compulsory, and goes in its own column.
   *
   * It used to be written over `notes` — the buyer's own note from submission —
   * which destroyed what they had written and left nobody able to tell whose
   * words were whose. `reason` is the parameter; `notes` is still accepted so
   * an older client keeps working.
   */
  const reason = String(req.body.reason ?? req.body.notes ?? '').trim();
  if (!reason) return res.status(400).json({ message: 'Give a reason so the buyer knows what to fix.' });

  await receipt.update({
    status: 'rejected',
    rejection_reason: reason,
    verified_by: req.user?.id ?? null,
    verified_at: new Date(),
  });

  const invoice = await releaseInvoiceIfNothingPending(receipt);
  if (invoice) {
    // FRD 12.2 sends a rejection to the realtor as well as the client — they
    // are the one who will chase the corrected proof.
    purchaseNotifier.dispatch({
      eventKey: 'payment_rejected',
      invoiceId: invoice.id,
      type: 'invoice_receipt_rejected',
      title: (role, ctx) => `Payment proof not accepted — ${ctx.invoice_id}`,
      body: (role, ctx) => (role === 'client'
        ? `Your proof of payment for ${purchaseNotifier.describeSubject(ctx)} was not accepted.\n\n`
          + `Reason: ${reason}\n\nYou can correct and resubmit it from My Payments.`
        : `${ctx.client_name || 'A client'}'s proof of payment on invoice ${ctx.invoice_id} was not `
          + `accepted.\n\nReason: ${reason}`),
      data: { receipt_id: receipt.id, reason },
      actionLabel: 'View invoice',
      actionUrl: appUrl(`finance/invoices/${invoice.id}`, req),
    }).catch(() => {});
  }

  res.json({ data: receipt });
});


/**
 * Everything a receipt has to say, for one receipt.
 *
 * ── Why this is an endpoint and not more columns on the list ────────────────
 *
 * A receipt row holds an amount, a method and a reference. Printed, that
 * produced a document saying somebody paid some money — true, and useless. A
 * buyer checks a receipt against the thing they bought: which property, which
 * unit, how many, and what they still owe afterwards. None of that is on the
 * receipt row, because none of it belongs to the receipt: the property and the
 * unit belong to the purchase, and the balance is a fact about the invoice at
 * this moment rather than a fact about the payment.
 *
 * Fetched per receipt rather than added to the list because the balance is the
 * expensive part — it sums the whole schedule ledger — and the list renders
 * fifty rows of which somebody prints one.
 *
 * ── Best-effort, in the same way the invoice views are ──────────────────────
 *
 * property_purchase_requests and properties belong to property-service and may
 * be in another database. A receipt that prints without its unit line is a
 * lesser failure than a Print button that errors, so every lookup here falls
 * back to null rather than throwing.
 */
const getReceiptPrintData = asyncHandler(async (req, res) => {
  const receipt = await Receipt.findOne({ where: { id: req.params.id, ...receiptScope(req) } });
  if (!receipt) return res.status(404).json({ message: 'Receipt not found' });

  const data = receipt.toJSON();

  const [client] = receipt.client_id
    ? await sequelize.query('SELECT id, name, email, phone FROM users WHERE id = :id',
      { replacements: { id: receipt.client_id }, type: QueryTypes.SELECT }).catch(() => [])
    : [];

  let invoice = null;
  let purchase = null;
  let property = null;
  let outstanding = null;

  if (receipt.invoice_id) {
    [invoice] = await sequelize.query(
      'SELECT id, invoice_id, property_id, amount, status, company_id FROM invoices WHERE id = :id',
      { replacements: { id: receipt.invoice_id }, type: QueryTypes.SELECT },
    ).catch(() => []);

    [purchase] = await sequelize.query(
      `SELECT property_id, unit_id, unit_label, unit_price, quantity
         FROM property_purchase_requests
        WHERE invoice_id = :id
        ORDER BY id ASC LIMIT 1`,
      { replacements: { id: receipt.invoice_id }, type: QueryTypes.SELECT },
    ).catch(() => []);

    const propertyId = purchase?.property_id || invoice?.property_id;
    if (propertyId) {
      [property] = await sequelize.query('SELECT id, name, address FROM properties WHERE id = :id',
        { replacements: { id: propertyId }, type: QueryTypes.SELECT }).catch(() => []);
    }

    if (invoice) outstanding = await outstandingFor(invoice).catch(() => null);
  }

  return res.json({
    success: true,
    data: {
      ...data,
      client_name: client?.name ?? data.client_name ?? null,
      client_email: client?.email ?? null,
      client_phone: client?.phone ?? null,
      invoice_reference: invoice?.invoice_id ?? null,
      property_name: property?.name ?? null,
      property_address: property?.address ?? null,
      unit_label: purchase?.unit_label ?? null,
      unit_price: purchase?.unit_price == null ? null : Number(purchase.unit_price),
      quantity: purchase?.quantity == null ? null : Number(purchase.quantity),
      /**
       * The balance AFTER this payment, because that is what the buyer wants
       * off a receipt — not "you owed this much", but "this is what is left".
       * Taken live rather than stored on the receipt: a later payment, a
       * discount or a waived fee all change it, and a receipt that quotes a
       * stale balance is worse than one that quotes none.
       */
      invoice_total: outstanding?.total ?? null,
      invoice_paid: outstanding?.paid ?? null,
      outstanding_balance: outstanding?.balance ?? null,
      invoice_discount: outstanding?.discount ?? null,
    },
  });
});

module.exports = {
  getMyProperties,
  listInvoiceDocuments,
  attachInvoiceDocument,
  deleteInvoiceDocument,
  updateOwnReceipt,
  cancelOwnReceipt,
  notDeletable,
  getPaymentAnalysis,
  getPaymentOptions,
  submitInvoiceReceipt,
  invoiceCrud, taxCrud, transactionCrud, paymentPlanCrud,
  bankAccountCrud, creditNoteCrud, debitNoteCrud, paymentReminderCrud, commissionCrud,
  sendInvoice, payInvoice, markInvoicePaid, getInvoicePayments,
  revenueReport, transactionReport, invoiceReport, topPerformersReport, commissionReport,
  getReferralSetting, upsertReferralSetting,
  listReferralTransactions, createReferralTransaction, updateReferralTransaction,
  approveCommission, payCommission, requestCommissionPayout, getMyCommissions,
  commissionRuleCrud, calculateCommission,
  receiptCrud, createReceipt, verifyReceipt, rejectReceipt, getReceiptPrintData,
};

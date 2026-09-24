const router = require('express').Router();
const { body } = require('express-validator');
const { verifyToken, requirePermission, permissionOrSelfScoped } = require('../middleware/auth');
const { validate } = require('../middleware/validation');
const c = require('../controllers/financeController');
const notes = require('../controllers/noteApprovalController');
const reminders = require('../controllers/reminderScheduleController');
const plansCtl = require('../controllers/commissionPlanController');
const reportsCtl = require('../controllers/commissionReportController');
const acctCtl = require('../controllers/accountingController');
const refundsCtl = require('../controllers/refundController');
const payablesCtl = require('../controllers/payablesController');
const devCtl = require('../controllers/developmentController');
const handoverCtl = require('../controllers/handoverController');
const stmtCtl = require('../controllers/statementsController');
const periodCtl = require('../controllers/periodsController');
const bankCtl = require('../controllers/bankRecController');
const migrationCtl = require('../controllers/migrationController');
const gateways = require('../controllers/paymentGatewayController');
const plans = require('../controllers/installmentPlanController');
const schedules = require('../controllers/paymentScheduleController');
const myNotes = require('../controllers/myNotesController');

router.use(verifyToken);

/**
 * Finance is staff territory. Clients and realtors reach exactly three things:
 * their own invoices, their own payments, and the payment-analysis endpoint
 * (which authorises per target). Everything else — taxes, bank accounts,
 * commissions, credit notes, refunds, reminders, receipts, plans, reports — is
 * company financial data and was previously readable by any logged-in user,
 * since this router only ever checked that a token was present.
 *
 * Gated on the ACTING profile so a dual-profile user switched to client is
 * treated as a client.
 */
const staffOnly = (req, res, next) => {
  const acting = req.user?.effectiveType || req.user?.type;
  if (req.user?.isSuperiorAdmin || !['client', 'realtor'].includes(acting)) return next();
  return res.status(403).json({ message: 'You do not have permission to access this resource' });
};

/**
 * Stricter than staffOnly, for the payment gateway credential checks.
 *
 * Those endpoints read the saved secret keys and tell the caller whether they
 * work. That is an admin-only answer: any member of staff being able to probe
 * whether the live Stripe key is valid is a disclosure the Settings page they
 * would use to see it does not permit them in the first place.
 */
const adminOnly = (req, res, next) => {
  const acting = req.user?.effectiveType || req.user?.type;
  if (req.user?.isSuperiorAdmin || ['superior_admin', 'super_admin', 'admin'].includes(acting)) return next();
  return res.status(403).json({ message: 'You do not have permission to access this resource' });
};

// Invoices and payments for one user. Self for a client; a permitted target for
// an admin or an upline realtor. Declared before the /invoices routes so the
// literal path is never shadowed.
/*
 * No route guard, deliberately: these resolve access per ROW.
 * resolveViewableUser (shared/src/viewerAccess.js) allows your own records,
 * a staff member their own company's, and a realtor their downline's — a rule
 * no single permission name can express, and one a route guard would only
 * duplicate more loosely.
 */
router.get('/payment-analysis/:userId', c.getPaymentAnalysis);

/**
 * Everything a buyer owns, in one call — the "My Properties" page.
 *
 * Two forms: no id means "mine", which is what a client calls; an explicit id
 * is an admin or upline realtor inspecting someone. Both go through
 * resolveViewableUser, so the authorisation rule is stated once.
 *
 * Declared before the /invoices routes for the same reason payment-analysis is:
 * a literal path must not be captured as an :id.
 */
// Yours, or somebody resolveViewableUser says you may look at. Per-row again.
router.get('/my-properties', c.getMyProperties);
router.get('/my-properties/:userId', c.getMyProperties);

// Invoices
/*
 * Dual-purpose, and that is why these had no guard.
 *
 * An administrator opening Invoices sees the company's; a buyer opening "My
 * Invoices" hits the SAME route and invoiceScope narrows them to their own.
 * requirePermission would have been right for the first and would have locked
 * the second out of their own bills, so the route was left open to anyone with
 * a token. permissionOrSelfScoped says what was actually meant — see the
 * invariant documented on it, which invoiceScope is what satisfies here.
 */
router.get('/invoices', permissionOrSelfScoped('finance.invoices.view'), c.invoiceCrud.list);
router.post('/invoices', staffOnly, [body('client_id').isInt(), body('amount').isFloat({ min: 1 })], validate, c.invoiceCrud.create);
router.get('/invoices/:id', permissionOrSelfScoped('finance.invoices.view'), c.invoiceCrud.getOne);
router.put('/invoices/:id', staffOnly, c.invoiceCrud.update);
router.delete('/invoices/:id', staffOnly, c.invoiceCrud.remove);
router.post('/invoices/:id/send', staffOnly, c.sendInvoice);
router.post('/invoices/:id/pay', staffOnly, [body('payment_method').notEmpty()], validate, c.payInvoice);
router.post('/invoices/:id/mark-paid', staffOnly, c.markInvoicePaid);
router.get('/invoices/:id/payments', permissionOrSelfScoped('finance.invoices.view'), c.getInvoicePayments);
// Buyer-facing: how to pay, and submitting proof. Both are scoped to the
// invoice's owner by invoiceScope, so a client only ever sees their own.
// payment-options now also carries the payment plan and its schedule table, so
// the payment page needs no second round trip (FRD 5.2).
router.get('/invoices/:id/payment-options', permissionOrSelfScoped('finance.invoices.view'), c.getPaymentOptions);
/*
 * A buyer submitting proof of payment against their own invoice, or an admin
 * recording one on their behalf. invoiceScope is what makes the first safe.
 */
router.post('/invoices/:id/receipts', permissionOrSelfScoped('finance.invoices.view'), [body('document_url').notEmpty()], validate, c.submitInvoiceReceipt);

/**
 * The purchase journey's schedule and plan endpoints.
 *
 * Permission-gated rather than role-gated, so the split between reading the
 * ledger and acting on it can be delegated to a custom role. A client reaches
 * their own figures through payment-options above, which is invoice-scoped.
 */
router.get('/invoices/:id/schedules', requirePermission('finance.payment-schedules.view'), schedules.getInvoiceSchedules);
router.get('/invoices/:id/allocations', requirePermission('finance.payment-schedules.view'), schedules.getInvoiceAllocations);
// Editing quantity regenerates the whole schedule set; cancelling releases the
// inventory hold. Both are the acting-on-it half of the permission.
router.put('/invoices/:id/quantity', requirePermission('finance.payment-schedules.manage'), [body('quantity').isInt({ min: 1 })], validate, schedules.editInvoiceQuantity);
router.post('/invoices/:id/cancel', requirePermission('finance.payment-schedules.manage'), schedules.cancelInvoice);
// Mandatory reason, audited on the fee application row.
router.post('/payment-schedules/:scheduleId/waive-fee', requirePermission('finance.payment-schedules.manage'), [body('reason').notEmpty()], validate, schedules.waiveScheduleFee);
// The overpayments flagged for attention.
router.get('/payment-schedules/credit-balances', requirePermission('finance.payment-schedules.view'), schedules.listCreditBalances);

// Taxes
router.get('/taxes', staffOnly, c.taxCrud.list);
router.post('/taxes', staffOnly, [body('name').notEmpty(), body('rate').isFloat({ min: 0 })], validate, c.taxCrud.create);
router.get('/taxes/:id', staffOnly, c.taxCrud.getOne);
router.put('/taxes/:id', staffOnly, c.taxCrud.update);
router.delete('/taxes/:id', staffOnly, c.notDeletable('Taxes'));

// Transactions
// transactionScope narrows a buyer to their own payments — same shape as invoices.
router.get('/transactions', permissionOrSelfScoped('finance.invoices.view'), c.transactionCrud.list);
router.post('/transactions', staffOnly, [body('type').notEmpty(), body('amount').isFloat({ min: 0 })], validate, c.transactionCrud.create);
router.get('/transactions/:id', permissionOrSelfScoped('finance.invoices.view'), c.transactionCrud.getOne);
router.put('/transactions/:id', staffOnly, c.transactionCrud.update);
router.delete('/transactions/:id', staffOnly, c.notDeletable('Payments'));

/**
 * Installment plans — the purchase journey's plan templates (FRD 3).
 *
 * Not to be confused with /payment-plans below, which is the subscription
 * price list and predates this.
 *
 * The priced options endpoint is the one route here a BUYER may call: it is the
 * plan picker on the purchase screen, and it exposes only what that screen
 * shows — plan terms and the amounts for one unit and quantity.
 *
 * Note the two different permissions. Defining a plan's TERMS is a finance
 * decision (finance.installment-plans.manage); deciding which of those plans a
 * property's units may be sold on is a property inventory decision
 * (properties.installment-plans.manage), and a product manager holds the second
 * without the first.
 */
/*
 * Open on purpose: a buyer configuring a purchase needs to see what a unit's
 * plans cost, and requiring finance.installment-plans.view for that was what
 * put a Finance screen in every realtor's sidebar for no reason (see the note
 * in permissionCatalog's realtor block). It returns pricing for one unit and
 * nothing about anybody's account.
 */
router.get('/installment-plans/units/:propertyUnitId/options', plans.getUnitPurchaseOptions);
router.get('/installment-plans/units/:propertyUnitId', requirePermission('finance.installment-plans.view', 'properties.installment-plans.manage'), plans.listPlansForUnit);
router.get('/installment-plans', requirePermission('finance.installment-plans.view'), plans.installmentPlanCrud.list);
router.post('/installment-plans', requirePermission('finance.installment-plans.manage'), [body('name').notEmpty(), body('duration_months').isInt({ min: 1 })], validate, plans.installmentPlanCrud.create);
router.get('/installment-plans/:id', requirePermission('finance.installment-plans.view'), plans.installmentPlanCrud.getOne);
router.put('/installment-plans/:id', requirePermission('finance.installment-plans.manage'), [body('name').notEmpty(), body('duration_months').isInt({ min: 1 })], validate, plans.installmentPlanCrud.update);
router.delete('/installment-plans/:id', requirePermission('finance.installment-plans.manage'), plans.installmentPlanCrud.remove);
// Assignment is per UNIT, not per property, and is the property-side decision.
router.post('/installment-plans/:id/units', requirePermission('properties.installment-plans.manage'), [body('property_unit_id').isInt({ min: 1 })], validate, plans.assignPlanToUnit);
router.delete('/installment-plans/:id/units/:unitId', requirePermission('properties.installment-plans.manage'), plans.unassignPlanFromUnit);

// Payment Plans
router.get('/payment-plans', staffOnly, c.paymentPlanCrud.list);
router.post('/payment-plans', staffOnly, [body('name').notEmpty(), body('price').isFloat({ min: 0 })], validate, c.paymentPlanCrud.create);
router.get('/payment-plans/:id', staffOnly, c.paymentPlanCrud.getOne);
router.put('/payment-plans/:id', staffOnly, c.paymentPlanCrud.update);
router.delete('/payment-plans/:id', staffOnly, c.notDeletable('Payment plans'));

// Bank Accounts
router.get('/bank-accounts', staffOnly, c.bankAccountCrud.list);
router.post('/bank-accounts', staffOnly, [body('name').notEmpty(), body('bank_name').notEmpty(), body('account_number').notEmpty()], validate, c.bankAccountCrud.create);
router.get('/bank-accounts/:id', staffOnly, c.bankAccountCrud.getOne);
router.put('/bank-accounts/:id', staffOnly, c.bankAccountCrud.update);
router.delete('/bank-accounts/:id', staffOnly, c.notDeletable('Bank accounts'));

// Credit Notes
router.get('/credit-notes', staffOnly, c.creditNoteCrud.list);
// The party is any user in the company, not necessarily a client, so
// party_type is validated alongside the id it describes.
router.post('/credit-notes', staffOnly, [body('client_id').isInt({ min: 1 }), body('amount').isFloat({ min: 0 }), body('party_type').optional().isIn(['client', 'realtor', 'admin', 'employee'])], validate, c.creditNoteCrud.create);
router.get('/credit-notes/:id', staffOnly, c.creditNoteCrud.getOne);
router.put('/credit-notes/:id', staffOnly, c.creditNoteCrud.update);
router.delete('/credit-notes/:id', staffOnly, c.notDeletable('Credit notes'));
// Signing off is a different permission from raising, so that the person who
// asks for the write-off is not the one who grants it.
router.post('/credit-notes/:id/approve', requirePermission('finance.notes.approve'), notes.approve);
router.post('/credit-notes/:id/reject', requirePermission('finance.notes.approve'), [body('reason').notEmpty()], validate, notes.reject);
// Consuming an approved note against what the party owes.
router.post('/credit-notes/:id/settle', requirePermission('finance.credit-notes.manage'), notes.settle);

// Debit Notes
// The party is any user in the company, not necessarily a client, so
// party_type is validated alongside the id it describes.
// Recording that an approved note has actually been paid out.

/**
 * The same two documents, read by the person they are about.
 *
 * Deliberately NOT staffOnly, and deliberately a separate prefix rather than a
 * relaxation of /credit-notes: those routes list every note in the company, and
 * making them conditionally self-scoping would mean one handler whose blast
 * radius, if the condition were ever got wrong, is every client's finances. A
 * separate path scoped to req.user.id cannot return somebody else's note at all.
 */
// Own by construction: listMine filters on client_id = req.user.id. There is
// no company-wide form of this route to accidentally expose.
router.get('/my-notes', myNotes.listMine);
// "I have paid this" — records the claim and tells an approver. Does not settle.
// "You still owe me this." Throttled in the controller, not here.

// Everything waiting on an approver, both kinds together — an approver wants
// one queue, not two lists they have to remember to check.
router.get('/notes/pending-approval', requirePermission('finance.notes.approve'), notes.pending);

/**
 * Reminder schedules — when buyers are chased about an installment.
 *
 * Distinct from `/payment-reminders` below, which is a one-off reminder against
 * a single invoice. These are the RULES: how many reminders, on which days
 * either side of the due date, for a company or for particular invoices.
 */
router.get('/reminder-schedules/default', requirePermission('finance.payment-reminders.manage'), reminders.getDefault);
router.put('/reminder-schedules/default', requirePermission('finance.payment-reminders.manage'), reminders.saveDefault);
router.get('/reminder-schedules', requirePermission('finance.payment-reminders.manage'), reminders.listSchedules);
router.post('/reminder-schedules', requirePermission('finance.payment-reminders.manage'), [body('name').notEmpty()], validate, reminders.createSchedule);
router.put('/reminder-schedules/:id', requirePermission('finance.payment-reminders.manage'), reminders.updateSchedule);
router.post('/reminder-schedules/assign', requirePermission('finance.payment-reminders.manage'), reminders.assignToInvoices);
router.get('/invoices/:id/reminder-schedule', requirePermission('finance.payment-reminders.manage'), reminders.getForInvoice);

// Payment Reminders
router.get('/payment-reminders', staffOnly, c.paymentReminderCrud.list);
router.post('/payment-reminders', staffOnly, [body('invoice_id').isInt(), body('client_id').isInt(), body('reminder_date').isISO8601()], validate, c.paymentReminderCrud.create);
router.get('/payment-reminders/:id', staffOnly, c.paymentReminderCrud.getOne);
router.put('/payment-reminders/:id', staffOnly, c.paymentReminderCrud.update);
router.delete('/payment-reminders/:id', staffOnly, c.notDeletable('Payment reminders'));

// Commissions
/**
 * The EARNER's own view, declared FIRST.
 *
 * A literal path has to precede /commissions/:id or express captures it as an
 * id — `GET /commissions/mine` would arrive at getOne with id="mine". Not
 * staffOnly: a realtor has to be able to see what they are owed and ask for
 * it, and the controller scopes the result to the caller.
 */
// `mine` in the path and in the handler: both scope to req.user.id.
router.get('/commissions/mine', c.getMyCommissions);

router.get('/commissions', requirePermission('finance.commissions.view'), c.commissionCrud.list);
router.post('/commissions', requirePermission('finance.commissions.manage'), [body('employee_id').isInt(), body('title').notEmpty(), body('amount').isFloat({ min: 0 })], validate, c.commissionCrud.create);
router.get('/commissions/:id', requirePermission('finance.commissions.view'), c.commissionCrud.getOne);
router.put('/commissions/:id', requirePermission('finance.commissions.manage'), c.commissionCrud.update);
router.delete('/commissions/:id', staffOnly, c.notDeletable('Commissions'));

/**
 * The payout sequence: the earner requests, an admin approves, an admin pays.
 * Each step refuses to skip the previous one — see the controller.
 */
/**
 * The commission ENGINE's plans, versions and previews.
 *
 * A separate prefix from /commissions, which is the older per-sale payable and
 * a different resource: one is the configuration that decides what is owed, the
 * other is an individual amount owed. Sharing a prefix would make the
 * permissions read as though they governed the same thing.
 *
 * Reading a plan is finance.commissions.view; changing one is
 * finance.commissions.manage. Activation is the act that starts money moving,
 * so it sits behind the manage permission even though it writes no amount.
 */
router.get('/commission-plans', requirePermission('finance.commissions.view'), plansCtl.listPlans);
router.get('/commission-plans/:id', requirePermission('finance.commissions.view'), plansCtl.getPlan);
router.post('/commission-plans', requirePermission('finance.commissions.manage'), [body('name').notEmpty()], validate, plansCtl.createPlan);
router.post('/commission-plans/:id/versions', requirePermission('finance.commissions.manage'), plansCtl.createVersion);
router.post('/commission-plan-versions/:versionId/activate', requirePermission('finance.commissions.manage'), plansCtl.activateVersion);
router.delete('/commission-plans/:id', requirePermission('finance.commissions.manage'), plansCtl.archivePlan);
/**
 * WHERE a plan applies — a unit, a property, a project, a campaign, or the
 * company default. Separate from creating a version, because a plan's rules are
 * immutable once active while what it covers is not.
 */
router.put('/commission-plans/:id/assignment', requirePermission('finance.commissions.manage'), plansCtl.assignPlan);

/**
 * Checking a structure before trusting it. Neither writes anything
 * (FR-SIM-005), so both are gated on VIEW — an admin comparing options should
 * not need the permission that changes them.
 */
router.post('/commission-plans/validate', requirePermission('finance.commissions.view'), plansCtl.validateDraft);
router.post('/commission-plans/simulate', requirePermission('finance.commissions.view'), plansCtl.simulate);
router.post('/commission-plans/preview-deal', requirePermission('finance.commissions.view'), plansCtl.previewDeal);

/**
 * What the engine has cost and what it still owes (§8, FR-ANL-*).
 *
 * All READS, gated on VIEW, and every one of them scoped to the caller's own
 * company inside the controller rather than by a query parameter — a company
 * admin must not be able to widen the scope by asking.
 */
router.get('/commission-reports/summary', requirePermission('finance.commissions.view'), reportsCtl.summary);
router.get('/commission-reports/breakage', requirePermission('finance.commissions.view'), reportsCtl.breakage);
router.get('/commission-reports/cost-of-sale', requirePermission('finance.commissions.view'), reportsCtl.costOfSale);
router.get('/commission-reports/leaderboard', requirePermission('finance.commissions.view'), reportsCtl.leaderboard);
router.get('/commission-reports/liability', requirePermission('finance.commissions.view'), reportsCtl.liability);
router.get('/commission-reports/gl-export', requirePermission('finance.commissions.view'), reportsCtl.glExport);

/**
 * A POST because the candidate plan is a document in the body. It writes
 * nothing (FR-SIM-005), which is why it is gated on VIEW like the other
 * what-if endpoints rather than on manage.
 */
router.post('/commission-reports/backtest', requirePermission('finance.commissions.view'), reportsCtl.backtest);

/**
 * Screening flags. Reading them is a view; recording a verdict on one is an
 * act, and the act is what closes it.
 */
router.get('/commission-reports/flags', requirePermission('finance.commissions.view'), reportsCtl.listFlags);
router.post('/commission-reports/flags/:id/review', requirePermission('finance.commissions.manage'), reportsCtl.reviewFlag);

/**
 * Payout runs. Building a batch is a calculation and leaves a DRAFT; approving
 * and paying are the acts that move money, so both need manage.
 */
router.get('/commission-payouts', requirePermission('finance.commissions.view'), reportsCtl.listPayouts);
router.get('/commission-payouts/requests', requirePermission('finance.commissions.view'), reportsCtl.pendingPayoutRequests);
/*
 * There is no approval of the commission ITSELF any more. A realtor sees what
 * they have earned and may ask to be paid for it; the company's control is the
 * payout run below — built, approved and paid, each by a person — which is
 * where the money actually moves.
 */
router.post('/commission-payouts/build', requirePermission('finance.commissions.manage'), reportsCtl.buildPayouts);
router.post('/commission-payouts/:id/approve', requirePermission('finance.commissions.manage'), reportsCtl.approve);
/**
 * Recording that the transfer happened — and, since ACC-0.6, the moment the
 * cash book entry is written. It used to be written by settling a debit note
 * raised against the payout; the run's own build / approve / pay had made that
 * a second approval of the same money, on a document whose name meant the
 * opposite of what it did.
 */
router.post('/commission-payouts/:id/pay', requirePermission('finance.commissions.manage'), reportsCtl.pay);
router.post('/commission-payouts/:id/cancel', requirePermission('finance.commissions.manage'), reportsCtl.cancel);

/*
 * Refunding an overpayment (ACC-0.5). Raised by the system when a payment
 * lands beyond what was owed; approved, refused or paid by a person. Refusing
 * leaves the surplus on the plan against the next instalment, which is
 * frequently what the buyer wants.
 */
router.get('/refunds', requirePermission('finance.invoices.view'), refundsCtl.listRefunds);
router.post('/refunds/:id/approve', requirePermission('finance.notes.approve'), refundsCtl.approveRefund);
router.post('/refunds/:id/reject', requirePermission('finance.notes.approve'), refundsCtl.rejectRefund);
router.post('/refunds/:id/pay', requirePermission('finance.invoices.manage'), refundsCtl.markRefundPaid);

/**
 * A realtor's own statement needs no permission beyond being signed in — it is
 * their own earnings, and the id comes from the session rather than the path so
 * that authorisation is not a matter of remembering to check it. Reading
 * somebody ELSE's is a finance function and gated accordingly.
 */
router.get('/commission-statements/mine', reportsCtl.myStatement);
/**
 * A realtor asking to be paid for particular commissions. No permission gate
 * beyond being signed in: the controller reads the realtor id from the session,
 * so the only thing anybody can request is their own.
 */
// `mine`: the handler resolves the realtor from the token, not from the body.
router.post('/commission-statements/mine/request-payout', reportsCtl.requestMyPayout);
router.get('/commission-statements/:realtorId', requirePermission('finance.commissions.view'), reportsCtl.statementFor);

/*
 * ── Accounting: the chart, the journal, the trial balance (ACC-1, ACC-2) ────
 *
 * Reads take accounting.view. Writing to the CHART and writing a MANUAL
 * JOURNAL are separate permissions on purpose: editing an account is
 * configuration, and a manual journal is somebody asserting a figure the
 * system cannot derive. There is deliberately no route that edits or deletes a
 * posted entry — a journal is corrected by reversing it, and the database
 * refuses the alternative.
 */
router.get('/ledger/accounts', requirePermission('accounting.view'), acctCtl.listAccounts);
router.post('/ledger/accounts', requirePermission('accounting.settings.manage'), acctCtl.createAccount);
router.put('/ledger/accounts/:id', requirePermission('accounting.settings.manage'), acctCtl.updateAccount);
router.delete('/ledger/accounts/:id', requirePermission('accounting.settings.manage'), acctCtl.deactivateAccount);

// Literal paths before /:id, or "trial-balance" is read as an entry id.
router.get('/ledger/trial-balance', requirePermission('accounting.view'), acctCtl.trialBalance);

/*
 * ── The statements (ACC-5) ─────────────────────────────────────────────────
 *
 * All read-only, all gated on accounting.view: a person who may look at the
 * ledger may look at what it adds up to. The export is the exit guarantee and
 * sits behind the same permission, because refusing somebody their own books
 * would be a strange thing for it to protect.
 */
router.get('/ledger/profit-and-loss', requirePermission('accounting.view'), stmtCtl.profitAndLoss);
router.get('/ledger/balance-sheet', requirePermission('accounting.view'), stmtCtl.balanceSheet);
router.get('/ledger/cash-flow', requirePermission('accounting.view'), stmtCtl.cashFlow);
router.get('/ledger/cash-basis', requirePermission('accounting.view'), stmtCtl.cashBasis);
router.get('/ledger/aged-receivables', requirePermission('accounting.view'), stmtCtl.agedReceivables);
router.get('/ledger/vat-return', requirePermission('accounting.view'), stmtCtl.vatReturn);
router.get('/ledger/withholding', requirePermission('accounting.view'), stmtCtl.withholdingSchedule);
router.get('/ledger/export', requirePermission('accounting.view'), stmtCtl.exportJournal);
router.get('/ledger/pack', requirePermission('accounting.view'), stmtCtl.statementPack);

/*
 * ── Period close (ACC-7) ───────────────────────────────────────────────────
 *
 * Reopening is gated on the same permission as closing but is a separate act
 * with a mandatory reason — the control is the audit trail, not the
 * permission. The audit pack is readable by anyone who may read the ledger,
 * because refusing somebody their own closed books would be a strange thing to
 * protect.
 */
router.get('/periods', requirePermission('accounting.view'), periodCtl.listPeriods);
router.post('/periods', requirePermission('accounting.periods.manage'), periodCtl.createPeriods);
router.get('/periods/:id/check', requirePermission('accounting.view'), periodCtl.checkPeriod);
router.get('/periods/:id/audit-pack', requirePermission('accounting.view'), periodCtl.auditPack);
router.post('/periods/:id/close', requirePermission('accounting.periods.manage'), periodCtl.closePeriod);
router.post('/periods/:id/reopen', requirePermission('accounting.periods.manage'), periodCtl.reopenPeriod);

/*
 * ── Bank reconciliation (ACC-6) ────────────────────────────────────────────
 *
 * Importing a statement and matching against it are accounting work, so they
 * sit behind accounting.view for reading and accounting.post for changing.
 * Posting an unmatched line writes a journal no document produced, which is
 * journals.manage — the same bar as a manual entry, because that is what it
 * is.
 */
router.get('/bank-rec/accounts', requirePermission('accounting.view'), bankCtl.bankAccounts);
router.get('/bank-rec/mappings', requirePermission('accounting.view'), bankCtl.listMappings);
router.get('/bank-rec/summary', requirePermission('accounting.view'), bankCtl.summary);
router.get('/bank-rec/suggestions', requirePermission('accounting.view'), bankCtl.suggestions);
router.get('/bank-rec/reconciliations', requirePermission('accounting.view'), bankCtl.listReconciliations);
router.get('/bank-rec/lines', requirePermission('accounting.view'), bankCtl.listLines);
router.post('/bank-rec/import', requirePermission('accounting.post'), bankCtl.importStatement);
router.post('/bank-rec/lines/:id/match', requirePermission('accounting.post'), bankCtl.matchLine);
router.post('/bank-rec/lines/:id/unmatch', requirePermission('accounting.post'), bankCtl.unmatchLine);
router.post('/bank-rec/lines/:id/ignore', requirePermission('accounting.post'), bankCtl.ignoreLine);
router.post('/bank-rec/lines/:id/post', requirePermission('accounting.journals.manage'), bankCtl.postLine);
router.post('/bank-rec/lock', requirePermission('accounting.post'), bankCtl.lockReconciliation);

/*
 * ── Moving a company's books in (ACC-9) ────────────────────────────────────
 *
 * All behind accounting.settings.manage: importing a chart or a set of
 * opening balances decides what the company is worth on the day it arrives,
 * which is a stronger act than posting a journal and belongs with whoever
 * owns the chart.
 */
router.get('/migration/status', requirePermission('accounting.view'), migrationCtl.migrationStatus);
router.get('/migration/types', requirePermission('accounting.view'), migrationCtl.typeVocabulary);
router.post('/migration/chart', requirePermission('accounting.settings.manage'), migrationCtl.importChart);
router.post('/migration/opening-balances', requirePermission('accounting.settings.manage'), migrationCtl.importOpeningBalances);
router.post('/migration/open-items', requirePermission('accounting.settings.manage'), migrationCtl.importOpenItems);
router.get('/ledger/journal', requirePermission('accounting.view'), acctCtl.listJournal);
router.post('/ledger/journal', requirePermission('accounting.journals.manage'), acctCtl.createManualJournal);
router.get('/ledger/journal/:id', requirePermission('accounting.view'), acctCtl.getJournalEntry);
router.post('/ledger/journal/:id/reverse', requirePermission('accounting.journals.manage'), acctCtl.reverseJournalEntry);
/*
 * A journal from a CSV (ACC-4.6) — a payroll bureau's monthly summary, a
 * depreciation schedule kept outside. Same permission as a manual journal,
 * because that is what it is once it has been read.
 */
router.post('/ledger/journal/import', requirePermission('accounting.journals.manage'), acctCtl.importJournalCsv);

/*
 * ── Purchases: vendors, bills and payables (ACC-4) ─────────────────────────
 *
 * Approving is a separate permission from raising and paying, because the
 * person who checks a contractor's invoice should not be the one who commits
 * the company to it.
 */
router.get('/vendors', requirePermission('finance.bills.view'), payablesCtl.listVendors);
router.post('/vendors', requirePermission('finance.vendors.manage'), payablesCtl.createVendor);
router.put('/vendors/:id', requirePermission('finance.vendors.manage'), payablesCtl.updateVendor);

// Literal paths before /:id.
router.get('/bills/aged', requirePermission('finance.bills.view'), payablesCtl.agedPayables);
router.get('/bills', requirePermission('finance.bills.view'), payablesCtl.listBills);
router.post('/bills', requirePermission('finance.bills.manage'), payablesCtl.createBill);
router.post('/bills/:id/approve', requirePermission('finance.bills.approve'), payablesCtl.approveBill);
router.post('/bills/:id/reject', requirePermission('finance.bills.approve'), payablesCtl.rejectBill);
router.post('/bills/:id/pay', requirePermission('finance.bills.manage'), payablesCtl.payBill);

/*
 * ── Development cost: what capitalises, and where it is (ACC-10) ───────────
 *
 * Reading the WIP report is an accounting view. Changing which costs
 * capitalise, or what a project is expected to fetch, changes the balance
 * sheet — so it sits behind accounting.settings.manage rather than behind the
 * permission that lets somebody raise a bill.
 *
 * The two postings are gated on journals.manage for the same reason a manual
 * journal is: they write an entry that no document produced.
 */
router.get('/development/cost-types', requirePermission('accounting.view'), devCtl.listExpenseTypes);
router.post('/development/cost-types', requirePermission('accounting.settings.manage'), devCtl.createExpenseType);
router.put('/development/cost-types/:id', requirePermission('accounting.settings.manage'), devCtl.updateExpenseType);
router.get('/development/coding-accounts', requirePermission('accounting.view'), devCtl.codingAccounts);

router.get('/development/policies', requirePermission('accounting.view'), devCtl.listPolicies);
router.post('/development/policies', requirePermission('accounting.settings.manage'), devCtl.savePolicy);

// Literal paths before /:propertyId.
router.get('/development/wip', requirePermission('accounting.view'), devCtl.wipReport);
router.get('/development/projects/:propertyId', requirePermission('accounting.view'), devCtl.projectDetail);
router.post('/development/projects/:propertyId/nrv', requirePermission('accounting.settings.manage'), devCtl.assessNrv);
router.post('/development/projects/:propertyId/catch-up', requirePermission('accounting.journals.manage'), devCtl.postCatchUp);
router.post('/development/projects/:propertyId/write-down', requirePermission('accounting.journals.manage'), devCtl.postWriteDown);

/*
 * ── Handover: when a sale becomes revenue (ACC-8) ──────────────────────────
 *
 * Recording one is a sales-operations act and sits behind the permission that
 * manages invoices; what it POSTS is decided by the ledger, not by the person
 * recording it. Reversing is separate, because it moves revenue back out.
 */
router.get('/handovers/awaiting', requirePermission('finance.invoices.view'), handoverCtl.awaitingHandover);
router.get('/handovers/deferred-revenue', requirePermission('accounting.view'), handoverCtl.deferredRevenue);
router.get('/handovers', requirePermission('finance.invoices.view'), handoverCtl.listHandovers);
router.post('/handovers', requirePermission('finance.invoices.manage'), handoverCtl.recordHandover);
router.post('/handovers/:id/acknowledgement', requirePermission('finance.invoices.manage'), handoverCtl.attachAcknowledgement);
router.post('/handovers/:id/reverse', requirePermission('accounting.journals.manage'), handoverCtl.reverseHandover);

// Refuses in the handler unless the commission is the caller's own.
router.post('/commissions/:id/request-payout', c.requestCommissionPayout);
router.post('/commissions/:id/approve', requirePermission('finance.commissions.manage'), c.approveCommission);
router.post('/commissions/:id/pay', requirePermission('finance.commissions.manage'), c.payCommission);

// Commission Rules
router.get('/commission-rules', staffOnly, c.commissionRuleCrud.list);
router.post('/commission-rules', staffOnly, [body('value').isFloat({ min: 0 })], validate, c.commissionRuleCrud.create);
router.get('/commission-rules/:id', staffOnly, c.commissionRuleCrud.getOne);
router.put('/commission-rules/:id', staffOnly, c.commissionRuleCrud.update);
router.delete('/commission-rules/:id', staffOnly, c.notDeletable('Commission rules'));
router.post('/commissions/calculate', staffOnly, c.calculateCommission);

// Receipts
/**
 * Reading a receipt is NOT staff-only.
 *
 * A receipt is the buyer's own payment request, and while these were all
 * staff-gated there was nowhere for them to see one: the row existed, carried a
 * status, and was unreachable by the person waiting on it. receiptScope pins a
 * buyer to their own rows, exactly as invoiceScope does for invoices, so
 * opening the read does not widen what anyone can see.
 */
/*
 * receiptScope narrows a buyer to receipts for their own payments. Two
 * permissions accepted because navConfig gates the Payment Approvals screen on
 * finance.commissions.view — refusing that holder here would 403 somebody the
 * menu had just invited in.
 */
router.get('/receipts', permissionOrSelfScoped('finance.commissions.view', 'finance.invoices.view'), c.receiptCrud.list);
router.get('/receipts/:id', permissionOrSelfScoped('finance.commissions.view', 'finance.invoices.view'), c.receiptCrud.getOne);
/**
 * What a receipt needs in order to BE a receipt — the property, the unit, the
 * quantity and the balance left. Not staff-only, for the same reason the
 * receipt itself is not: the buyer prints their own.
 */
router.get('/receipts/:id/print-data', permissionOrSelfScoped('finance.commissions.view', 'finance.invoices.view'), c.getReceiptPrintData);
/*
 * The rendered document, for printing. Same scope as the print data it is
 * drawn from — the web app used to draw it itself, which meant the emailed
 * receipt and the printed one were two different pieces of code.
 */
router.get('/receipts/:id/document', permissionOrSelfScoped('finance.commissions.view', 'finance.invoices.view'), c.getReceiptDocument);

router.post('/receipts', staffOnly, [body('amount').isFloat({ min: 0 })], validate, c.createReceipt);

/**
 * The buyer's own corrections. Scoped and state-checked in the controller:
 * allowed while pending or rejected, refused once approved or cancelled.
 */
router.put('/receipts/:id', permissionOrSelfScoped('finance.invoices.view'), [
  body('amount').optional().isFloat({ min: 0.01 }),
  body('document_url').optional().notEmpty(),
], validate, c.updateOwnReceipt);
// Both go through findActionableReceipt → receiptScope, so a buyer reaches
// only their own and only while it is still pending or rejected.
router.post('/receipts/:id/cancel', permissionOrSelfScoped('finance.invoices.view'), c.cancelOwnReceipt);

/**
 * Documents attached to an invoice.
 *
 * Listing is NOT staff-only: the whole point is that the buyer reads them, and
 * the controller scopes through invoiceScope so they only ever reach their own
 * invoice. Attaching and removing are staff actions behind the same permission
 * that manages invoices.
 */
router.get('/invoices/:id/documents', permissionOrSelfScoped('finance.invoices.view'), c.listInvoiceDocuments);
router.post('/invoices/:id/documents', requirePermission('finance.invoices.manage'), [
  body('name').trim().notEmpty(),
  body('url').trim().notEmpty(),
], validate, c.attachInvoiceDocument);
router.delete('/invoices/:id/documents/:docId', requirePermission('finance.invoices.manage'), c.deleteInvoiceDocument);

/**
 * Deciding one takes a permission, and a rejection must carry a reason — the
 * buyer is shown it, and "rejected" with no explanation leaves them nothing to
 * act on.
 *
 * ── Why staffOnly was not enough here ───────────────────────────────────────
 *
 * staffOnly asks one question: are you NOT a client or a realtor. Every other
 * account passes it — front desk, media, customer care, any employee — and
 * this endpoint credits money against an invoice, settles it, allocates the
 * payment across the schedule and accrues commission. The amount credited comes
 * from req.body.amount rather than from the receipt, so the caller chooses it.
 *
 * Signing off on a credit note has always taken finance.notes.approve,
 * deliberately separate from raising one. The larger money flow was gated on a
 * role shape instead, which is both weaker and unable to be delegated to a
 * custom role.
 */
router.post('/receipts/:id/verify', requirePermission('finance.invoices.manage'), c.verifyReceipt);
router.post('/receipts/:id/reject', requirePermission('finance.invoices.manage'), [
  body('reason').optional().trim().notEmpty(),
], validate, c.rejectReceipt);

// Referral
router.get('/referral/setting', staffOnly, c.getReferralSetting);
router.post('/referral/setting', staffOnly, c.upsertReferralSetting);
router.get('/referral/transactions', staffOnly, c.listReferralTransactions);
router.post('/referral/transactions', staffOnly, [body('referrer_id').isInt(), body('referred_id').isInt(), body('amount').isFloat({ min: 0 })], validate, c.createReferralTransaction);
router.put('/referral/transactions/:id', staffOnly, c.updateReferralTransaction);

// Payment gateways — credential checks for the Test button in Settings.
// Read-only at the gateway; see controllers/paymentGatewayController.js for why
// these do not initiate payments.
router.post('/payments/stripe/intent', adminOnly, gateways.stripeIntent);
router.post('/payments/paystack/verify', adminOnly, gateways.paystackVerify);
router.post('/payments/flutterwave/verify', adminOnly, gateways.flutterwaveVerify);

// Reports
/**
 * Commission across BOTH systems — the engine and the older flat rate. The
 * reports page used to read the flat-rate table alone and sum it in the
 * browser, which reported zero for every company on the engine.
 */
router.get('/reports/commissions', requirePermission('finance.reports.view'), c.commissionReport);
router.get('/reports/revenue', staffOnly, c.revenueReport);
// Top performing properties, units and clients, by money actually received.
router.get('/reports/top-performers', staffOnly, c.topPerformersReport);
router.get('/reports/transactions', staffOnly, c.transactionReport);
router.get('/reports/invoices', staffOnly, c.invoiceReport);

module.exports = router;

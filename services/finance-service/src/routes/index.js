const router = require('express').Router();
const { body } = require('express-validator');
const { verifyToken, requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validation');
const c = require('../controllers/financeController');
const plansCtl = require('../controllers/commissionPlanController');
const gateways = require('../controllers/paymentGatewayController');
const plans = require('../controllers/installmentPlanController');
const schedules = require('../controllers/paymentScheduleController');

router.use(verifyToken);

/**
 * Finance is staff territory. Clients and realtors reach exactly three things:
 * their own invoices, their own payments, and the payment-analysis endpoint
 * (which authorises per target). Everything else — taxes, bank accounts,
 * commissions, credit/debit notes, reminders, receipts, plans, reports — is
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
router.get('/my-properties', c.getMyProperties);
router.get('/my-properties/:userId', c.getMyProperties);

// Invoices
router.get('/invoices', c.invoiceCrud.list);
router.post('/invoices', staffOnly, [body('client_id').isInt(), body('amount').isFloat({ min: 1 })], validate, c.invoiceCrud.create);
router.get('/invoices/:id', c.invoiceCrud.getOne);
router.put('/invoices/:id', staffOnly, c.invoiceCrud.update);
router.delete('/invoices/:id', staffOnly, c.invoiceCrud.remove);
router.post('/invoices/:id/send', staffOnly, c.sendInvoice);
router.post('/invoices/:id/pay', staffOnly, [body('payment_method').notEmpty()], validate, c.payInvoice);
router.post('/invoices/:id/mark-paid', staffOnly, c.markInvoicePaid);
router.get('/invoices/:id/payments', c.getInvoicePayments);
// Buyer-facing: how to pay, and submitting proof. Both are scoped to the
// invoice's owner by invoiceScope, so a client only ever sees their own.
// payment-options now also carries the payment plan and its schedule table, so
// the payment page needs no second round trip (FRD 5.2).
router.get('/invoices/:id/payment-options', c.getPaymentOptions);
router.post('/invoices/:id/receipts', [body('document_url').notEmpty()], validate, c.submitInvoiceReceipt);

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
router.get('/transactions', c.transactionCrud.list);
router.post('/transactions', staffOnly, [body('type').notEmpty(), body('amount').isFloat({ min: 0 })], validate, c.transactionCrud.create);
router.get('/transactions/:id', c.transactionCrud.getOne);
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
router.post('/credit-notes', staffOnly, [body('client_id').isInt(), body('amount').isFloat({ min: 0 }), body('party_type').optional().isIn(['client', 'realtor', 'admin', 'employee'])], validate, c.creditNoteCrud.create);
router.get('/credit-notes/:id', staffOnly, c.creditNoteCrud.getOne);
router.put('/credit-notes/:id', staffOnly, c.creditNoteCrud.update);
router.delete('/credit-notes/:id', staffOnly, c.notDeletable('Credit notes'));

// Debit Notes
router.get('/debit-notes', staffOnly, c.debitNoteCrud.list);
// The party is any user in the company, not necessarily a client, so
// party_type is validated alongside the id it describes.
router.post('/debit-notes', staffOnly, [body('client_id').isInt(), body('amount').isFloat({ min: 0 }), body('party_type').optional().isIn(['client', 'realtor', 'admin', 'employee'])], validate, c.debitNoteCrud.create);
router.get('/debit-notes/:id', staffOnly, c.debitNoteCrud.getOne);
router.put('/debit-notes/:id', staffOnly, c.debitNoteCrud.update);
router.delete('/debit-notes/:id', staffOnly, c.notDeletable('Debit notes'));

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
 * Checking a structure before trusting it. Neither writes anything
 * (FR-SIM-005), so both are gated on VIEW — an admin comparing options should
 * not need the permission that changes them.
 */
router.post('/commission-plans/validate', requirePermission('finance.commissions.view'), plansCtl.validateDraft);
router.post('/commission-plans/simulate', requirePermission('finance.commissions.view'), plansCtl.simulate);
router.post('/commission-plans/preview-deal', requirePermission('finance.commissions.view'), plansCtl.previewDeal);

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
router.get('/receipts', c.receiptCrud.list);
router.get('/receipts/:id', c.receiptCrud.getOne);

router.post('/receipts', staffOnly, [body('amount').isFloat({ min: 0 })], validate, c.createReceipt);

/**
 * The buyer's own corrections. Scoped and state-checked in the controller:
 * allowed while pending or rejected, refused once approved or cancelled.
 */
router.put('/receipts/:id', [
  body('amount').optional().isFloat({ min: 0.01 }),
  body('document_url').optional().notEmpty(),
], validate, c.updateOwnReceipt);
router.post('/receipts/:id/cancel', c.cancelOwnReceipt);

/**
 * Documents attached to an invoice.
 *
 * Listing is NOT staff-only: the whole point is that the buyer reads them, and
 * the controller scopes through invoiceScope so they only ever reach their own
 * invoice. Attaching and removing are staff actions behind the same permission
 * that manages invoices.
 */
router.get('/invoices/:id/documents', c.listInvoiceDocuments);
router.post('/invoices/:id/documents', requirePermission('finance.invoices.manage'), [
  body('name').trim().notEmpty(),
  body('url').trim().notEmpty(),
], validate, c.attachInvoiceDocument);
router.delete('/invoices/:id/documents/:docId', requirePermission('finance.invoices.manage'), c.deleteInvoiceDocument);

/**
 * Deciding one stays staff-only, and a rejection must carry a reason — the
 * buyer is shown it, and "rejected" with no explanation leaves them nothing to
 * act on.
 */
router.post('/receipts/:id/verify', staffOnly, c.verifyReceipt);
router.post('/receipts/:id/reject', staffOnly, [
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
router.get('/reports/revenue', staffOnly, c.revenueReport);
// Top performing properties, units and clients, by money actually received.
router.get('/reports/top-performers', staffOnly, c.topPerformersReport);
router.get('/reports/transactions', staffOnly, c.transactionReport);
router.get('/reports/invoices', staffOnly, c.invoiceReport);

module.exports = router;

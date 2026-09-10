const router = require('express').Router();
const { body } = require('express-validator');
const { verifyToken } = require('../middleware/auth');
const { validate } = require('../middleware/validation');
const c = require('../controllers/financeController');
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
 * The two reads are staffOnly rather than adminOnly, and the client reaches
 * the same figures through payment-options above — which is invoice-scoped, so
 * a client sees only their own.
 */
router.get('/invoices/:id/schedules', staffOnly, schedules.getInvoiceSchedules);
router.get('/invoices/:id/allocations', staffOnly, schedules.getInvoiceAllocations);
// FRD 13: editing quantity and cancelling are company-admin actions.
router.put('/invoices/:id/quantity', adminOnly, [body('quantity').isInt({ min: 1 })], validate, schedules.editInvoiceQuantity);
router.post('/invoices/:id/cancel', adminOnly, schedules.cancelInvoice);
// FRD 15.5 — mandatory reason, audited on the fee application row.
router.post('/payment-schedules/:scheduleId/waive-fee', adminOnly, [body('reason').notEmpty()], validate, schedules.waiveScheduleFee);
// FRD 8.2 — the overpayments flagged for admin attention.
router.get('/payment-schedules/credit-balances', adminOnly, schedules.listCreditBalances);

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
 * plan picker on the purchase screen (FRD 4.1), and it exposes only what that
 * screen shows — plan terms and the amounts for one unit and quantity. Every
 * configuration route is adminOnly per FRD 13.
 */
router.get('/installment-plans/units/:propertyUnitId/options', plans.getUnitPurchaseOptions);
router.get('/installment-plans/units/:propertyUnitId', adminOnly, plans.listPlansForUnit);
router.get('/installment-plans', staffOnly, plans.installmentPlanCrud.list);
router.post('/installment-plans', adminOnly, [body('name').notEmpty(), body('duration_months').isInt({ min: 1 })], validate, plans.installmentPlanCrud.create);
router.get('/installment-plans/:id', staffOnly, plans.installmentPlanCrud.getOne);
router.put('/installment-plans/:id', adminOnly, [body('name').notEmpty(), body('duration_months').isInt({ min: 1 })], validate, plans.installmentPlanCrud.update);
router.delete('/installment-plans/:id', adminOnly, plans.installmentPlanCrud.remove);
// Assignment is per UNIT, not per property (FRD 3.2).
router.post('/installment-plans/:id/units', adminOnly, [body('property_unit_id').isInt({ min: 1 })], validate, plans.assignPlanToUnit);
router.delete('/installment-plans/:id/units/:unitId', adminOnly, plans.unassignPlanFromUnit);

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
router.post('/credit-notes', staffOnly, [body('client_id').isInt(), body('amount').isFloat({ min: 0 })], validate, c.creditNoteCrud.create);
router.get('/credit-notes/:id', staffOnly, c.creditNoteCrud.getOne);
router.put('/credit-notes/:id', staffOnly, c.creditNoteCrud.update);
router.delete('/credit-notes/:id', staffOnly, c.notDeletable('Credit notes'));

// Debit Notes
router.get('/debit-notes', staffOnly, c.debitNoteCrud.list);
router.post('/debit-notes', staffOnly, [body('client_id').isInt(), body('amount').isFloat({ min: 0 })], validate, c.debitNoteCrud.create);
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
router.get('/commissions', staffOnly, c.commissionCrud.list);
router.post('/commissions', staffOnly, [body('employee_id').isInt(), body('title').notEmpty(), body('amount').isFloat({ min: 0 })], validate, c.commissionCrud.create);
router.get('/commissions/:id', staffOnly, c.commissionCrud.getOne);
router.put('/commissions/:id', staffOnly, c.commissionCrud.update);
router.delete('/commissions/:id', staffOnly, c.notDeletable('Commissions'));
router.post('/commissions/:id/approve', staffOnly, c.approveCommission);
router.post('/commissions/:id/pay', staffOnly, c.payCommission);

// Commission Rules
router.get('/commission-rules', staffOnly, c.commissionRuleCrud.list);
router.post('/commission-rules', staffOnly, [body('value').isFloat({ min: 0 })], validate, c.commissionRuleCrud.create);
router.get('/commission-rules/:id', staffOnly, c.commissionRuleCrud.getOne);
router.put('/commission-rules/:id', staffOnly, c.commissionRuleCrud.update);
router.delete('/commission-rules/:id', staffOnly, c.notDeletable('Commission rules'));
router.post('/commissions/calculate', staffOnly, c.calculateCommission);

// Receipts
router.get('/receipts', staffOnly, c.receiptCrud.list);
router.post('/receipts', staffOnly, [body('amount').isFloat({ min: 0 })], validate, c.createReceipt);
router.get('/receipts/:id', staffOnly, c.receiptCrud.getOne);
router.post('/receipts/:id/verify', staffOnly, c.verifyReceipt);
router.post('/receipts/:id/reject', staffOnly, c.rejectReceipt);

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
router.get('/reports/transactions', staffOnly, c.transactionReport);
router.get('/reports/invoices', staffOnly, c.invoiceReport);

module.exports = router;

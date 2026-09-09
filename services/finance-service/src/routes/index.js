const router = require('express').Router();
const { body } = require('express-validator');
const { verifyToken } = require('../middleware/auth');
const { validate } = require('../middleware/validation');
const c = require('../controllers/financeController');

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
router.get('/invoices/:id/payment-options', c.getPaymentOptions);
router.post('/invoices/:id/receipts', [body('document_url').notEmpty()], validate, c.submitInvoiceReceipt);

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

// Reports
router.get('/reports/revenue', staffOnly, c.revenueReport);
router.get('/reports/transactions', staffOnly, c.transactionReport);
router.get('/reports/invoices', staffOnly, c.invoiceReport);

module.exports = router;

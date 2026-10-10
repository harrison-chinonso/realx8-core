const router = require('express').Router();
const { verifyToken, requireRoles } = require('../middleware/auth');
const billing = require('../controllers/billingController');

/** Platform administrators only. */
const requireSuperiorAdmin = (req, res, next) => (req.user?.isSuperiorAdmin
  ? next()
  : res.status(403).json({ message: 'Only platform administrators can manage billing.' }));

// The caller's own company.
router.get('/billing/status', verifyToken, billing.status);
router.get('/billing/plans', verifyToken, billing.plansForApp);
router.post('/billing/checkout', verifyToken, requireRoles('super_admin', 'admin'), billing.checkout);
router.get('/billing/confirm/:reference', verifyToken, requireRoles('super_admin', 'admin'), billing.confirm);
router.get('/billing/payments', verifyToken, requireRoles('super_admin', 'admin'), billing.payments);
router.get('/billing/held', verifyToken, requireRoles('super_admin', 'admin'), billing.held);

// Platform administrators.
router.get('/billing/admin/plans', verifyToken, requireSuperiorAdmin, billing.listPlans);
router.put('/billing/admin/plans/:code', verifyToken, requireSuperiorAdmin, billing.updatePlan);
router.get('/billing/admin/subscriptions', verifyToken, requireSuperiorAdmin, billing.listSubscriptions);
router.post('/billing/admin/subscriptions/:companyId/mark-paid', verifyToken, requireSuperiorAdmin, billing.markPaid);
router.post('/billing/admin/subscriptions/:companyId/extend-trial', verifyToken, requireSuperiorAdmin, billing.extendTrial);
router.post('/billing/admin/subscriptions/:companyId/change-plan', verifyToken, requireSuperiorAdmin, billing.changePlan);

// Paystack, server to server. No session: the signature is the credential.
router.post('/webhooks/paystack', billing.paystackWebhook);

module.exports = router;

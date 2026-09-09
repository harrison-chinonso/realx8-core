const router = require('express').Router();
const { body } = require('express-validator');
const { verifyToken } = require('../middleware/auth');
const { validate } = require('../middleware/validation');
const controller = require('../controllers/investmentController');

router.use(verifyToken);
router.get('/investment-plans', controller.planCrud.list);
router.post('/investment-plans', [body('name').notEmpty()], validate, controller.planCrud.create);
router.get('/investment-plans/:id', controller.planCrud.getOne);
router.put('/investment-plans/:id', controller.planCrud.update);
router.delete('/investment-plans/:id', controller.planCrud.remove);

router.get('/investment-categories', controller.categoryCrud.list);
router.post('/investment-categories', [body('name').notEmpty()], validate, controller.categoryCrud.create);
router.get('/investment-categories/:id', controller.categoryCrud.getOne);
router.put('/investment-categories/:id', controller.categoryCrud.update);
router.delete('/investment-categories/:id', controller.categoryCrud.remove);

router.get('/investment-periods', controller.periodCrud.list);
router.post('/investment-periods', [body('name').notEmpty(), body('days').isInt({ min: 1 })], validate, controller.periodCrud.create);
router.get('/investment-periods/:id', controller.periodCrud.getOne);
router.put('/investment-periods/:id', controller.periodCrud.update);
router.delete('/investment-periods/:id', controller.periodCrud.remove);

router.get('/investments', controller.investmentCrud.list);
router.get('/investments/retention-alerts', controller.getRetentionAlerts);
// Client-facing: literal paths must precede /investments/:id routes.
router.get('/investments/open-plans', controller.listOpenPlans);
router.post('/investments/subscribe', [body('plan_id').isInt(), body('amount').isFloat({ min: 1 })], validate, controller.subscribeToPlan);

router.post('/investments', [body('user_id').isInt(), body('plan_id').isInt(), body('amount').isFloat({ min: 1 })], validate, controller.investmentCrud.create);
router.get('/investments/:id', controller.investmentCrud.getOne);
router.put('/investments/:id', controller.investmentCrud.update);
router.delete('/investments/:id', controller.investmentCrud.remove);
router.get('/investments/:id/transactions', controller.getTransactions);
router.get('/investments/:id/payouts', controller.getPayouts);
router.post('/investments/:id/activate', controller.activateInvestment);
router.post('/investments/:id/payouts', controller.createPayout);
router.post('/investments/:id/payout', controller.createPayout);

// Cash-out workflow
router.post('/investments/:id/request-cashout', controller.requestCashOut);
router.post('/investments/:id/approve-cashout', controller.approveCashOut);
router.post('/investments/:id/reject-cashout', controller.rejectCashOut);

module.exports = router;

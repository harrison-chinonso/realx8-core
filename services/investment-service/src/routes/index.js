const router = require('express').Router();
const { body } = require('express-validator');
const { verifyToken, requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validation');
const controller = require('../controllers/investmentController');

router.use(verifyToken);
/*
 * Two permissions, either of which suffices.
 *
 * A client or realtor browsing what they could invest in holds
 * investments.own.view; staff administering the programme hold
 * investments.view. Requiring only the latter would hide the catalogue from
 * the people it exists to sell to, which is why these were left open to any
 * authenticated account at all.
 */
router.get('/investment-plans', requirePermission('investments.view', 'investments.own.view'), controller.planCrud.list);
/*
 * Everything that CHANGES the programme is investments.manage. The catalogue
 * grants it to admins only; investments.own.view — which every client and
 * realtor holds — deliberately does not reach any of these.
 */
router.post('/investment-plans', requirePermission('investments.manage'), [body('name').notEmpty()], validate, controller.planCrud.create);
router.get('/investment-plans/:id', requirePermission('investments.view', 'investments.own.view'), controller.planCrud.getOne);
router.put('/investment-plans/:id', requirePermission('investments.manage'), controller.planCrud.update);
router.delete('/investment-plans/:id', requirePermission('investments.manage'), controller.planCrud.remove);

router.get('/investment-categories', requirePermission('investments.view', 'investments.own.view'), controller.categoryCrud.list);
router.post('/investment-categories', requirePermission('investments.manage'), [body('name').notEmpty()], validate, controller.categoryCrud.create);
router.get('/investment-categories/:id', requirePermission('investments.view', 'investments.own.view'), controller.categoryCrud.getOne);
router.put('/investment-categories/:id', requirePermission('investments.manage'), controller.categoryCrud.update);
router.delete('/investment-categories/:id', requirePermission('investments.manage'), controller.categoryCrud.remove);

router.get('/investment-periods', requirePermission('investments.view', 'investments.own.view'), controller.periodCrud.list);
router.post('/investment-periods', requirePermission('investments.manage'), [body('name').notEmpty(), body('days').isInt({ min: 1 })], validate, controller.periodCrud.create);
router.get('/investment-periods/:id', requirePermission('investments.view', 'investments.own.view'), controller.periodCrud.getOne);
router.put('/investment-periods/:id', requirePermission('investments.manage'), controller.periodCrud.update);
router.delete('/investment-periods/:id', requirePermission('investments.manage'), controller.periodCrud.remove);

/*
 * investmentScope already reads investments.view and narrows anyone without
 * it to their own rows, so the guard only has to stop an account holding
 * NEITHER permission — which, before this, meant nobody was stopped.
 */
router.get('/investments', requirePermission('investments.view', 'investments.own.view'), controller.investmentCrud.list);
// Whose money is at risk of leaving — an administrator's question.
router.get('/investments/retention-alerts', requirePermission('investments.view'), controller.getRetentionAlerts);
// Client-facing: literal paths must precede /investments/:id routes.
router.get('/investments/open-plans', requirePermission('investments.view', 'investments.own.view'), controller.listOpenPlans);
/**
 * An investor's own position, and what leaving early would cost. Both scoped to
 * the signed-in person by the controller, so there is nothing here that could
 * name somebody else's money.
 */
router.get('/investments/mine', requirePermission('investments.view', 'investments.own.view'), controller.myPositions);
router.get('/investments/:id/exit-quote', requirePermission('investments.view', 'investments.own.view'), controller.exitQuote);

/** Catch up with a payment that has just been approved, without waiting for the sweep. */
router.post('/investments/:id/sync-funding', requirePermission('investments.manage'), controller.syncFunding);

/** The nightly accrual, run by hand. Safe to repeat — nothing further falls due. */
// The nightly sweep, run by hand. It raises payouts.
router.post('/investments/run-accrual', requirePermission('investments.manage'), controller.runAccrualNow);

/*
 * The one write an investor performs. A client or realtor holds
 * investments.own.view and nothing else here, so this takes both — gating it
 * on manage would mean nobody could ever invest.
 */
router.post('/investments/subscribe', requirePermission('investments.view', 'investments.own.view'), [body('plan_id').isInt(), body('amount').isFloat({ min: 1 })], validate, controller.subscribeToPlan);

router.post('/investments', requirePermission('investments.manage'), [body('user_id').isInt(), body('plan_id').isInt(), body('amount').isFloat({ min: 1 })], validate, controller.investmentCrud.create);
router.get('/investments/:id', requirePermission('investments.view', 'investments.own.view'), controller.investmentCrud.getOne);
router.put('/investments/:id', requirePermission('investments.manage'), controller.investmentCrud.update);
router.delete('/investments/:id', requirePermission('investments.manage'), controller.investmentCrud.remove);
router.get('/investments/:id/transactions', requirePermission('investments.view', 'investments.own.view'), controller.getTransactions);
router.get('/investments/:id/payouts', requirePermission('investments.view', 'investments.own.view'), controller.getPayouts);
router.post('/investments/:id/activate', requirePermission('investments.manage'), controller.activateInvestment);
// Money out. Was reachable by any account with a token.
router.post('/investments/:id/payouts', requirePermission('investments.manage'), controller.createPayout);
router.post('/investments/:id/payout', requirePermission('investments.manage'), controller.createPayout);

// Cash-out workflow
// Asking is the investor's; granting is not.
router.post('/investments/:id/request-cashout', requirePermission('investments.view', 'investments.own.view'), controller.requestCashOut);
router.post('/investments/:id/approve-cashout', requirePermission('investments.manage'), controller.approveCashOut);
router.post('/investments/:id/reject-cashout', requirePermission('investments.manage'), controller.rejectCashOut);

module.exports = router;

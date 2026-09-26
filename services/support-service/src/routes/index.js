const router = require('express').Router();
const { body } = require('express-validator');
const { verifyToken, requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validation');
const c = require('../controllers/supportController');

router.use(verifyToken);

// ── In-app assistant ────────────────────────────────────────────────────────
// Signed-in users only. Every tool the assistant runs reuses the caller's own
// token, so it can never read past what they could already open themselves.
const assistant = require('../controllers/assistantController');
// The assistant answers about your own records; every handler filters on
// user_id = req.user.id, so there is no wider form of these to guard.
router.get('/assistant/status', assistant.status);
// Answers about the caller's own records; the handler filters on req.user.id.
router.post('/assistant/chat', assistant.chat);
router.get('/assistant/conversations', assistant.listConversations);
router.get('/assistant/conversations/:id', assistant.getConversation);
router.delete('/assistant/conversations/:id', assistant.deleteConversation);
/*
 * support.view is held by everyone who can open Support Centre, clients
 * included — so the permission alone would not have separated a customer's
 * ticket from the company's queue. ticketScope does that; this stops an
 * account with no support permission at all.
 */
router.get('/support', requirePermission('support.view'), c.supportCrud.list);
/*
 * Raising a ticket is what support.view is for — a client holds it. What
 * separates a customer's ticket from the company's queue is ticketScope, not
 * this.
 */
// user_id is optional: a customer raising their own ticket is the user, and the
// controller pins it to the caller anyway. Only staff filing on someone's
// behalf send it. See ticketOwnerId.
router.post('/support', requirePermission('support.view'), [body('subject').notEmpty(), body('description').notEmpty(), body('user_id').optional({ nullable: true }).isInt()], validate, c.supportCrud.create);
router.get('/support/:id', requirePermission('support.view'), c.supportCrud.getOne);
// Editing and closing somebody's ticket is the queue's job.
router.put('/support/:id', requirePermission('support.manage'), c.supportCrud.update);
router.delete('/support/:id', requirePermission('support.manage'), c.supportCrud.remove);
router.get('/support/:id/replies', requirePermission('support.view'), c.getReplies);
// A customer replies to their OWN ticket; ticketScope is what allows only that.
// The author is taken from the token, so user_id is not asked for.
router.post('/support/:id/replies', requirePermission('support.view'), [body('message').notEmpty()], validate, c.addReply);
router.put('/support/:id/status', requirePermission('support.manage'), [body('status').notEmpty()], validate, c.updateStatus);

router.get('/visitors', requirePermission('frontdesk.visitors.manage'), c.visitorCrud.list);
router.post('/visitors', requirePermission('frontdesk.visitors.manage'), [body('full_name').notEmpty(), body('phone').notEmpty(), body('purpose').notEmpty(), body('host_name').notEmpty()], validate, c.visitorCrud.create);
router.put('/visitors/:id/checkout', requirePermission('frontdesk.visitors.manage'), c.checkoutVisitor);

router.get('/attendance', requirePermission('frontdesk.attendance.manage'), c.attendanceCrud.list);
router.post('/attendance', requirePermission('frontdesk.attendance.manage'), [body('employee_name').notEmpty(), body('date').notEmpty()], validate, c.attendanceCrud.create);

// Who the company's highest-value clients are — its own permission for a reason.
router.get('/care/vip', requirePermission('care.vip.view'), c.vipCrud.list);
router.post('/care/vip', requirePermission('care.manage'), [body('client_name').notEmpty(), body('total_amount').optional().isNumeric()], validate, c.vipCrud.create);
router.put('/care/vip/:id', requirePermission('care.manage'), [body('client_name').notEmpty(), body('total_amount').optional().isNumeric()], validate, c.vipCrud.update);

router.get('/care/communications', requirePermission('care.view'), c.communicationCrud.list);
router.post('/care/communications', requirePermission('care.manage'), [body('client_name').notEmpty(), body('message').notEmpty()], validate, c.communicationCrud.create);

router.get('/care/alerts', requirePermission('care.view'), c.alertCrud.list);
router.post('/care/alerts', requirePermission('care.manage'), [body('client_name').notEmpty(), body('alert_type').notEmpty(), body('trigger_date').notEmpty(), body('message').notEmpty()], validate, c.alertCrud.create);

module.exports = router;

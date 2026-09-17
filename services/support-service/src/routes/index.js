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
router.post('/support', [body('subject').notEmpty(), body('description').notEmpty(), body('user_id').isInt()], validate, c.supportCrud.create);
router.get('/support/:id', requirePermission('support.view'), c.supportCrud.getOne);
router.put('/support/:id', c.supportCrud.update);
router.delete('/support/:id', c.supportCrud.remove);
router.get('/support/:id/replies', requirePermission('support.view'), c.getReplies);
router.post('/support/:id/replies', [body('user_id').isInt(), body('message').notEmpty()], validate, c.addReply);
router.put('/support/:id/status', [body('status').notEmpty()], validate, c.updateStatus);

router.get('/visitors', requirePermission('frontdesk.visitors.manage'), c.visitorCrud.list);
router.post('/visitors', [body('full_name').notEmpty(), body('phone').notEmpty(), body('purpose').notEmpty(), body('host_name').notEmpty()], validate, c.visitorCrud.create);
router.put('/visitors/:id/checkout', c.checkoutVisitor);

router.get('/attendance', requirePermission('frontdesk.attendance.manage'), c.attendanceCrud.list);
router.post('/attendance', [body('employee_name').notEmpty(), body('date').notEmpty()], validate, c.attendanceCrud.create);

// Who the company's highest-value clients are — its own permission for a reason.
router.get('/care/vip', requirePermission('care.vip.view'), c.vipCrud.list);
router.post('/care/vip', [body('client_name').notEmpty(), body('total_amount').optional().isNumeric()], validate, c.vipCrud.create);
router.put('/care/vip/:id', [body('client_name').notEmpty(), body('total_amount').optional().isNumeric()], validate, c.vipCrud.update);

router.get('/care/communications', requirePermission('care.view'), c.communicationCrud.list);
router.post('/care/communications', [body('client_name').notEmpty(), body('message').notEmpty()], validate, c.communicationCrud.create);

router.get('/care/alerts', requirePermission('care.view'), c.alertCrud.list);
router.post('/care/alerts', [body('client_name').notEmpty(), body('alert_type').notEmpty(), body('trigger_date').notEmpty(), body('message').notEmpty()], validate, c.alertCrud.create);

module.exports = router;

const router = require('express').Router();
const { body } = require('express-validator');
const { verifyToken } = require('../middleware/auth');
const { validate } = require('../middleware/validation');
const c = require('../controllers/supportController');

router.use(verifyToken);

// ── In-app assistant ────────────────────────────────────────────────────────
// Signed-in users only. Every tool the assistant runs reuses the caller's own
// token, so it can never read past what they could already open themselves.
const assistant = require('../controllers/assistantController');
router.get('/assistant/status', assistant.status);
router.post('/assistant/chat', assistant.chat);
router.get('/assistant/conversations', assistant.listConversations);
router.get('/assistant/conversations/:id', assistant.getConversation);
router.delete('/assistant/conversations/:id', assistant.deleteConversation);
router.get('/support', c.supportCrud.list);
router.post('/support', [body('subject').notEmpty(), body('description').notEmpty(), body('user_id').isInt()], validate, c.supportCrud.create);
router.get('/support/:id', c.supportCrud.getOne);
router.put('/support/:id', c.supportCrud.update);
router.delete('/support/:id', c.supportCrud.remove);
router.get('/support/:id/replies', c.getReplies);
router.post('/support/:id/replies', [body('user_id').isInt(), body('message').notEmpty()], validate, c.addReply);
router.put('/support/:id/status', [body('status').notEmpty()], validate, c.updateStatus);

router.get('/visitors', c.visitorCrud.list);
router.post('/visitors', [body('full_name').notEmpty(), body('phone').notEmpty(), body('purpose').notEmpty(), body('host_name').notEmpty()], validate, c.visitorCrud.create);
router.put('/visitors/:id/checkout', c.checkoutVisitor);

router.get('/attendance', c.attendanceCrud.list);
router.post('/attendance', [body('employee_name').notEmpty(), body('date').notEmpty()], validate, c.attendanceCrud.create);

router.get('/care/vip', c.vipCrud.list);
router.post('/care/vip', [body('client_name').notEmpty(), body('total_amount').optional().isNumeric()], validate, c.vipCrud.create);
router.put('/care/vip/:id', [body('client_name').notEmpty(), body('total_amount').optional().isNumeric()], validate, c.vipCrud.update);

router.get('/care/communications', c.communicationCrud.list);
router.post('/care/communications', [body('client_name').notEmpty(), body('message').notEmpty()], validate, c.communicationCrud.create);

router.get('/care/alerts', c.alertCrud.list);
router.post('/care/alerts', [body('client_name').notEmpty(), body('alert_type').notEmpty(), body('trigger_date').notEmpty(), body('message').notEmpty()], validate, c.alertCrud.create);

module.exports = router;

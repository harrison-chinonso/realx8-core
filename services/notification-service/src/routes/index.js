const router = require('express').Router();
const { body } = require('express-validator');
const { verifyToken, requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validation');
const c = require('../controllers/notificationController');
const configs = require('../controllers/notificationConfigController');

router.use(verifyToken);

// Configuring purchase notifications is permission-gated, so it can be
// delegated to a custom role rather than being fixed to the admin types.
const canConfigure = requirePermission('finance.purchase-notifications.manage');
router.get('/notifications/sent', c.listSent);
router.get('/notifications', c.listNotifications);
router.put('/notifications/read-all', c.markAllRead);
router.put('/notifications/:id/read', c.markRead);
router.post('/notifications/send', [body('user_id').isInt(), body('title').notEmpty(), body('body').notEmpty(), body('type').notEmpty()], validate, c.sendNotification);
router.post('/notifications/send-bulk', [body('user_ids').isArray(), body('title').notEmpty(), body('body').notEmpty(), body('type').notEmpty()], validate, c.sendBulk);
router.post('/notifications/email', [body('to').isEmail(), body('subject').notEmpty(), body('body').notEmpty()], validate, c.sendEmail);

/**
 * Notification configuration (FRD 12.1). Admin-only — FRD 13 puts configuring
 * notifications in the company admin column alone.
 */
router.get('/notification-configs', canConfigure, configs.getNotificationConfig);
router.put('/notification-configs', canConfigure, configs.saveNotificationConfig);
router.delete('/notification-configs', canConfigure, configs.resetNotificationConfig);

router.get('/notification-templates', c.templateCrud.list);
router.post('/notification-templates', [body('name').notEmpty(), body('body').notEmpty(), body('type').notEmpty()], validate, c.templateCrud.create);
router.get('/notification-templates/:id', c.templateCrud.getOne);
router.put('/notification-templates/:id', c.templateCrud.update);
router.delete('/notification-templates/:id', c.templateCrud.remove);

module.exports = router;

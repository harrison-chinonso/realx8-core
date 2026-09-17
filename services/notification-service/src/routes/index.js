const router = require('express').Router();
const { body } = require('express-validator');
const { verifyToken, requirePermission } = require('../middleware/auth');
const push = require('../controllers/pushController');
const { validate } = require('../middleware/validation');
const c = require('../controllers/notificationController');
const configs = require('../controllers/notificationConfigController');

router.use(verifyToken);

// Configuring purchase notifications is permission-gated, so it can be
// delegated to a custom role rather than being fixed to the admin types.
const canConfigure = requirePermission('finance.purchase-notifications.manage');
/**
 * ── Browser push ────────────────────────────────────────────────────────────
 *
 * Behind verifyToken like everything else here, and deliberately NOT behind a
 * permission: subscribing your own browser to your own notifications is not a
 * privilege somebody grants, it is a preference.
 */
// The VAPID public key. Public by definition — it is handed to every browser
// that subscribes, and it identifies the server rather than any user.
router.get('/notifications/push/public-key', push.publicKey);
router.get('/notifications/push/subscriptions', requirePermission('notifications.view'), push.listMine);
// Registering THIS browser for push. Own by construction — the handler
// stores req.user.id against the endpoint.
router.post('/notifications/push/subscribe', requirePermission('notifications.view'), push.subscribe);
router.post('/notifications/push/unsubscribe', requirePermission('notifications.view'), push.unsubscribe);
/* Push is the one channel whose "is it working" cannot be answered on screen. */
router.post('/notifications/push/test', requirePermission('notifications.view'), push.sendTest);

// What YOU sent (sent_by = req.user.id), so it takes the sending permission.
router.get('/notifications/sent', requirePermission('notifications.send'), c.listSent);
router.get('/notifications', requirePermission('notifications.view'), c.listNotifications);
router.put('/notifications/read-all', requirePermission('notifications.view'), c.markAllRead);
router.put('/notifications/:id/read', requirePermission('notifications.view'), c.markRead);
// Sending to somebody else is a different permission from reading your own.
router.post('/notifications/send', requirePermission('notifications.send'), [body('user_id').isInt(), body('title').notEmpty(), body('body').notEmpty(), body('type').notEmpty()], validate, c.sendNotification);
router.post('/notifications/send-bulk', requirePermission('notifications.send'), [body('user_ids').isArray(), body('title').notEmpty(), body('body').notEmpty(), body('type').notEmpty()], validate, c.sendBulk);
router.post('/notifications/email', requirePermission('notifications.send'), [body('to').isEmail(), body('subject').notEmpty(), body('body').notEmpty()], validate, c.sendEmail);

/**
 * Notification configuration (FRD 12.1). Admin-only — FRD 13 puts configuring
 * notifications in the company admin column alone.
 */
router.get('/notification-configs', canConfigure, configs.getNotificationConfig);
router.put('/notification-configs', canConfigure, configs.saveNotificationConfig);
router.delete('/notification-configs', canConfigure, configs.resetNotificationConfig);
// Who would actually be notified for one event as configured — the answer to
// "I selected these permissions, who is that?".
router.get('/notification-configs/:eventKey/recipients', canConfigure, configs.previewRecipients);

// Templates are configuration, like the configs above them.
router.get('/notification-templates', canConfigure, c.templateCrud.list);
router.post('/notification-templates', canConfigure, [body('name').notEmpty(), body('body').notEmpty(), body('type').notEmpty()], validate, c.templateCrud.create);
router.get('/notification-templates/:id', canConfigure, c.templateCrud.getOne);
router.put('/notification-templates/:id', canConfigure, c.templateCrud.update);
router.delete('/notification-templates/:id', canConfigure, c.templateCrud.remove);

module.exports = router;

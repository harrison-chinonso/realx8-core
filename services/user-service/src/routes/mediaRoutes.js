const router = require('express').Router();
const { body } = require('express-validator');
const controller = require('../controllers/mediaController');
const socialController = require('../controllers/socialController');
const { verifyToken, requireRoles, requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validation');

router.use(verifyToken);

router.post('/media/upload', controller.uploadMediaFiles);
router.get('/media/posts', requirePermission('media.view'), controller.listPosts);
router.post('/media/posts', [body('title').notEmpty()], validate, controller.createPost);
router.put('/media/posts/:id', [body('title').optional().notEmpty()], validate, controller.updatePost);
router.delete('/media/posts/:id', controller.removePost);
router.post('/media/posts/:id/submit', controller.submitPost);
router.post('/media/posts/:id/approve', requireRoles('super_admin', 'admin', 'product_manager'), controller.approvePost);
router.post('/media/posts/:id/reject', requireRoles('super_admin', 'admin', 'product_manager'), controller.rejectPost);
router.post('/media/posts/:id/publish', requireRoles('super_admin', 'admin', 'product_manager'), controller.publishPost);

// Matches the permission navConfig gates the Blog screen on.
router.get('/media/blog', requirePermission('media.blog.manage', 'media.view'), controller.listBlog);
router.post('/media/blog', [body('title').notEmpty()], validate, controller.createBlog);
router.put('/media/blog/:id', [body('title').optional().notEmpty()], validate, controller.updateBlog);
router.delete('/media/blog/:id', controller.removeBlog);

// Connected accounts and their status — the Social Media Accounts screen.
router.get('/social-accounts', requirePermission('media.schedule'), socialController.listAccounts);
router.put('/social-accounts/:platform', socialController.upsertAccount);
router.delete('/social-accounts/:platform', socialController.disconnectAccount);
router.post('/social-accounts/:platform/test', socialController.testConnection);

// Manual trigger: force an immediate impressions sync (admin only)
router.post(
  '/media/sync-impressions',
  requireRoles('super_admin', 'admin', 'superior_admin'),
  async (req, res) => {
    try {
      const { syncImpressions } = require('../utils/impressionsSyncJob');
      await syncImpressions();
      res.json({ message: 'Impressions sync completed successfully.' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },
);

module.exports = router;

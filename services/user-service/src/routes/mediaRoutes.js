const router = require('express').Router();
const { body } = require('express-validator');
const controller = require('../controllers/mediaController');
const socialController = require('../controllers/socialController');
const { verifyToken, requireRoles, requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validation');

router.use(verifyToken);

router.post('/media/upload', requirePermission('media.create'), controller.uploadMediaFiles);
router.get('/media/posts', requirePermission('media.view'), controller.listPosts);
router.post('/media/posts', requirePermission('media.create'), [body('title').notEmpty()], validate, controller.createPost);
router.put('/media/posts/:id', requirePermission('media.create'), [body('title').optional().notEmpty()], validate, controller.updatePost);
router.delete('/media/posts/:id', requirePermission('media.create'), controller.removePost);
// Submitting for approval is the author's move; approve/reject/publish above
// already require a role.
router.post('/media/posts/:id/submit', requirePermission('media.create'), controller.submitPost);
router.post('/media/posts/:id/approve', requireRoles('super_admin', 'admin', 'product_manager'), controller.approvePost);
router.post('/media/posts/:id/reject', requireRoles('super_admin', 'admin', 'product_manager'), controller.rejectPost);
router.post('/media/posts/:id/publish', requireRoles('super_admin', 'admin', 'product_manager'), controller.publishPost);

// Matches the permission navConfig gates the Blog screen on.
router.get('/media/blog', requirePermission('media.blog.manage', 'media.view'), controller.listBlog);
router.post('/media/blog', requirePermission('media.blog.manage'), [body('title').notEmpty()], validate, controller.createBlog);
router.put('/media/blog/:id', requirePermission('media.blog.manage'), [body('title').optional().notEmpty()], validate, controller.updateBlog);
router.delete('/media/blog/:id', requirePermission('media.blog.manage'), controller.removeBlog);

// Connected accounts and their status — the Social Media Accounts screen.
router.get('/social-accounts', requirePermission('media.schedule'), socialController.listAccounts);
// Connecting an account posts to the company's public presence.
router.put('/social-accounts/:platform', requirePermission('media.schedule'), socialController.upsertAccount);
router.delete('/social-accounts/:platform', requirePermission('media.schedule'), socialController.disconnectAccount);
router.post('/social-accounts/:platform/test', requirePermission('media.schedule'), socialController.testConnection);

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

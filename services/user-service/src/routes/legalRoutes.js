const router = require('express').Router();
const { verifyToken } = require('../middleware/auth');
const legal = require('../controllers/legalController');

/**
 * The Terms of Use and Privacy Policy (controllers/legalController.js).
 *
 * Reading the current version is public — it has to be readable before
 * anyone has an account. Agreeing needs a session. Editing, publishing and
 * the register of who agreed are for platform administrators only.
 */
router.get('/legal/terms', legal.getPublicTerms);

router.get('/legal/terms/status', verifyToken, legal.getMyStatus);
router.post('/legal/terms/accept', verifyToken, legal.acceptMine);

router.get('/legal/admin/document', verifyToken, legal.requireSuperiorAdmin, legal.adminGetDocument);
router.put('/legal/admin/draft', verifyToken, legal.requireSuperiorAdmin, legal.adminSaveDraft);
router.post('/legal/admin/publish', verifyToken, legal.requireSuperiorAdmin, legal.adminPublish);
router.get('/legal/admin/versions/:id', verifyToken, legal.requireSuperiorAdmin, legal.adminGetVersion);
router.get('/legal/admin/acceptances', verifyToken, legal.requireSuperiorAdmin, legal.adminListAcceptances);
router.get('/legal/admin/acceptances/export', verifyToken, legal.requireSuperiorAdmin, legal.adminExportAcceptances);

module.exports = router;

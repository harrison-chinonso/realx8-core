// Unauthenticated routes. Mounted BEFORE the token-guarded router in index.js,
// so nothing here may leak company-scoped or financial data.
const router = require('express').Router();
const controller = require('../controllers/propertyController');

router.get('/public/properties/:token', controller.getPublicProperty);



/**
 * What a buyer would pay for a unit right now, campaigns included.
 *
 * Deliberately here rather than behind a permission: a promotional price that
 * only staff can see is not a promotion. The endpoint reads the unit's own
 * price and the company's live campaigns; nothing about it depends on who is
 * asking except their own eligibility.
 */
const promotionController = require('../controllers/promotionController');
router.get('/units/:unitId/price', promotionController.quoteForUnit);

module.exports = router;

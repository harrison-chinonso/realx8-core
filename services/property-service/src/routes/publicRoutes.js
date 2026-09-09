// Unauthenticated routes. Mounted BEFORE the token-guarded router in index.js,
// so nothing here may leak company-scoped or financial data.
const router = require('express').Router();
const controller = require('../controllers/propertyController');

router.get('/public/properties/:token', controller.getPublicProperty);

module.exports = router;

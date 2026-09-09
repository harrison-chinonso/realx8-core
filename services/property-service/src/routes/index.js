const router = require('express').Router();

// Public (no auth) first — propertyRoutes applies verifyToken to everything it owns.
router.use(require('./publicRoutes'));
router.use(require('./propertyRoutes'));

module.exports = router;

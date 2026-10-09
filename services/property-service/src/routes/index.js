const router = require('express').Router();

// Public (no auth) first — propertyRoutes applies verifyToken to everything it owns.
router.use(require('./publicRoutes'));
// Mounted before propertyRoutes, whose router-wide guard would otherwise apply its own rules first.
router.use(require('./websiteRequestRoutes'));
router.use(require('./propertyRoutes'));

module.exports = router;

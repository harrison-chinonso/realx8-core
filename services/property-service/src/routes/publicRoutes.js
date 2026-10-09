// Unauthenticated routes. Mounted BEFORE the token-guarded router in index.js,
// so nothing here may leak company-scoped or financial data.
const router = require('express').Router();
const controller = require('../controllers/propertyController');

router.get('/public/properties/:token', controller.getPublicProperty);
// A company's sign-in page: a few of its publicly shared listings and offers.
router.get('/public/companies/:code/showcase', controller.getCompanyShowcase);

/**
 * Realx8-Mobile's boot config for a company code.
 *
 * Throttled on its own, tighter than the edge's per-IP default: the key is a
 * five-character code, and a phone needs one call per launch. 30 a minute
 * leaves room for a shared office NAT and none for walking the code space.
 */
const rateLimit = require('express-rate-limit');
const appConfigLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Try again in a minute.' },
});
router.get('/public/app-config/:code', appConfigLimiter, require('../controllers/appConfigController').getAppConfig);

/**
 * The public website's onboarding form and its assistant (realx8.net).
 *
 * Throttled hard per address — a person sends one or two of these, a script
 * sends thousands — on top of the hidden spam-trap field the controller checks.
 */
const websiteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests from your network. Please try again in a few minutes.' },
});
router.post('/public/website/requests', websiteLimiter, require('../controllers/websiteRequestController').submit);

// The universal-link / App Link files, forwarded from the web host's /.well-known/ (appLinks.js).
const appLinks = require('../controllers/appLinksController');
router.get('/public/app-links/apple-app-site-association', appLinks.appleAssociation);
router.get('/public/app-links/assetlinks.json', appLinks.assetLinks);



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

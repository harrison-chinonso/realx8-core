const router = require('express').Router();
const c = require('../controllers/dashboardController');
const referrals = require('../controllers/referralController');
const { requirePermission } = require('../middleware/auth');

// Branches on the caller's own profile and id — there is no wider form.
router.get('/dashboard/summary', c.getSummary);
// Literal path first — /dashboard/summary/:id must not be shadowed.
router.get('/dashboard/summary/:id', c.getUserSummary);
router.get('/dashboard/referrals', referrals.listMyReferrals);
router.get('/dashboard/my-clients', referrals.listMyClients);
// Literal path before any /:id route on this prefix.
router.get('/dashboard/referrals/:id/earnings', referrals.getReferralEarnings);
// Admin view of one realtor's upline and downline.
/*
 * Somebody ELSE's downline, so it takes a staff permission. The four routes
 * above resolve access per row instead — /dashboard/summary branches on the
 * caller's own id, and the two :id routes go through resolveViewableUser,
 * which allows your own records, a staff member their company's and a realtor
 * their downline's. No single permission name expresses that, and a route
 * guard would only restate it more loosely.
 */
router.get('/realtors/:id/referrals', requirePermission('users.view'), referrals.getRealtorReferrals);

module.exports = router;

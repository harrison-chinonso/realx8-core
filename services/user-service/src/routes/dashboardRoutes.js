const router = require('express').Router();
const c = require('../controllers/dashboardController');
const referrals = require('../controllers/referralController');

router.get('/dashboard/summary', c.getSummary);
// Literal path first — /dashboard/summary/:id must not be shadowed.
router.get('/dashboard/summary/:id', c.getUserSummary);
router.get('/dashboard/referrals', referrals.listMyReferrals);
router.get('/dashboard/my-clients', referrals.listMyClients);
// Literal path before any /:id route on this prefix.
router.get('/dashboard/referrals/:id/earnings', referrals.getReferralEarnings);
// Admin view of one realtor's upline and downline.
router.get('/realtors/:id/referrals', referrals.getRealtorReferrals);

module.exports = router;

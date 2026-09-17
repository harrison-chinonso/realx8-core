const router = require('express').Router();
const c = require('../controllers/realtorKycController');

// Literal paths before /:id.
// Your own submission.
router.get('/realtor-kyc/me', c.getMyKyc);
router.post('/realtor-kyc', c.submitKyc);
// listKyc refuses anyone who is not a company reviewer, in the handler.
router.get('/realtor-kyc', c.listKyc);
router.post('/realtor-kyc/:id/approve', c.approveKyc);
router.post('/realtor-kyc/:id/reject', c.rejectKyc);

module.exports = router;

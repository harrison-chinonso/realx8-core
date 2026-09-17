const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../middleware/validation');
const c = require('../controllers/realtorLevelController');

// Requests before /:id so the literal path is not captured as a level id.
router.get('/realtor-levels/requests', c.listRequests);
router.post('/realtor-levels/requests', [body('level_id').isInt()], validate, c.createRequest);
router.post('/realtor-levels/requests/:id/approve', c.approveRequest);
router.post('/realtor-levels/requests/:id/reject', c.rejectRequest);

router.get('/realtor-levels', c.listLevels);
/**
 * ONE way to write the ladder, and it writes all of it.
 *
 * This replaced create / update / delete / reorder as four separate calls.
 * Every real change to a ladder touches more than one rung — adding renumbers,
 * removing rehouses the realtors standing there, reordering is several at once
 * by definition — so four calls turned one intention into four things that
 * could each half-happen. It is also the only place that can copy the platform
 * ladder into a company, which has to be atomic with the edit that triggered
 * it.
 */
router.put('/realtor-levels', [body('levels').isArray({ min: 1 })], validate, c.saveLadder);

// Assigning a realtor to a level.
router.put('/realtors/:userId/level', c.assignLevel);

module.exports = router;

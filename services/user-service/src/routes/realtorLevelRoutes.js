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
router.post('/realtor-levels', [body('name').notEmpty()], validate, c.createLevel);
router.put('/realtor-levels/reorder', [body('ids').isArray({ min: 1 })], validate, c.reorderLevels);
router.put('/realtor-levels/:id', c.updateLevel);
router.delete('/realtor-levels/:id', c.deleteLevel);

// Assigning a realtor to a level.
router.put('/realtors/:userId/level', c.assignLevel);

module.exports = router;

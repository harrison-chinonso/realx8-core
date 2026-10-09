const router = require('express').Router();
const { verifyToken } = require('../middleware/auth');
const website = require('../controllers/websiteRequestController');

// Requests from the public website, for platform administrators to follow up.
router.get('/website-requests', verifyToken, website.requireSuperiorAdmin, website.list);
router.patch('/website-requests/:id', verifyToken, website.requireSuperiorAdmin, website.update);

module.exports = router;

const router = require('express').Router();
const { verifyToken } = require('../middleware/auth');
const companyRoutes = require('./companyRoutes');

router.use('/', require('./userRoutes'));
router.use('/', require('./mediaRoutes'));
router.use('/', verifyToken, require('./realtorLevelRoutes'));
router.use('/', verifyToken, require('./dashboardRoutes'));
router.use('/', verifyToken, require('./realtorKycRoutes'));
router.use('/', verifyToken, require('./auditRoutes'));
router.use('/companies', verifyToken, companyRoutes);
router.use('/platform', verifyToken, companyRoutes);
router.use('/my-company', verifyToken, companyRoutes);

module.exports = router;

const router = require('express').Router();
const { body } = require('express-validator');
const controller = require('../controllers/companyController');
const { validate } = require('../middleware/validation');

const requireSuperiorAdmin = (req, res, next) => {
  if (controller.isSuperiorAdmin(req)) return next();
  return res.status(403).json({ message: 'Platform admin access required' });
};

const companyValidators = [
  body('name').notEmpty().withMessage('Company name is required'),
  body('email').isEmail().withMessage('A valid company email is required'),
  body('admin_email').isEmail().withMessage('A valid admin email is required'),
  body('admin_first_name').notEmpty().withMessage('Admin first name is required'),
  body('admin_last_name').notEmpty().withMessage('Admin last name is required'),
];

router.get('/overview', requireSuperiorAdmin, controller.getPlatformOverview);
router.get('/check-code', requireSuperiorAdmin, controller.checkReferralCode);
router.get('/:id/users', requireSuperiorAdmin, controller.listCompanyUsers);
router.get('/:id/stats', requireSuperiorAdmin, controller.getCompanyStats);
router.get('/:id', requireSuperiorAdmin, controller.getCompany);
router.post('/', requireSuperiorAdmin, companyValidators, validate, controller.createCompany);
router.put('/:id', requireSuperiorAdmin, controller.updateCompany);
router.delete('/:id', requireSuperiorAdmin, controller.deleteCompany);
router.get('/', (req, res, next) => {
  if (req.baseUrl.endsWith('/my-company')) return controller.getMyCompany(req, res, next);
  if (req.baseUrl.endsWith('/companies')) return requireSuperiorAdmin(req, res, () => controller.listCompanies(req, res, next));
  return next();
});

module.exports = router;

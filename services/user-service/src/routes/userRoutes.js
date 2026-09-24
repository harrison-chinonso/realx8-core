const router = require('express').Router();
const { body } = require('express-validator');
const controller = require('../controllers/userController');
const realtorHubController = require('../controllers/realtorHubController');
const shareLinkController = require('../controllers/shareLinkController');
const {
  verifyToken, requireRoles, requirePermission, permissionOrSelf, optionalAuth,
} = require('../middleware/auth');
const { validate } = require('../middleware/validation');
const multer = require('multer');
const { MIN_PASSWORD_LENGTH, PASSWORD_MESSAGE } = require('../../../../shared/src/passwordPolicy');
const { USER_TYPES } = require('../../../../shared/src/userTypes');

// Logo upload uses memory storage — buffer goes to Cloudinary
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    cb(null, ['image/jpeg','image/png','image/gif','image/webp'].includes(file.mimetype));
  },
});

/*
 * `type` is checked against the vocabulary rather than left to the column.
 *
 * Without it the enum refuses the write and the caller is told "Data truncated
 * for column 'type' at row 1" — a message about a column they did not name,
 * from a form that only asked them to pick a role. See shared/src/userTypes.js
 * for why a role is not a type.
 */
const userValidators = [
  body('name').notEmpty(),
  body('email').isEmail(),
  body('password').isLength({ min: MIN_PASSWORD_LENGTH }).withMessage(PASSWORD_MESSAGE),
  body('type').optional().isIn(USER_TYPES).withMessage(`Account type must be one of: ${USER_TYPES.join(', ')}`),
  body('role').optional().isString(),
  body('roles').optional().isArray(),
  body('realtor_id').optional({ nullable: true }).isInt().withMessage('Pick a realtor from the list'),
];

const roleValidators = [
  body('name').notEmpty(),
  body('display_name').optional().isString(),
  body('description').optional().isString(),
];

const permissionValidators = [
  body('name').notEmpty(),
  body('display_name').optional().isString(),
  body('module').optional().isString(),
  body('description').optional().isString(),
];

// Public — no auth needed so the frontend can load theme before login.
// optionalAuth populates req.user when a valid token IS present so logged-in users
// get their company-specific appearance instead of global defaults.
// Branding only — safe for any visitor, and needed before sign-in.
router.get('/settings/appearance', optionalAuth, controller.getAppearance);
router.get('/settings/platform-name', controller.getPlatformName);  // public — no auth
/*
 * Public because RegisterPage offers a role on the sign-up form and has no
 * token yet. It returns names and descriptions of a company's roles — no
 * permissions, no members — which is the least that form can work with.
 * /roles/:id and /permissions below are NOT public, and that is the line:
 * which roles exist is a menu, what each one can do is configuration.
 */
router.get('/roles', controller.listRoles);

// Public on purpose: a prospect opening a shared link has no account yet, and
// the page has to be branded before anything else renders. Returns branding
// only — the token grants no access.
router.get('/share/brand/:token', shareLinkController.resolveShareToken);

router.use(verifyToken);

// Minting is identity-driven: the caller's own company, and their own realtor
// code if they are a realtor. Nothing is taken from the request body.
router.post('/share/token', shareLinkController.createShareToken);

// User routes
router.get('/users/employees', requireRoles('super_admin', 'admin'), controller.listEmployees);
router.get('/users/clients', requireRoles('super_admin', 'admin'), controller.listClients);
router.get('/users/realtors', requireRoles('super_admin', 'admin'), controller.listRealtors);
router.get('/users', requireRoles('super_admin', 'admin'), controller.list);
router.post('/users', requireRoles('super_admin', 'admin'), userValidators, validate, controller.create);
/*
 * findScopedUserById scopes by COMPANY and nothing else, so without a guard any
 * account with a token could walk /users/1, /users/2 and read every colleague's
 * and every customer's name, email and phone. Its siblings above already
 * required staff; this one was missed.
 */
/*
 * Your own record, or the permission to read somebody else's.
 *
 * users.view alone made the profile page staff-only by accident: no client or
 * realtor holds it, so the page could not load the form describing them.
 * permissionOrSelf compares the id in the route to the id in the token, which
 * permits exactly one extra row — theirs. See shared/src/middleware/auth.js
 * for why permissionOrSelfScoped would have been the wrong tool here.
 */
router.get('/users/:id', permissionOrSelf('users.view'), controller.getOne);
/*
 * Same rule for writing, and the handler decides WHAT may be written: reaching
 * your own record is not permission to set `type` on it. See updateUser.
 */
router.put('/users/:id', permissionOrSelf('users.manage'), [body('email').optional().isEmail(), body('type').optional().isIn(USER_TYPES).withMessage(`Account type must be one of: ${USER_TYPES.join(', ')}`), body('role').optional().isString(), body('roles').optional().isArray()], validate, controller.update);
router.delete('/users/:id', requireRoles('super_admin', 'admin'), controller.remove);
router.get('/users/:id/roles', requireRoles('super_admin', 'admin'), controller.getUserRoles);
router.put('/users/:id/roles', requireRoles('super_admin', 'admin'), [body('roles').isArray()], validate, controller.syncUserRoles);
// Who somebody IS in this system. The highest-leverage write in the service.
router.post('/users/:id/assign-role', requirePermission('roles.manage'), [body('role_id').optional().isInt(), body('name').optional().isString(), body('roles').optional().isArray()], validate, controller.assignRole);
router.delete('/users/:id/roles/:roleId', requireRoles('super_admin', 'admin'), controller.removeRole);

// Role routes
router.post('/roles', requireRoles('super_admin', 'admin'), roleValidators, validate, controller.createRole);
// What a role can actually do. Configuration, unlike the public list above.
router.get('/roles/:id', requirePermission('roles.view'), controller.getRole);
router.put('/roles/:id', requireRoles('super_admin', 'admin'), [body('name').optional().notEmpty()], validate, controller.updateRole);
router.delete('/roles/:id', requireRoles('super_admin', 'admin'), controller.deleteRole);
router.put('/roles/:id/permissions', requireRoles('super_admin', 'admin'), [body('permissions').isArray()], validate, controller.syncRolePermissions);

// Permission routes
// The full permission catalogue — the vocabulary of the Roles screen.
router.get('/permissions', requirePermission('roles.view'), controller.listPermissions);
router.post('/permissions', requireRoles('super_admin', 'admin'), permissionValidators, validate, controller.createPermission);
router.put('/permissions/:id', requireRoles('super_admin', 'admin'), [body('name').optional().notEmpty()], validate, controller.updatePermission);
router.delete('/permissions/:id', requireRoles('super_admin', 'admin'), controller.deletePermission);

// Realtor hub routes
router.get('/training/modules', requireRoles('super_admin', 'admin', 'branch_manager', 'realtor', 'employee'), realtorHubController.listTrainingModules);
router.post('/training/modules', requireRoles('super_admin', 'admin', 'branch_manager'), [body('title').notEmpty(), body('category').notEmpty(), body('duration').notEmpty()], validate, realtorHubController.createTrainingModule);
router.put('/training/modules/:id', requireRoles('super_admin', 'admin', 'branch_manager'), [body('title').optional().notEmpty(), body('duration').optional().notEmpty()], validate, realtorHubController.updateTrainingModule);
router.delete('/training/modules/:id', requireRoles('super_admin', 'admin', 'branch_manager'), realtorHubController.deleteTrainingModule);
router.post('/training/modules/:id/enroll', requireRoles('super_admin', 'admin', 'branch_manager', 'realtor', 'employee'), realtorHubController.enrollTrainingModule);
router.post('/training/modules/:id/submit', requireRoles('super_admin', 'admin', 'branch_manager', 'realtor', 'employee'), realtorHubController.submitTrainingQuiz);
router.get('/training/progress', requireRoles('super_admin', 'admin', 'branch_manager', 'realtor', 'employee'), realtorHubController.listTrainingProgress);
router.get('/training/modules/:id/certificate', requireRoles('super_admin', 'admin', 'branch_manager', 'realtor', 'employee'), realtorHubController.getTrainingCertificate);

router.get('/leaderboard', requireRoles('super_admin', 'admin', 'branch_manager', 'realtor', 'coo', 'csmo'), realtorHubController.listLeaderboard);
router.get('/leaderboard/stats', requireRoles('super_admin', 'admin', 'branch_manager'), realtorHubController.listLeaderboardStats);
router.post('/leaderboard/stats', requireRoles('super_admin', 'admin', 'branch_manager'), [body('realtor_name').notEmpty(), body('branch').notEmpty()], validate, realtorHubController.saveLeaderboardStat);

router.get('/recruitment/recruits', requireRoles('super_admin', 'admin', 'branch_manager', 'realtor'), realtorHubController.listRecruits);
router.post('/recruitment/recruits', requireRoles('super_admin', 'admin', 'branch_manager', 'realtor'), [body('name').notEmpty(), body('email').isEmail(), body('join_date').notEmpty()], validate, realtorHubController.createRecruit);
router.put('/recruitment/recruits/:id', requireRoles('super_admin', 'admin', 'branch_manager', 'realtor'), [body('email').optional().isEmail()], validate, realtorHubController.updateRecruit);
router.delete('/recruitment/recruits/:id', requireRoles('super_admin', 'admin', 'branch_manager', 'realtor'), realtorHubController.deleteRecruit);

// Settings routes
router.get('/settings', requireRoles('super_admin', 'admin'), controller.getSettings);
router.post('/settings', requireRoles('super_admin', 'admin'), [body('key').notEmpty()], validate, controller.upsertSetting);
router.post('/settings/bulk', requireRoles('super_admin', 'admin'), [body('settings').isArray()], validate, controller.bulkUpdateSettings);
/**
 * A company's own SMS credentials.
 *
 * settings.sms.manage, which is defined AND granted in the same change — the
 * lesson from settings.security.manage, which sat in the catalogue held by
 * nobody until something was gated on it.
 *
 * The send-test route is deliberately separate from the credential check: the
 * check asks the provider's balance endpoint and costs nothing, while this one
 * spends a unit and rings a real phone. Only an actual message proves the
 * sender ID has been approved by the networks.
 */
const smsSettings = require('../controllers/smsSettingsController');
router.get('/settings/sms/providers', requirePermission('settings.sms.manage'), smsSettings.listSmsProviders);
router.get('/settings/sms', requirePermission('settings.sms.manage'), smsSettings.getSmsSettings);
router.put('/settings/sms', requirePermission('settings.sms.manage'), smsSettings.saveSmsSettings);
router.post('/settings/sms/test', requirePermission('settings.sms.manage'), smsSettings.testSmsCredentials);
router.post('/settings/sms/send-test', requirePermission('settings.sms.manage'), [body('to').notEmpty()], validate, smsSettings.sendTestSms);

router.get('/settings/system', requireRoles('super_admin', 'admin'), controller.getSystemConfig);
router.post('/settings/system', requireRoles('super_admin', 'admin'), controller.saveSystemConfig);
router.post('/settings/upload-logo', requireRoles('super_admin', 'admin'), upload.single('logo'), controller.uploadLogo);

module.exports = router;

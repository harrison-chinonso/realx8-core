const passport = require('passport');
const router = require('express').Router();
const { body } = require('express-validator');
const controller = require('../controllers/authController');
const { verifyToken } = require('../middleware/auth');
const { validate } = require('../middleware/validation');

router.post('/register', [
  body('name').notEmpty(),
  body('email').isEmail(),
  body('password').isLength({ min: 6 }),
], validate, controller.register);

router.post('/login', [body('password').notEmpty()], validate, controller.login);
router.post('/2fa/verify', [
  body('temp_token').optional().notEmpty(),
  body('tempToken').optional().notEmpty(),
  body('totp_token').optional().isLength({ min: 6, max: 6 }),
  body('token').optional().isLength({ min: 6, max: 6 }),
], validate, controller.verify2FA);
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
router.get('/google/callback', passport.authenticate('google', {
  failureRedirect: `${process.env.FRONTEND_GOOGLE_CALLBACK_URL || 'http://localhost:5173/auth/google/callback'}?error=google_auth_failed`,
}), controller.googleCallback);
router.post('/refresh', [body('refreshToken').notEmpty()], validate, controller.refresh);
router.post('/logout', [body('refreshToken').notEmpty()], validate, controller.logout);
router.post('/forgot-password', [body('email').isEmail()], validate, controller.forgotPassword);
router.post('/verify-reset-otp', [body('email').isEmail(), body('otp').isLength({ min: 6, max: 6 })], validate, controller.verifyResetOtp);
router.post('/reset-password', [body('reset_token').notEmpty(), body('password').isLength({ min: 6 })], validate, controller.resetPassword);
router.get('/me', verifyToken, controller.me);
router.post('/2fa/setup', verifyToken, controller.setup2FA);
router.post('/2fa/verify-setup', verifyToken, [body('token').isLength({ min: 6, max: 6 })], validate, controller.verify2FASetup);
router.post('/2fa/disable', verifyToken, [body('token').isLength({ min: 6, max: 6 })], validate, controller.disable2FA);
// Forced 2FA setup during login (uses temp_token, no session needed)
router.post('/2fa/forced-setup', controller.forcedSetup2FA);
router.post('/2fa/forced-verify', [
  body('temp_token').notEmpty(),
  body('totp_token').optional().isLength({ min: 6, max: 6 }),
  body('token').optional().isLength({ min: 6, max: 6 }),
], validate, controller.forcedVerify2FA);
// Admin 2FA policy
router.get('/admin/2fa-policy', verifyToken, controller.get2FAPolicyEndpoint);
router.post('/admin/2fa-policy', verifyToken, [body('required').isBoolean()], validate, controller.set2FAPolicy);
router.post('/reload-config', verifyToken, controller.reloadConfig);
router.post('/switch-role', verifyToken, [body('roleId').notEmpty()], validate, controller.switchRole);
router.post('/profiles/enable', verifyToken, [body('profile').notEmpty()], validate, controller.enableProfile);

module.exports = router;

const passport = require('passport');
const { buildSignupState } = require('../../../../shared/src/oauthState');
const router = require('express').Router();
const { body } = require('express-validator');
const controller = require('../controllers/authController');
const passcode = require('../controllers/passcodeController');
const rateLimit = require('express-rate-limit');

/**
 * 10 passcode attempts per IP per 15 minutes.
 *
 * Deliberately tighter than a password endpoint would be: a 6-digit secret has
 * a small enough keyspace that an unthrottled endpoint is the whole
 * vulnerability, and a legitimate user needs one or two attempts.
 */
const passcodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many passcode attempts. Try again later, or sign in with your password.' },
});
const { verifyToken, requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validation');

router.post('/register', [
  body('name').notEmpty(),
  body('email').isEmail(),
  body('password').isLength({ min: 6 }),
], validate, controller.register);

router.post('/login', [body('password').notEmpty()], validate, controller.login);

/**
 * Passcode sign-in.
 *
 * Six digits is a million combinations, so the endpoint is rate-limited per IP
 * on top of the per-account lockout in the controller. The two guard different
 * things: the lockout stops one account being ground down, the rate limit stops
 * one attacker sweeping many accounts.
 */
router.post(
  '/passcode/login',
  passcodeLimiter,
  [body('passcode').isLength({ min: 6, max: 6 }).isNumeric()],
  validate,
  passcode.loginWithPasscode,
);

// Managing your own passcode. Authenticated; setting one also demands the
// current password, checked in the controller.
router.get('/passcode', verifyToken, passcode.getPasscodeStatus);
router.post('/passcode', verifyToken, [
  body('passcode').isLength({ min: 6, max: 6 }).isNumeric(),
  body('password').notEmpty(),
], validate, passcode.setPasscode);
router.delete('/passcode', verifyToken, passcode.removePasscode);
router.post('/2fa/verify', [
  body('temp_token').optional().notEmpty(),
  body('tempToken').optional().notEmpty(),
  body('totp_token').optional().isLength({ min: 6, max: 6 }),
  body('token').optional().isLength({ min: 6, max: 6 }),
], validate, controller.verify2FA);
/**
 * ── Google ──────────────────────────────────────────────────────────────────
 *
 * The company and realtor codes travel in the OAuth `state`, because Google
 * redirects to a callback URL registered in advance and gives back nothing that
 * was added to the outbound request. `state` is the one field that survives —
 * see shared/src/oauthState.js, which signs it so a realtor code cannot be
 * swapped mid-flow to claim somebody else's introduction.
 */
router.get('/google', (req, res, next) => {
  const state = buildSignupState({
    companyCode: req.query.company_code || req.query.company,
    realtorCode: req.query.realtor_code || req.query.ref,
    redirect: req.query.redirect || null,
  });
  return passport.authenticate('google', {
    scope: ['profile', 'email'],
    ...(state ? { state } : {}),
  })(req, res, next);
});

/**
 * The callback, with its own handler rather than `failureRedirect`.
 *
 * failureRedirect sends one fixed URL whatever went wrong, so every cause —
 * Google declined, the company code was missing, the code named a suspended
 * company — arrived as the same "google_auth_failed". That is the error the
 * user could not act on, and it is why a broken sign-up looked like a broken
 * Google integration.
 *
 * `info.reason` comes from the strategy and names the actual cause, so the
 * sign-in page can say what to do about it.
 */
router.get('/google/callback', (req, res, next) => {
  passport.authenticate('google', { session: false }, (error, user, info) => {
    const frontend = process.env.FRONTEND_GOOGLE_CALLBACK_URL
      || 'http://localhost:5173/auth/google/callback';

    if (error) {
      console.error('[auth] Google callback failed:', error.message);
      return res.redirect(`${frontend}?error=google_auth_failed`);
    }

    if (!user) {
      /**
       * A refusal the strategy explained. The reason goes in the URL and the
       * sentence with it, so the page does not have to keep its own copy of
       * every message the server might produce.
       */
      const reason = info?.reason || 'google_auth_failed';
      const message = info?.message ? `&message=${encodeURIComponent(info.message)}` : '';
      return res.redirect(`${frontend}?error=${encodeURIComponent(reason)}${message}`);
    }

    req.user = user;
    return controller.googleCallback(req, res, next);
  })(req, res, next);
});
router.post('/refresh', [body('refreshToken').notEmpty()], validate, controller.refresh);
router.post('/logout', [body('refreshToken').notEmpty()], validate, controller.logout);
router.post('/forgot-password', [body('email').isEmail()], validate, controller.forgotPassword);
router.post('/verify-reset-otp', [body('email').isEmail(), body('otp').isLength({ min: 6, max: 6 })], validate, controller.verifyResetOtp);
router.post('/reset-password', [body('reset_token').notEmpty(), body('password').isLength({ min: 6 })], validate, controller.resetPassword);
router.get('/me', verifyToken, controller.me);
// Hands back this session's payload-encryption key after a page reload, which
// drops it (it is held in memory only, never in storage).
router.get('/session-key', verifyToken, controller.sessionKey);
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
/**
 * Admin 2FA policy.
 *
 * Both endpoints enforced `['super_admin', 'superior_admin']` inside their
 * handlers, because settings.security.manage existed in the catalogue and was
 * granted to nobody — gating on it would have locked out every account. It is
 * granted now (see grantSecuritySettings), so the check moves to where the
 * rest of the application keeps this decision, and a company can delegate it
 * to a custom role like anything else.
 *
 * ── Worth knowing on the deploy ──────────────────────────────────────────
 *
 * Permissions ride in the JWT and are read at login. A super_admin with a
 * session open across this deploy carries a token minted before the grant, so
 * the screen returns 403 until they sign in again. Platform admins are
 * unaffected — isSuperiorAdmin bypasses permission checks entirely.
 */
router.get('/admin/2fa-policy', verifyToken, requirePermission('settings.security.manage'), controller.get2FAPolicyEndpoint);
router.post('/admin/2fa-policy', verifyToken, requirePermission('settings.security.manage'), [body('required').isBoolean()], validate, controller.set2FAPolicy);
/*
 * An operational endpoint that re-reads server configuration, and it had no
 * check of any kind — any account with a token could call it. Gated on the
 * platform permission: superior admins bypass every permission check by
 * definition, so they keep it, and nobody else has any business with it.
 */
router.post('/reload-config', verifyToken, requirePermission('platform.settings.manage'), controller.reloadConfig);
router.post('/switch-role', verifyToken, [body('roleId').notEmpty()], validate, controller.switchRole);
router.post('/profiles/enable', verifyToken, [body('profile').notEmpty()], validate, controller.enableProfile);

module.exports = router;

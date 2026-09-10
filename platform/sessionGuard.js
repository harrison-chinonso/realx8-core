const sessionRegistry = require('../shared/src/sessionRegistry');
const { isIntegrationPath } = require('./security/integrations');

/**
 * Keeps the live session alive, and stops a superseded one from continuing.
 *
 * Runs after the auth gate, because both halves need to know who is calling.
 *
 * ── Touching ────────────────────────────────────────────────────────────────
 *
 * Every authenticated request marks the session as active, which re-arms its
 * inactivity expiry. Without this the window would count from SIGN-IN rather
 * than from last use, and a user would be thrown out mid-work an arbitrary
 * time after logging in.
 *
 * ── Superseding ─────────────────────────────────────────────────────────────
 *
 * A token whose session id is not the live one is refused with 401, so
 * "one session" means something after the sign-in moment too. That case only
 * arises when a session was replaced — a sign-in that got through while the
 * old entry was gone, or an administrative reset.
 *
 * It is careful about what it refuses. A user with NO session entry is let
 * through, not signed out: that covers tokens issued before this existed, and
 * it covers the cache being empty after a restart. Failing the other way would
 * turn a Redis restart into every user being signed out at once, which is a
 * far worse outcome than briefly tolerating a session the registry has
 * forgotten. See shared/src/sessionRegistry.js on the failure direction.
 */
const sessionGuard = () => async (req, res, next) => {
  const userId = req.user?.id;
  const sid = req.user?.sid;

  if (!userId || !sessionRegistry.isEnabled()) return next();
  // Integration callbacks carry no session and must never be judged as one.
  if (isIntegrationPath(req.securityPath || req.path)) return next();

  try {
    if (!(await sessionRegistry.isCurrentSession(userId, sid))) {
      return res.status(401).json({
        message: 'You have been signed out because this account was signed in elsewhere.',
        reason: 'session_superseded',
      });
    }

    /**
     * Not awaited.
     *
     * The touch is bookkeeping; making every request wait on a cache write to
     * learn something the request does not need would add latency to the whole
     * API for no benefit to the caller.
     */
    sessionRegistry.touchSession(userId, sid).catch((error) => {
      console.error('[session] touch failed:', error.message);
    });
  } catch (error) {
    // Never let session bookkeeping fail a request.
    console.error('[session] guard errored, allowing request:', error.message);
  }

  return next();
};

module.exports = { sessionGuard };

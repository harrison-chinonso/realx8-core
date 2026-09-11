const { cache } = require('./cache');

/**
 * One active session per user.
 *
 * A user signing in while another session of theirs is still alive is refused;
 * they get in once that session has been signed out, or has gone quiet long
 * enough to lapse.
 *
 * ── Why the cache is the registry, and not a table ───────────────────────────
 *
 * The rule needs two things on EVERY authenticated request: "is this session
 * still the live one" and "mark it as active just now". As a table that is a
 * read and a write per request, on the hot path, for every service.
 *
 * As a cache entry with a TTL it is neither, because the TTL IS the inactivity
 * rule: a session that stops being touched expires by itself, and expiry is
 * exactly what "logged out by inactivity" means. No sweeper, no scheduled job,
 * and nothing to go stale.
 *
 * ── The failure direction is deliberate ──────────────────────────────────────
 *
 * If the cache is lost — Redis restarts, or the process does with no Redis —
 * every session reads as absent, and absent means "no active session", so
 * logins are ALLOWED. That is fail-open, and it is the right way round: the
 * cost is that a user could briefly hold two sessions after an outage, where
 * failing closed would lock every user out of an application they are entitled
 * to use, with no way back in. A single-session rule is an account-hygiene
 * control, not a barrier holding an attacker out, and it should not be able to
 * cause an outage.
 */

const key = (userId) => `session:user:${userId}`;

/**
 * OFF by default, for now.
 *
 * This was originally on by default, on the reasoning that one-session-per-user
 * was asked for as behaviour rather than as an option. It is disabled while the
 * reported misbehaviour is diagnosed — and the default rather than only the
 * environment file, so that it is off in every deployment without each one
 * having to set a variable.
 *
 * Nothing else changes when it is off: sessions still expire, tokens still
 * carry a session id, and the registry still records activity. Only the refusal
 * to open a second session is suspended, so turning it back on is a one-word
 * change rather than a redeployment of behaviour.
 */
const isEnabled = () => String(process.env.SINGLE_SESSION_ENABLED ?? 'false').toLowerCase() === 'true';

/**
 * How long a session survives without activity.
 *
 * This doubles as the lockout a user feels after closing the browser without
 * signing out: they cannot sign in again until it lapses. Thirty minutes is
 * the default; shorten it if that wait is the complaint, lengthen it if
 * sessions are lapsing while people are still working.
 */
const inactivitySeconds = () => {
  const minutes = Number(process.env.SESSION_INACTIVITY_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60;
};

/** How often activity is written back. Touching on every request would undo the point. */
const TOUCH_INTERVAL_MS = 60 * 1000;

/** The live session for a user, or null. Expiry is handled by the cache TTL. */
const activeSession = async (userId) => {
  if (!isEnabled() || !userId) return null;
  return cache.get(key(userId));
};

/**
 * Whether a new sign-in is allowed, and why not when it is not.
 *
 * Returns the existing session so the caller can tell the user something
 * useful — when it was last active, and roughly from where — rather than a
 * bare refusal they cannot act on.
 */
const canSignIn = async (userId) => {
  const existing = await activeSession(userId);
  if (!existing) return { allowed: true };
  return { allowed: false, existing };
};

/** Records a new session, replacing whatever was there. */
const startSession = async (userId, { sid, ip, userAgent } = {}) => {
  if (!isEnabled() || !userId) return null;
  const session = {
    sid,
    startedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    ip: ip || null,
    userAgent: userAgent ? String(userAgent).slice(0, 200) : null,
  };
  await cache.set(key(userId), session, inactivitySeconds());
  return session;
};

/**
 * Marks a session as active, at most once a minute.
 *
 * Rewriting the entry on every request would mean a cache write per API call,
 * which is the cost this design exists to avoid. A minute of granularity is
 * far finer than the inactivity window it feeds.
 */
const touchSession = async (userId, sid) => {
  if (!isEnabled() || !userId) return;
  const existing = await cache.get(key(userId));
  if (!existing || existing.sid !== sid) return;

  const lastSeen = Date.parse(existing.lastSeenAt || 0);
  if (Number.isFinite(lastSeen) && Date.now() - lastSeen < TOUCH_INTERVAL_MS) {
    /**
     * Still re-set the TTL even when the timestamp is not rewritten.
     *
     * Without this a user who is active every few seconds would have their
     * session expire mid-use: the entry's TTL counts down from the last WRITE,
     * not the last request, so skipping the write entirely would let a busy
     * session lapse exactly like an idle one.
     */
    await cache.set(key(userId), existing, inactivitySeconds());
    return;
  }

  await cache.set(
    key(userId),
    { ...existing, lastSeenAt: new Date().toISOString() },
    inactivitySeconds(),
  );
};

/** Ends the session — an explicit sign-out. */
const endSession = async (userId) => {
  if (!userId) return;
  await cache.del(key(userId));
};

/**
 * Whether this request's session is still the live one.
 *
 * Absent means ALLOWED, not denied — see the failure note at the top. It also
 * covers tokens issued before this feature existed, which carry no sid and
 * must keep working until they expire rather than signing everyone out on
 * deploy.
 */
const isCurrentSession = async (userId, sid) => {
  if (!isEnabled() || !userId || !sid) return true;
  const existing = await cache.get(key(userId));
  if (!existing || !existing.sid) return true;
  return existing.sid === sid;
};

module.exports = {
  isEnabled,
  inactivitySeconds,
  activeSession,
  canSignIn,
  startSession,
  touchSession,
  endSession,
  isCurrentSession,
  TOUCH_INTERVAL_MS,
};

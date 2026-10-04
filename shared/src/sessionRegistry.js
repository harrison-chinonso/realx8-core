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
 * ON by default: one account, one device at a time.
 *
 * It was switched off for a while because people were refused by their OWN
 * session — close the browser or the app without signing out, come back, and
 * be told the account was "signed in on another device" until it idled out.
 * That was the rule failing to tell a returning device from a different one.
 * Sessions now carry the device they were opened on (see deviceIdOf), and a
 * device signing in again replaces its own session; only a DIFFERENT device is
 * refused. Set SINGLE_SESSION_ENABLED=false to allow several at once.
 */
const isEnabled = () => String(process.env.SINGLE_SESSION_ENABLED ?? 'true').toLowerCase() !== 'false';

/**
 * Which device a sign-in comes from: a random id the app creates once and
 * keeps (web: localStorage; the mobile app: its WebView's storage), sent as
 * `device_id` on sign-in calls. Anything else — missing, malformed — is null,
 * which is treated as "a different device": never a way round the rule.
 *
 * Not a security boundary on its own (a password still has to be right); it
 * only decides whether a correct sign-in is the same device coming back.
 */
const cleanDeviceId = (value) => {
  const id = String(value ?? '').trim();
  return /^[A-Za-z0-9_-]{16,64}$/.test(id) ? id : null;
};
const deviceIdOf = (req) => cleanDeviceId(req?.body?.device_id ?? req?.query?.device_id ?? null);

/**
 * Inactivity expiry, which is a SEPARATE question from one-session-per-user.
 *
 * These used to be one switch, and the comment above claimed that turning
 * single-session off left expiry running. It did not: every function here
 * short-circuited on isEnabled(), so disabling the refusal also disabled all
 * session tracking — no record was written at sign-in, no activity was
 * recorded, and nothing ever expired. A session was then valid for the whole
 * life of its token no matter how long it sat idle.
 *
 * They are independent now. "Only one session at a time" is a policy choice;
 * "an idle session stops working" is a security property, and wanting the
 * second should not require accepting the first.
 */
const inactivityEnabled = () => String(
  process.env.SESSION_INACTIVITY_ENABLED ?? 'true',
).toLowerCase() !== 'false';

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

/**
 * How often activity is written back.
 *
 * Touching on every request would mean a cache write per API call, which is
 * the cost this design exists to avoid. But the interval CANNOT exceed the
 * inactivity window: expiry is decided by comparing lastSeenAt, so a session
 * being used every second still looks idle if its timestamp is only rewritten
 * once a minute and the window is thirty seconds. A verification run caught
 * exactly that — a session in continuous use expiring mid-work.
 *
 * So it is a quarter of the window, capped at a minute. At the default
 * thirty-minute window that is the same one write per minute as before; at a
 * one-minute window it becomes every fifteen seconds, which is correct rather
 * than cheap.
 */
const TOUCH_INTERVAL_MS = 60 * 1000;
const touchIntervalMs = () => Math.min(TOUCH_INTERVAL_MS, (inactivitySeconds() * 1000) / 4);

/**
 * How long the RECORD is kept — deliberately much longer than the window.
 *
 * Expiry is decided by comparing lastSeenAt against the window, not by the key
 * having vanished. That distinction is the whole design:
 *
 *   If absence meant "expired", a Redis restart or an eviction would log every
 *   user out at once, and there would be no way to tell a genuinely idle
 *   session from a cache that simply lost it.
 *
 *   Because the record outlives the window, an idle session is still THERE to
 *   be judged — and a lost record falls back to "cannot tell", which allows
 *   the request. Losing the cache costs expiry until sign-in, never a mass
 *   sign-out.
 */
const RECORD_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Whether a record's last activity is older than the inactivity window. */
const hasLapsed = (session) => {
  const lastSeen = Date.parse(session?.lastSeenAt || session?.startedAt || '');
  if (!Number.isFinite(lastSeen)) return false;
  return Date.now() - lastSeen > inactivitySeconds() * 1000;
};

/** The live session for a user, or null. Expiry is handled by the cache TTL. */
const activeSession = async (userId) => {
  if (!inactivityEnabled() || !userId) return null;
  return cache.get(key(userId));
};

/**
 * Whether a new sign-in is allowed, and why not when it is not.
 *
 * Returns the existing session so the caller can tell the user something
 * useful — when it was last active, and roughly from where — rather than a
 * bare refusal they cannot act on.
 */
const canSignIn = async (userId, { device = null } = {}) => {
  if (!isEnabled()) return { allowed: true };
  const existing = await activeSession(userId);
  // A record that has already lapsed is not a live session, so it must not
  // block a sign-in — that was the shape of the lockout this design has to
  // avoid: being refused entry by your own abandoned session.
  if (!existing || hasLapsed(existing)) return { allowed: true };
  // The same device coming back (a closed tab, a restarted app, the passcode
  // screen): it replaces its own session rather than being locked out by it.
  if (device && existing.device && existing.device === device) return { allowed: true, sameDevice: true };
  return { allowed: false, existing };
};

/** Records a new session, replacing whatever was there. */
const startSession = async (userId, { sid, ip, userAgent, device } = {}) => {
  if (!inactivityEnabled() || !userId) return null;
  /*
   * A refresh or role switch re-registers the same session without knowing the
   * device (those requests do not carry it); keep the one recorded at sign-in
   * so the same-device rule still holds afterwards.
   */
  const previous = device ? null : await cache.get(key(userId));
  const session = {
    sid,
    device: device || (previous && previous.sid === sid ? previous.device || null : null),
    startedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    ip: ip || null,
    userAgent: userAgent ? String(userAgent).slice(0, 200) : null,
  };
  await cache.set(key(userId), session, RECORD_TTL_SECONDS);
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
  if (!inactivityEnabled() || !userId) return;
  const existing = await cache.get(key(userId));
  if (!existing || existing.sid !== sid) return;

  const lastSeen = Date.parse(existing.lastSeenAt || 0);
  if (Number.isFinite(lastSeen) && Date.now() - lastSeen < touchIntervalMs()) {
    /**
     * Still re-set the TTL even when the timestamp is not rewritten.
     *
     * Without this a user who is active every few seconds would have their
     * session expire mid-use: the entry's TTL counts down from the last WRITE,
     * not the last request, so skipping the write entirely would let a busy
     * session lapse exactly like an idle one.
     */
    await cache.set(key(userId), existing, RECORD_TTL_SECONDS);
    return;
  }

  await cache.set(
    key(userId),
    { ...existing, lastSeenAt: new Date().toISOString() },
    RECORD_TTL_SECONDS,
  );
};

/**
 * Ends the session — an explicit sign-out.
 *
 * Only the caller's OWN session: a device that was already pushed out (or one
 * signing out a token from long ago) must not end the session another device
 * is using now — that would free the account for a third device, which is the
 * thing this rule exists to stop. Without a sid (tokens from before sessions
 * were tracked) it ends whatever is there, as it always did.
 */
const endSession = async (userId, sid = null) => {
  if (!userId) return;
  if (sid) {
    const existing = await cache.get(key(userId));
    if (existing?.sid && existing.sid !== sid) return;
  }
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
const isCurrentSession = async (userId, sid) => (await sessionState(userId, sid)).valid;

/**
 * Why a request may or may not proceed: 'ok', 'expired', 'superseded', or
 * 'unknown'.
 *
 * Three states rather than a boolean because the caller needs to say something
 * different for each, and because 'unknown' must not be confused with a
 * failure — a token issued before this existed, or a record the cache has
 * lost, both land there and both are allowed.
 */
const sessionState = async (userId, sid) => {
  if (!inactivityEnabled() || !userId || !sid) return { valid: true, reason: 'disabled' };

  const existing = await cache.get(key(userId));
  if (!existing || !existing.sid) return { valid: true, reason: 'unknown' };

  if (hasLapsed(existing)) return { valid: false, reason: 'expired', session: existing };
  // Only a policy failure when the refusal is switched on; otherwise a second
  // session is legitimate and must not invalidate the first.
  if (existing.sid !== sid) {
    return isEnabled()
      ? { valid: false, reason: 'superseded', session: existing }
      : { valid: true, reason: 'other_session' };
  }
  return { valid: true, reason: 'ok', session: existing };
};

module.exports = {
  isEnabled,
  cleanDeviceId,
  deviceIdOf,
  inactivityEnabled,
  sessionState,
  hasLapsed,
  inactivitySeconds,
  activeSession,
  canSignIn,
  startSession,
  touchSession,
  endSession,
  isCurrentSession,
  TOUCH_INTERVAL_MS,
  touchIntervalMs,
};

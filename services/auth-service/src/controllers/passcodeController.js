const bcrypt = require('bcryptjs');
const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { User } = require('../models');
// Reused so a passcode sign-in yields exactly the same session shape as a
// password one — same roles, permissions and tokens.
const { issueSession, refuseIfSignedInElsewhere, presentUser } = require('./authController');
const { sequelize } = require('../config/database');
const { significantDigits, isPlausiblePhone, phoneMatchSql } = require('../../../../shared/src/phone');
const { BCRYPT_ROUNDS } = require('../../../../shared/src/passwordPolicy');
const { q } = require('../../../../shared/src/dialect');
const { accountsForEmail, normaliseEmail } = require('../../../../shared/src/emailIdentity');

/**
 * A 6-digit passcode for quick re-entry.
 *
 * The whole design rests on one constraint: six digits is a million
 * combinations, which is not enough to be a credential on its own. So it is
 * never a substitute for the password — it is a shortcut back in, and only
 * while a full sign-in is recent:
 *
 *   - accepted only within PASSCODE_WINDOW_HOURS of the last FULL sign-in
 *   - hashed with bcrypt, never stored or returned in the clear
 *   - locked out after a handful of wrong tries
 *   - setting or changing one requires the current password, so a stolen
 *     session cannot quietly add a second way in
 *   - using it does NOT extend the window; only a password sign-in does
 *
 * That last point is what stops the passcode becoming the real credential: the
 * window closes two hours after the password was last used, no matter how many
 * times the passcode is used inside it.
 */

/** How long after a full sign-in a passcode is still sufficient. */
const PASSCODE_WINDOW_HOURS = 2;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

const PASSCODE_PATTERN = /^\d{6}$/;

/**
 * Weak passcodes are refused.
 *
 * Out of a million combinations, a few hundred account for a large share of
 * real-world choices. Rejecting the obvious ones costs the user nothing and
 * removes the cases a lockout would not save them from.
 */
const isTooGuessable = (passcode) => {
  if (/^(\d)\1{5}$/.test(passcode)) return true;                       // 000000, 111111
  const ascending = '01234567890123456789';
  const descending = '98765432109876543210';
  if (ascending.includes(passcode) || descending.includes(passcode)) return true;
  return ['123456', '654321', '123123', '112233', '121212'].includes(passcode);
};

const withinWindow = (lastLoginAt) => {
  if (!lastLoginAt) return false;
  const elapsedMs = Date.now() - new Date(lastLoginAt).getTime();
  return elapsedMs >= 0 && elapsedMs <= PASSCODE_WINDOW_HOURS * 60 * 60 * 1000;
};

/** Sets or replaces the caller's passcode. Requires their password. */
const setPasscode = asyncHandler(async (req, res) => {
  const passcode = String(req.body.passcode ?? '').trim();
  const password = String(req.body.password ?? '');

  if (!PASSCODE_PATTERN.test(passcode)) {
    return res.status(400).json({ message: 'Your passcode must be exactly 6 digits.' });
  }
  if (isTooGuessable(passcode)) {
    return res.status(400).json({
      message: 'That passcode is too easy to guess. Avoid repeated digits and simple sequences.',
    });
  }

  const user = await User.findByPk(req.user.id);
  if (!user) return res.status(404).json({ message: 'Account not found' });

  /**
   * The password is required even though the caller is already authenticated.
   *
   * Without it, anyone holding a stolen token could add a passcode and keep a
   * way in after the token expired — turning a short-lived compromise into a
   * durable one.
   */
  if (!password || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ message: 'Enter your current password to set a passcode.' });
  }

  await user.update({
    passcode_hash: await bcrypt.hash(passcode, BCRYPT_ROUNDS),
    passcode_set_at: new Date(),
    passcode_failed_attempts: 0,
    passcode_locked_until: null,
  });

  // The refreshed user goes back too, so a client that has been holding the
  // sign-in payload does not carry a stale `passcode_set` until its next
  // /auth/me.
  res.json({
    message: 'Passcode set. You can use it to sign back in for '
      + `${PASSCODE_WINDOW_HOURS} hours after each full sign-in.`,
    data: { passcode_set: true, window_hours: PASSCODE_WINDOW_HOURS },
    user: await presentUser(user),
  });
});

/** Removes it. No password needed — turning a credential off is always safe. */
const removePasscode = asyncHandler(async (req, res) => {
  const user = await User.findByPk(req.user.id);
  if (!user) return res.status(404).json({ message: 'Account not found' });
  await user.update({
    passcode_hash: null, passcode_set_at: null,
    passcode_failed_attempts: 0, passcode_locked_until: null,
  });
  res.json({
    message: 'Passcode removed. Sign in with your password from now on.',
    data: { passcode_set: false },
    user: await presentUser(user),
  });
});

/** Whether the caller has one, and whether it would work right now. */
const getPasscodeStatus = asyncHandler(async (req, res) => {
  const user = await User.findByPk(req.user.id);
  if (!user) return res.status(404).json({ message: 'Account not found' });
  res.json({
    data: {
      passcode_set: Boolean(user.passcode_hash),
      window_hours: PASSCODE_WINDOW_HOURS,
      // Why it would be refused, so the UI can explain rather than just fail.
      usable_now: Boolean(user.passcode_hash) && withinWindow(user.last_login_at)
        && !(user.passcode_locked_until && new Date(user.passcode_locked_until) > new Date()),
      last_login_at: user.last_login_at,
      locked_until: user.passcode_locked_until,
    },
  });
});

/**
 * Finds the account a passcode sign-in means.
 *
 * ── Why this does not ask which company ─────────────────────────────────────
 *
 * A person may hold an account at several companies, and each has its own
 * passcode and its own two-hour window — the passcode is set per account,
 * because it is a shortcut back into a session rather than a credential in its
 * own right.
 *
 * So there is no choice to put to anybody: the passcode resumes the company
 * they were last signed into, which is the one whose window is open. Ordering
 * by last_login_at picks exactly that, and in the overwhelming majority of
 * cases only one account has a live window at all — the others' closed hours
 * ago, and a closed window is refused before the passcode is even compared.
 *
 * Offering a company list here would also be a disclosure: this endpoint
 * answers every refusal identically on purpose, so that it cannot be used to
 * find out which accounts exist.
 *
 * The phone number is still refused when it belongs to more than one PERSON,
 * for the same reason the password login refuses it — no credential could
 * distinguish them.
 */
const findUser = async (identifier) => {
  const value = String(identifier).trim();

  const byEmail = await accountsForEmail(sequelize, value);
  if (byEmail.length) return mostRecentlySignedIn(byEmail.map((row) => row.id));

  if (!isPlausiblePhone(value)) return null;
  const rows = await sequelize.query(
    `SELECT id, ${q(sequelize, 'email')} FROM users
      WHERE deleted_at IS NULL AND ${phoneMatchSql('phone', ':phoneDigits')}`,
    { replacements: { phoneDigits: significantDigits(value) }, type: QueryTypes.SELECT },
  );
  if (!rows.length) return null;
  if (new Set(rows.map((row) => normaliseEmail(row.email))).size > 1) return null;

  return mostRecentlySignedIn(rows.map((row) => row.id));
};

/**
 * Of several accounts one person holds, the one they last signed into.
 *
 * NULLs sort last deliberately: an account never fully signed into has no open
 * window and could never accept a passcode, so it must not win the tie.
 */
const mostRecentlySignedIn = async (ids) => {
  if (!ids.length) return null;
  const candidates = await User.findAll({ where: { id: ids } });
  return candidates.sort((a, b) => {
    const left = a.last_login_at ? new Date(a.last_login_at).getTime() : -1;
    const right = b.last_login_at ? new Date(b.last_login_at).getTime() : -1;
    return right - left;
  })[0] || null;
};

/**
 * Signs in with a passcode alone.
 *
 * Every refusal returns the SAME shape and status as a wrong passcode where it
 * possibly can, so this cannot be used to discover which accounts exist or
 * which have a passcode set. The one exception is an expired window, which the
 * user does need explaining — and which only reveals something to someone who
 * already knows the passcode.
 */
const loginWithPasscode = asyncHandler(async (req, res) => {
  const identifier = req.body.identifier || req.body.email || req.body.phone || '';
  const passcode = String(req.body.passcode ?? '').trim();

  if (!identifier || !PASSCODE_PATTERN.test(passcode)) {
    return res.status(400).json({ message: 'Enter your email or phone number and your 6-digit passcode.' });
  }

  const user = await findUser(identifier);
  const generic = { message: 'That passcode is not correct, or your session has expired. Sign in with your password.' };

  if (!user || !user.passcode_hash) return res.status(401).json(generic);
  if (!user.is_active) return res.status(403).json({ message: 'Account is inactive' });

  if (user.passcode_locked_until && new Date(user.passcode_locked_until) > new Date()) {
    const minutes = Math.max(1, Math.ceil((new Date(user.passcode_locked_until) - Date.now()) / 60000));
    return res.status(429).json({
      message: `Too many incorrect attempts. Try again in ${minutes} minute(s), or sign in with your password.`,
    });
  }

  /**
   * The window is checked BEFORE the passcode is compared.
   *
   * Outside it the passcode is not a valid credential at all, so there is
   * nothing to check — and comparing first would let someone confirm a guess
   * against an account whose window had closed.
   */
  if (!withinWindow(user.last_login_at)) {
    return res.status(401).json({
      message: `It has been more than ${PASSCODE_WINDOW_HOURS} hours since you last signed in. `
        + 'Please use your password.',
      reason: 'window_expired',
    });
  }

  if (!(await bcrypt.compare(passcode, user.passcode_hash))) {
    const attempts = Number(user.passcode_failed_attempts || 0) + 1;
    const locked = attempts >= MAX_FAILED_ATTEMPTS;
    await user.update({
      passcode_failed_attempts: locked ? 0 : attempts,
      passcode_locked_until: locked
        ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
        : user.passcode_locked_until,
    });
    return res.status(locked ? 429 : 401).json(locked
      ? { message: `Too many incorrect attempts. Try again in ${LOCKOUT_MINUTES} minutes, or sign in with your password.` }
      : generic);
  }

  await user.update({ passcode_failed_attempts: 0, passcode_locked_until: null });

  /**
   * Issues a session, WITHOUT moving last_login_at.
   *
   * That is what keeps the window a fixed two hours from the last password
   * sign-in. Refreshing it here would let someone hold a session open
   * indefinitely on six digits.
   */
  // A passcode sign-in is still a sign-in, so it honours the one-session rule.
  if (await refuseIfSignedInElsewhere(user, res)) return;

  const session = await issueSession(user, null, { req });
  res.json(session);
});

module.exports = {
  setPasscode, removePasscode, getPasscodeStatus, loginWithPasscode,
  PASSCODE_WINDOW_HOURS, isTooGuessable, withinWindow,
};

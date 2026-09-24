/**
 * One password policy, in one place.
 *
 * ── What it replaces ─────────────────────────────────────────────────────────
 *
 * A minimum declared separately in three route files and once more inside
 * resetPassword, and a bcrypt cost that was 12 in bootstrap and 10 everywhere
 * else — including the reset path, so changing your password quietly weakened
 * its hash. One declaration means the number below is the number enforced, at
 * every point a password is chosen.
 *
 * ── On the number ───────────────────────────────────────────────────────────
 *
 * Eight, set deliberately. It was twelve, and twelve is the stronger figure
 * against offline guessing — that is the trade being made, and it is worth
 * naming rather than leaving for somebody to rediscover.
 *
 * What carries the weight instead is the cost factor below and the rate
 * limiting in front of the sign-in routes: an eight-character password is
 * cheap to guess offline and expensive to guess online, and this application
 * has no exposed hash. The figure also has to be one people will use — a long
 * minimum that sends users to a reused password, or to a note beside the
 * screen, buys nothing.
 *
 * ── Only new passwords are affected ──────────────────────────────────────────
 *
 * Sign-in does not measure length — it compares a hash — so raising the minimum
 * cannot lock out an existing account. It applies at registration, at admin
 * user-creation and at reset, which is where a password is chosen.
 *
 * ── On the cost factor ───────────────────────────────────────────────────────
 *
 * 12 is roughly 250ms on current hardware: unnoticeable once per sign-in, and
 * four times the work per guess for anybody with the table. It matters most for
 * the six-digit passcode, whose entropy is small enough that the hash is the
 * only thing standing between a leaked table and every PIN in it.
 */
const MIN_PASSWORD_LENGTH = 8;

const BCRYPT_ROUNDS = 12;

const PASSWORD_MESSAGE = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;

module.exports = { MIN_PASSWORD_LENGTH, BCRYPT_ROUNDS, PASSWORD_MESSAGE };

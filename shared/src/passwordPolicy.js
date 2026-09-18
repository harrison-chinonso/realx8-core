/**
 * One password policy, in one place.
 *
 * ── What it replaces ─────────────────────────────────────────────────────────
 *
 * A six-character minimum, declared separately in three route files and once
 * more inside resetPassword, and a bcrypt cost that was 12 in bootstrap and 10
 * everywhere else — including the reset path, so changing your password quietly
 * weakened its hash.
 *
 * Six characters is a few seconds of offline guessing against any hash this
 * side of a memory-hard one, and this application holds tenant financial
 * records behind those passwords.
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
const MIN_PASSWORD_LENGTH = 12;

const BCRYPT_ROUNDS = 12;

const PASSWORD_MESSAGE = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;

module.exports = { MIN_PASSWORD_LENGTH, BCRYPT_ROUNDS, PASSWORD_MESSAGE };

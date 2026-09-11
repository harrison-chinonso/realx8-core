/**
 * Signing and verification must use the SAME secret.
 *
 * When they diverge the symptom is unmistakable and badly misleading: signing
 * in succeeds, because signing in only signs, and then every API call returns
 * "Invalid or expired token". It looks like a session problem and is really a
 * configuration one.
 *
 * The divergence is easy to arrive at: jwt_secret used to be read from the
 * settings table when signing and from the environment when verifying, and a
 * settings table travels with data — restore production from a development
 * dump and development's secret comes with it.
 *
 *   npm run verify:jwt-secret
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const jwt = require('jsonwebtoken');

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

/** What shared/src/middleware/auth.js verifies with — the thing that must be matched. */
const verifierSecret = () => process.env.JWT_SECRET || 'super-secret-key';

/** The resolution the signer now uses. Mirrors authController.jwtSecret. */
const signerSecret = (stored) => {
  const configured = process.env.JWT_SECRET;
  if (!configured) return stored || 'super-secret-key';
  return configured;
};

const roundTrips = (stored) => {
  const token = jwt.sign({ id: 1 }, signerSecret(stored), { expiresIn: '1h' });
  try { jwt.verify(token, verifierSecret()); return true; } catch { return false; }
};

(async () => {
  console.log('\n── The environment is authoritative ─────────────────────────────');

  process.env.JWT_SECRET = 'the-real-deployment-secret';

  check('A settings row that AGREES round-trips',
    roundTrips('the-real-deployment-secret'));

  check('A settings row that DISAGREES is ignored, and still round-trips',
    roundTrips('super-secret-key'),
    'this is the migrated-development-value case: signing in worked and every '
      + 'other call failed, because signing used this and verifying used the environment');

  check('No settings row at all round-trips',
    roundTrips(null));

  check('An empty settings row round-trips',
    roundTrips(''));

  console.log('\n── Without an environment variable, the row is still honoured ───');
  delete process.env.JWT_SECRET;

  check('A settings row is used when nothing is configured',
    roundTrips('only-in-the-database') === false,
    'signer uses the row, verifier falls back to the default — the one case that '
      + 'cannot agree, and the reason JWT_SECRET should always be set');

  check('With neither, both fall back to the same default',
    roundTrips(null),
    'a development machine with no configuration at all still works');

  console.log('\n── The old behaviour, for contrast ──────────────────────────────');
  process.env.JWT_SECRET = 'the-real-deployment-secret';
  const oldSigner = (stored) => stored || process.env.JWT_SECRET || 'super-secret-key';
  const oldToken = jwt.sign({ id: 1 }, oldSigner('super-secret-key'), { expiresIn: '1h' });
  let oldVerifies = true;
  try { jwt.verify(oldToken, verifierSecret()); } catch { oldVerifies = false; }
  check('The previous resolution FAILS verification on a mismatched row',
    oldVerifies === false,
    'reproduces the reported fault: signed in fine, every API call rejected');

  console.log(`\n  ${pass}/${pass + fail} passed.\n`);
  process.exit(fail ? 1 : 0);
})();

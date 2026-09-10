/**
 * Prints the payload-encryption bootstrap key for the current secret.
 *
 * The UI needs this value as VITE_PAYLOAD_BOOTSTRAP_KEY. It is DERIVED from
 * PAYLOAD_ENCRYPTION_SECRET rather than configured separately, so the two can
 * never drift apart — a mismatch would mean every pre-login call failing to
 * decrypt, which is a confusing thing to debug.
 *
 * The bootstrap key is not a secret in any meaningful sense: it ships in the
 * UI bundle and covers only the handful of calls made before anyone has signed
 * in. Authenticated traffic uses a per-session key that never leaves the
 * server except to the session that owns it.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', 'cred.env') });
const { bootstrapKeyHex, mode } = require('../shared/src/payloadCrypto');

const usingFallback = !process.env.PAYLOAD_ENCRYPTION_SECRET;

console.log(`\nPAYLOAD_ENCRYPTION_MODE is currently: ${mode()}`);
if (usingFallback) {
  console.log('\n  ! PAYLOAD_ENCRYPTION_SECRET is not set — falling back to JWT_SECRET.');
  console.log('    Set a separate secret in production; rotating the JWT secret would');
  console.log('    otherwise silently change every payload key at the same time.');
}
console.log('\nAdd this to Realx8-Ui/.env:\n');
console.log(`VITE_PAYLOAD_ENCRYPTION=on`);
console.log(`VITE_PAYLOAD_BOOTSTRAP_KEY=${bootstrapKeyHex()}\n`);

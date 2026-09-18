/**
 * The one deployment secret, and the refusal to invent one.
 *
 * ── What was here before ─────────────────────────────────────────────────────
 *
 * Four places resolved `process.env.JWT_SECRET || 'super-secret-key'`
 * independently: the token verifier every service runs, the token signer in
 * auth-service, payload encryption, and share links. That literal is in the
 * repository, so in any environment where JWT_SECRET was not set, the key
 * protecting all four was public knowledge — and forging
 * `{ type: 'superior_admin', isSuperiorAdmin: true }` with it is a signed,
 * valid session as a platform administrator on every tenant.
 *
 * It fails silently and completely. Nothing logs, nothing 500s, every
 * signature verifies: the deployment simply has no authentication, and looks
 * exactly like one that does.
 *
 * ── Why this throws rather than generating one ───────────────────────────────
 *
 * A random per-process secret would be safe and would break the split
 * deployment shape, where nine services must verify what another signed — and
 * it would break it intermittently, only under the load that starts a second
 * instance. A service that refuses to start states the problem once, at the
 * moment it can still be fixed, and cannot be mistaken for a working one.
 *
 * ── Why development is the opt-OUT ───────────────────────────────────────────
 *
 * The check is inverted from the usual `NODE_ENV === 'production'`: a secret is
 * required unless NODE_ENV explicitly says development or test. An environment
 * that forgot to set NODE_ENV is the one most likely to have forgotten
 * JWT_SECRET too, and under the usual form that combination is exactly what
 * slips through. cred.env.example sets NODE_ENV=development, the Dockerfile and
 * render.yaml set production, so the two real paths are both already covered.
 */
const DEV_ENVIRONMENTS = ['development', 'test'];

const isDevelopment = () => DEV_ENVIRONMENTS.includes(String(process.env.NODE_ENV || '').toLowerCase());

/**
 * A stable, obviously-not-secret value for local work.
 *
 * Fixed rather than random because every service in the split shape has to
 * agree, and named so that it cannot be mistaken for a real key if it ever
 * turns up in a token, a log line or a support ticket.
 */
const DEVELOPMENT_SECRET = 'realx8-development-only-not-a-secret';

let warned = false;

/**
 * The deployment secret. Throws outside development when JWT_SECRET is unset.
 *
 * Read through a function rather than frozen at require time so a process that
 * loads cred.env after its first import still sees the value, and so a test
 * can set and clear it.
 */
const appSecret = () => {
  const configured = process.env.JWT_SECRET;
  if (configured) return configured;

  if (!isDevelopment()) {
    throw new Error(
      'JWT_SECRET is not set. Every session token, payload key and share link is signed with '
      + 'it, and there is no default — a fallback baked into the source would mean anyone who '
      + 'can read this repository can mint a platform-administrator session. '
      + 'Set JWT_SECRET (render.yaml generates one) and start again.',
    );
  }

  if (!warned) {
    warned = true;
    console.warn('[security] JWT_SECRET is not set. Using the development-only secret, which is '
      + 'in the source tree and protects nothing. Set JWT_SECRET before deploying anywhere.');
  }
  return DEVELOPMENT_SECRET;
};

module.exports = { appSecret, isDevelopment, DEVELOPMENT_SECRET };

const { csv } = require('./config');
const rateLimit = require('./rateLimit');

/**
 * Inbound traffic from the services this application integrates with.
 *
 * ── First, the thing that is NOT a problem ───────────────────────────────────
 *
 * Calls this backend MAKES to a third party — Paystack, Flutterwave, Stripe,
 * an SMS gateway, Google — are not affected by anything in platform/security.
 * CORS is a rule browsers enforce on pages; a server-side axios or fetch call
 * ignores it entirely, and none of the filters here ever see an outbound
 * request. Those responses could not be blocked by this layer and are not.
 *
 * ── What IS a problem, and what this file fixes ──────────────────────────────
 *
 * Traffic those services send back TO us — a payment webhook, an OAuth
 * redirect, a delivery receipt — arrives as an ordinary inbound request and
 * gets judged like one. It is not a browser: no signed frontend header, a
 * server User-Agent that reads as an automated tool, no session. Every one of
 * those checks would refuse it, so a payment confirmation would silently never
 * arrive.
 *
 * The paths below are therefore exempt from the browser-shaped checks.
 *
 * ── The obligation that comes with an exemption ──────────────────────────────
 *
 * An exempt path is reachable by ANYONE, not only by the provider — nothing
 * here can tell a real Paystack webhook from someone posting the same shape at
 * the same URL. So an exempt endpoint MUST authenticate the caller itself,
 * with the provider's own signature:
 *
 *   Paystack     x-paystack-signature   HMAC-SHA512 of the raw body
 *   Flutterwave  verif-hash             the secret hash configured with them
 *   Stripe       stripe-signature       via stripe.webhooks.constructEvent
 *
 * and, having verified it, should re-fetch the transaction from the provider
 * before trusting an amount. Adding a path here without that is not "exempt
 * from the filters", it is unauthenticated and writable by the public.
 */

/**
 * The default exemptions.
 *
 * Deliberately narrow: only routes that genuinely receive third-party traffic.
 * A broad pattern like '/payments/**' would have exempted the whole payments
 * area of the application, which is the opposite of what is wanted.
 */
const DEFAULT_INTEGRATION_PATHS = [
  // Payment providers calling back with the result of a transaction.
  '/webhooks/**',
  '/integrations/**',

  // OAuth: the browser arrives here by redirect FROM the provider, so the
  // request does not originate from our own page and carries no signed header.
  '/auth/google',
  '/auth/google/callback',
  '/auth/*/callback',
];

/**
 * Extra paths for this deployment, comma-separated, e.g.
 *   INTEGRATION_EXEMPT_PATHS=/finance/paystack/webhook,/sms/delivery-report
 *
 * Additive rather than replacing, so a deployment that adds one cannot
 * accidentally drop the OAuth callbacks and break sign-in.
 */
const integrationPaths = () => [
  ...DEFAULT_INTEGRATION_PATHS,
  ...csv(process.env.INTEGRATION_EXEMPT_PATHS),
];

/** Whether a path is inbound integration traffic. */
const isIntegrationPath = (path) => rateLimit.matchesAny(path, integrationPaths());

/**
 * Whether integration callbacks are also exempt from RATE LIMITING.
 *
 * Off by default. A provider retrying a webhook is normal and bursty, but the
 * same URL is open to anyone, so removing the limit removes the only thing
 * bounding an abusive caller. The limits are per IP and a provider comes from
 * a small stable set of addresses, so the default is usually right — set this
 * true only if a real provider is being throttled.
 */
const integrationsSkipRateLimit = () => String(
  process.env.INTEGRATION_EXEMPT_RATE_LIMIT || 'false',
).toLowerCase() === 'true';

module.exports = {
  DEFAULT_INTEGRATION_PATHS,
  integrationPaths,
  isIntegrationPath,
  integrationsSkipRateLimit,
};

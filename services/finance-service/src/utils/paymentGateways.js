const { QueryTypes } = require('sequelize');

/**
 * The payment gateways this platform can be configured with.
 *
 * Keys live in the `settings` table under group 'payment', per company with a
 * platform-wide fallback — the same override rule as SMTP and appearance. They
 * are set from the Payment Gateways panel in Settings.
 *
 * Listed in the order we prefer when several are configured at once.
 */
const GATEWAYS = [
  { key: 'paystack', label: 'Paystack', publicKey: 'paystack_public_key', secretKey: 'paystack_secret_key' },
  { key: 'flutterwave', label: 'Flutterwave', publicKey: 'flutterwave_public_key', secretKey: 'flutterwave_secret_key' },
  { key: 'stripe', label: 'Stripe', publicKey: 'stripe_public_key', secretKey: 'stripe_secret_key' },
];

const byKey = new Map(GATEWAYS.map((g) => [g.key, g]));

/** Company settings win over platform ones, same merge the notifier uses. */
const paymentSettingsFor = async (sequelize, companyId) => {
  const rows = await sequelize.query(
    `SELECT \`key\`, \`value\`, company_id FROM settings
      WHERE \`group\` = 'payment'
        AND (company_id IS NULL OR company_id = :companyId)`,
    { replacements: { companyId: companyId ?? null }, type: QueryTypes.SELECT },
  );
  const global = {}; const company = {};
  rows.forEach((r) => { (r.company_id == null ? global : company)[r.key] = r.value; });
  return { ...global, ...company };
};

/**
 * Which environment a secret key belongs to, from its own prefix.
 *
 * Worth surfacing: the single most common gateway misconfiguration is saving a
 * test key in production (or the reverse), which fails only at the moment
 * someone tries to pay. A credential check that says "valid" without saying
 * WHICH environment is valid would hide exactly that mistake.
 */
const keyMode = (gatewayKey, secret) => {
  const value = String(secret || '');
  if (gatewayKey === 'flutterwave') {
    if (/^FLWSECK_TEST/i.test(value)) return 'test';
    if (/^FLWSECK/i.test(value)) return 'live';
    return 'unknown';
  }
  // Paystack and Stripe both use sk_test_ / sk_live_.
  if (/^sk_test_/.test(value)) return 'test';
  if (/^sk_live_/.test(value)) return 'live';
  return 'unknown';
};

/**
 * Each gateway's cheapest AUTHENTICATED read.
 *
 * Read-only by design: a credential check must not create a charge, a customer
 * or a payment intent. These endpoints only answer "is this secret key real",
 * which is the entire question the Test button asks.
 */
const PROBES = {
  paystack: { url: 'https://api.paystack.co/balance', label: 'Paystack' },
  flutterwave: { url: 'https://api.flutterwave.com/v3/subaccounts?page=1', label: 'Flutterwave' },
  stripe: { url: 'https://api.stripe.com/v1/balance', label: 'Stripe' },
};

const PROBE_TIMEOUT_MS = Number(process.env.PAYMENT_PROBE_TIMEOUT_MS || 8000);

/**
 * Asks the gateway whether a secret key is valid.
 *
 * Returns { ok, status, message } and never throws — a gateway being down,
 * slow or unreachable is a normal outcome of pressing Test, not a 500. The
 * secret itself is never echoed back, only whether it worked and in which
 * environment.
 */
const checkCredentials = async (gatewayKey, secret) => {
  const probe = PROBES[gatewayKey];
  const label = probe?.label || gatewayKey;
  const mode = keyMode(gatewayKey, secret);
  const modeSuffix = mode === 'unknown' ? '' : ` (${mode} mode)`;

  let response;
  try {
    response = await fetch(probe.url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    // Timeout, DNS failure, no outbound network from this host.
    const reason = error.name === 'TimeoutError'
      ? `did not respond within ${Math.round(PROBE_TIMEOUT_MS / 1000)}s`
      : `could not be reached (${error.message})`;
    return { ok: false, status: 504, message: `${label} ${reason}. The key was not verified.` };
  }

  if (response.ok) {
    return { ok: true, status: 200, message: `${label} credentials are valid${modeSuffix}.` };
  }

  // 401/403 means the key itself is wrong — the one answer worth being precise
  // about, since everything else is the gateway having a bad day.
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      status: 400,
      message: `${label} rejected the secret key${modeSuffix}. Check the value saved in Payment Gateways.`,
    };
  }

  const detail = await response.text().then(
    (body) => {
      try { const j = JSON.parse(body); return j.message || j.error?.message || ''; } catch { return ''; }
    },
    () => '',
  );
  return {
    ok: false,
    status: 502,
    message: `${label} returned ${response.status}${detail ? `: ${detail}` : ''}. The key was not verified.`,
  };
};

module.exports = { GATEWAYS, byKey, paymentSettingsFor, keyMode, checkCredentials, PROBES };

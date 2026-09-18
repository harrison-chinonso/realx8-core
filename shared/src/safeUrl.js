/**
 * The URLs this application will store and later put in front of somebody.
 *
 * ── The one that mattered ────────────────────────────────────────────────────
 *
 * A buyer submits `document_url` with their proof of payment, and the admin
 * reviewing that payment opens it:
 *
 *   <a href={receipt.document_url} target="_blank" rel="noreferrer">
 *
 * Clicking it is not a lapse in judgement, it IS the workflow — an approver
 * cannot confirm a transfer they have not looked at. The field was a free
 * string: no scheme check, no host check, nothing between the buyer and an
 * administrator's browser. `javascript:` is still rendered by React 18 (the
 * warning landed in 16.9; blocking did not), and the session token sits in
 * localStorage where injected script can read it. A plain https:// link to a
 * convincing copy of the sign-in page is the version that needs no quirk at
 * all.
 *
 * ── Validated on the way IN ──────────────────────────────────────────────────
 *
 * At ingest rather than at render, because there are sixteen places that render
 * one of these and each new screen is another chance to forget. A value that
 * cannot be stored cannot be rendered by a screen written next year.
 *
 * ── What is allowed ──────────────────────────────────────────────────────────
 *
 * https only, and only hosts this deployment actually serves files from. Every
 * one of these fields is filled by the upload button, which returns a
 * Cloudinary URL — so the allow-list is what the uploader produces, not a
 * judgement about which parts of the internet are safe. UPLOAD_ALLOWED_HOSTS
 * widens it for a deployment that stores files elsewhere.
 *
 * Note what is NOT relied on: this is not a blocklist of dangerous schemes.
 * `javascript:`, `data:`, `vbscript:` and whatever the next one is are refused
 * because they are not `https:`, not because they were enumerated.
 */
const DEFAULT_HOSTS = ['res.cloudinary.com'];

const allowedHosts = () => {
  const configured = String(process.env.UPLOAD_ALLOWED_HOSTS || '')
    .split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
  return configured.length ? configured : DEFAULT_HOSTS;
};

/**
 * The URL, normalised — or null, which every caller must treat as a refusal.
 *
 * Returning null rather than throwing so each call site can phrase its own
 * message: what a buyer should be told about a proof of payment is not what a
 * realtor should be told about a KYC document.
 */
const safeUploadUrl = (raw) => {
  const value = String(raw ?? '').trim();
  if (!value) return null;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    // Not a URL at all — a bare path, a filename, or an attempt at something.
    return null;
  }

  if (parsed.protocol !== 'https:') return null;

  const host = parsed.hostname.toLowerCase();
  const allowed = allowedHosts().some((entry) => host === entry || host.endsWith(`.${entry}`));
  if (!allowed) return null;

  // Credentials in a URL (https://user:pass@host/) render as the host to a
  // reader and resolve somewhere else entirely in some clients.
  if (parsed.username || parsed.password) return null;

  return parsed.toString();
};

/** The sentence a caller shows when safeUploadUrl refuses. */
const UPLOAD_URL_MESSAGE = 'Attach the file with the upload button. A link typed in by hand '
  + 'is not accepted, because somebody else has to open it.';


/**
 * An https URL this server may fetch on a user's instruction.
 *
 * ── The hole it closes ───────────────────────────────────────────────────────
 *
 * POST /settings/sms/test takes `base_url` from the body and the provider
 * modules fetch it — the SmartSMS one with no path appended at all, so the URL
 * was entirely the caller's. The result comes back as an HTTP status and the
 * first 120 characters of the body, which makes it a reflected probe rather
 * than a blind one: an administrator of any tenant could map the internal
 * network from inside the perimeter, or read a cloud metadata endpoint.
 *
 * The permission it needs (settings.sms.manage) is a legitimate one for a
 * company administrator to hold. Holding it should not mean holding the
 * server's network position.
 *
 * ── What is checked ──────────────────────────────────────────────────────────
 *
 *   https only            — no file:, no gopher:, no http: to a plaintext hop
 *   no credentials        — https://real-host@169.254.169.254/ reads as the first
 *   not a private address — literals AND what the hostname actually resolves to
 *
 * The resolution check matters: `base_url=https://internal.attacker.test/` is
 * a public-looking name that can answer 127.0.0.1. Resolving first and refusing
 * on the ANSWER is what closes that, and it is why this is async.
 *
 * ── The residual, stated plainly ─────────────────────────────────────────────
 *
 * This is check-then-connect, so a name that answers publicly here and
 * privately a millisecond later (DNS rebinding) still gets through. Closing
 * that needs a custom agent that re-checks at socket level, which is a larger
 * change than this and not one to make blind. An allow-list of provider hosts
 * via SMS_ALLOWED_HOSTS closes it completely where a deployment knows its
 * providers, and is the recommended posture.
 */
const dns = require('dns').promises;
const net = require('net');

const PRIVATE_V4 = [
  [10, 0, 0, 0, 8], [127, 0, 0, 0, 8], [169, 254, 0, 0, 16],
  [172, 16, 0, 0, 12], [192, 168, 0, 0, 16], [100, 64, 0, 0, 10],
  [192, 0, 0, 0, 24], [198, 18, 0, 0, 15], [0, 0, 0, 0, 8],
];

const v4ToInt = (address) => address.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;

const isPrivateAddress = (address) => {
  if (net.isIPv4(address)) {
    const value = v4ToInt(address);
    return PRIVATE_V4.some(([a, b, c, d, bits]) => {
      const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
      return (value & mask) === (v4ToInt(`${a}.${b}.${c}.${d}`) & mask);
    });
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    // Unique-local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)) return true;
    // IPv4-mapped: ::ffff:169.254.169.254
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return false;
};

/**
 * Resolves and vets one outbound URL. `{ ok: true, url }` or
 * `{ ok: false, reason }` — a sentence fit to show the administrator.
 */
const checkOutboundUrl = async (raw, { allowedHosts = null } = {}) => {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: false, reason: 'No address was given.' };

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: `${value} is not a valid URL.` };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'The address must start with https://.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'A URL carrying a username or password is not accepted.' };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (Array.isArray(allowedHosts) && allowedHosts.length) {
    const permitted = allowedHosts.some((entry) => host === entry || host.endsWith(`.${entry}`));
    if (!permitted) {
      return { ok: false, reason: `${host} is not one of the allowed provider hosts.` };
    }
    return { ok: true, url: parsed.toString() };
  }

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    return { ok: false, reason: 'That address points inside this deployment.' };
  }

  if (net.isIP(host)) {
    if (isPrivateAddress(host)) return { ok: false, reason: 'That address is on a private network.' };
    return { ok: true, url: parsed.toString() };
  }

  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    return { ok: false, reason: `${host} could not be resolved.` };
  }
  if (!records.length) return { ok: false, reason: `${host} could not be resolved.` };
  if (records.some((record) => isPrivateAddress(record.address))) {
    return { ok: false, reason: `${host} resolves to an address on a private network.` };
  }

  return { ok: true, url: parsed.toString() };
};

/** The hosts an SMS provider base URL may point at, if a deployment names them. */
const smsAllowedHosts = () => String(process.env.SMS_ALLOWED_HOSTS || '')
  .split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);

module.exports = {
  safeUploadUrl, allowedHosts, UPLOAD_URL_MESSAGE,
  checkOutboundUrl, smsAllowedHosts, isPrivateAddress,
};

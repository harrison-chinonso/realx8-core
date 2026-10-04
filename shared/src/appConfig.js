const crypto = require('crypto');

/**
 * What the native app (Realx8-Mobile) needs to boot as a company, built from
 * settings the company already has.
 *
 * ── The contract ────────────────────────────────────────────────────────────
 *
 * Mirrored by Realx8-Mobile's src/tenant/types.ts. SCHEMA_VERSION goes up only
 * on a breaking change; the app refuses a version it does not know rather than
 * guessing. Adding an optional field is not a breaking change.
 *
 * ── What it may contain ─────────────────────────────────────────────────────
 *
 * The endpoint is public and keyed by a five-character code, so the answer is
 * held to what the branded sign-in page (/share/company/:code) already shows a
 * stranger: name, code and look, plus the support contacts /settings/support
 * already serves for a code, plus the `mobile` group. Every value is taken by
 * name from an allow-list and validated — a settings row added later can never
 * leak here by accident, and a malformed one is dropped rather than shipped to
 * a phone that would have to cope with it.
 *
 * Which hosts the app's WebView may load is NOT a company setting: a company
 * admin able to add a host could open any page inside a branded app. It comes
 * from the platform's MOBILE_ALLOWED_HOSTS only.
 */
const SCHEMA_VERSION = 1;

// The sign-in page's brand (shareLinkController LOGIN_BRAND_KEYS) — keep in step.
const BRAND_KEYS = [
  'app_name', 'app_logo', 'primary_color', 'secondary_color', 'dark_primary_color',
  'font_heading', 'font_body', 'font_ui', 'font_family', 'app_tagline',
];

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const VERSION = /^\d{1,4}(?:\.\d{1,4}){0,2}$/;

const text = (value, max = 500) => {
  const trimmed = String(value ?? '').trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
};
const color = (value) => (HEX.test(String(value ?? '').trim()) ? String(value).trim() : null);
const version = (value) => (VERSION.test(String(value ?? '').trim()) ? String(value).trim() : null);
const flag = (value) => {
  const raw = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  return null;
};
/** Only absolute https URLs (or the API's own /uploads fallback) — a phone cannot load anything else. */
const imageUrl = (value) => {
  const raw = text(value, 2000);
  if (!raw) return null;
  if (raw.startsWith('/uploads/')) return raw;
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
};

const compareVersions = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
};

/**
 * The higher of two versions. A company may raise its own minimum above the
 * platform's — to force staff onto a fix — but never lower it below the
 * version the platform still supports.
 */
const higherVersion = (a, b) => {
  if (!a) return b || null;
  if (!b) return a;
  return compareVersions(a, b) >= 0 ? a : b;
};

/** Drop null/undefined members so the payload is only what is set. */
const compact = (object) => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== null && v !== undefined));

const allowedHosts = (raw = process.env.MOBILE_ALLOWED_HOSTS) => String(raw || '')
  .split(',')
  .map((host) => host.trim().toLowerCase())
  .filter((host) => /^[a-z0-9.-]+(?::\d+)?$/.test(host));

/**
 * @param company        { name, code } from companyByCode
 * @param appearance     merged appearance settings (platform, then company)
 * @param support        merged support settings
 * @param mobile         merged mobile settings
 * @param platformMobile platform-only mobile settings (for the version floor)
 */
const buildAppConfig = ({ company, appearance = {}, support = {}, mobile = {}, platformMobile = {}, hosts = allowedHosts() }) => {
  const branding = compact(Object.fromEntries(BRAND_KEYS.map((key) => {
    if (key.endsWith('_color')) return [key, color(appearance[key])];
    if (key === 'app_logo') return [key, imageUrl(appearance[key])];
    return [key, text(appearance[key], 200)];
  })));

  const features = compact({
    googleLogin: flag(mobile.feature_google_login),
    biometrics: flag(mobile.feature_biometrics),
  });

  const mobileBlock = compact({
    splash_bg: color(mobile.splash_bg),
    splash_logo: imageUrl(mobile.splash_logo),
    min_app_version: higherVersion(version(platformMobile.min_app_version), version(mobile.min_app_version)),
    latest_app_version: version(mobile.latest_app_version),
    update_message: text(mobile.update_message, 300),
    features: Object.keys(features).length ? features : null,
  });

  const supportBlock = compact({
    email: text(support.support_email, 200),
    phone: text(support.support_phone, 50),
    whatsapp: text(support.support_whatsapp, 50),
  });

  const body = compact({
    company: { name: company.name, code: company.code },
    branding,
    support: Object.keys(supportBlock).length ? supportBlock : null,
    mobile: Object.keys(mobileBlock).length ? mobileBlock : null,
    web: hosts.length ? { allowedHosts: hosts } : null,
  });

  // Content-addressed, so the version (and the ETag made from it) changes
  // exactly when something a phone would render changes.
  const configVersion = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
  return { schemaVersion: SCHEMA_VERSION, configVersion, ...body };
};

module.exports = { buildAppConfig, SCHEMA_VERSION, BRAND_KEYS, allowedHosts, higherVersion };

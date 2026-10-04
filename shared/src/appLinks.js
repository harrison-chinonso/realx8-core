/**
 * The two files that let https://<web>/c/<CODE> open Realx8-Mobile instead of
 * the browser — iOS universal links and Android App Links.
 *
 * Each platform fetches a file from the web host's /.well-known/ and only
 * hands a link to an app the file names. They are built here rather than kept
 * as static files on the web host because what they name is deployment
 * configuration — the Apple team, every white-label bundle id, every signing
 * key — and each new company app would otherwise be an edit to the web repo.
 * The web host forwards /.well-known/ to these (Realx8-Ui vercel.json).
 *
 *   iOS      APPLE_TEAM_ID + APPLE_CLIENT_IDS (the bundle ids, as for Sign in with Apple)
 *   Android  SECURITY_MOBILE_APP_PACKAGES (the package names, as for the tool filter)
 *            + ANDROID_CERT_SHA256: signing-key fingerprints, comma-separated. A bare
 *            fingerprint applies to every package; `package=FINGERPRINT` to one.
 *
 * Only /c/* is claimed — a company's link. Everything else on the web host
 * stays in the browser.
 */

const LINK_PATHS = ['/c/*'];

const csv = (value) => String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

const iosAppIds = (env = process.env) => {
  const team = String(env.APPLE_TEAM_ID || env.APNS_TEAM_ID || '').trim();
  if (!/^[A-Z0-9]{10}$/.test(team)) return [];
  return csv(env.APPLE_CLIENT_IDS || 'com.realx8.app').map((bundle) => `${team}.${bundle}`);
};

/** apple-app-site-association, or null when no team is configured. */
const appleAppSiteAssociation = (env = process.env) => {
  const appIDs = iosAppIds(env);
  if (!appIDs.length) return null;
  return {
    applinks: {
      details: [{ appIDs, components: LINK_PATHS.map((path) => ({ '/': path, comment: 'A company link' })) }],
    },
  };
};

/** assetlinks.json, or null when no signing key is configured. */
const androidAssetLinks = (env = process.env) => {
  const packages = csv(env.SECURITY_MOBILE_APP_PACKAGES || 'com.realx8.app');
  const shared = [];
  const perPackage = {};
  csv(env.ANDROID_CERT_SHA256).forEach((entry) => {
    const [maybePackage, maybePrint] = entry.includes('=') ? entry.split('=') : [null, entry];
    const print = String(maybePrint || '').trim().toUpperCase();
    if (!FINGERPRINT.test(print)) return;
    if (maybePackage) (perPackage[maybePackage.trim()] ||= []).push(print);
    else shared.push(print);
  });

  const statements = packages
    .map((pkg) => ({ pkg, prints: [...new Set([...shared, ...(perPackage[pkg] || [])])] }))
    .filter(({ prints }) => prints.length)
    .map(({ pkg, prints }) => ({
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: prints },
    }));
  return statements.length ? statements : null;
};

module.exports = { appleAppSiteAssociation, androidAssetLinks, LINK_PATHS };

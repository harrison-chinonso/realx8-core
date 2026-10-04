const test = require('node:test');
const assert = require('node:assert');
const { appleAppSiteAssociation, androidAssetLinks } = require('../../shared/src/appLinks');

const A = Array(32).fill('AB').join(':');
const B = Array(32).fill('cd').join(':');

test('iOS: one app id per bundle, claiming only company links', () => {
  const doc = appleAppSiteAssociation({ APPLE_TEAM_ID: 'TEAM123456', APPLE_CLIENT_IDS: 'com.realx8.app, com.realx8.acme' });
  assert.deepStrictEqual(doc.applinks.details[0].appIDs, ['TEAM123456.com.realx8.app', 'TEAM123456.com.realx8.acme']);
  assert.deepStrictEqual(doc.applinks.details[0].components.map((c) => c['/']), ['/c/*']);
});

test('iOS: nothing without a valid team id', () => {
  assert.strictEqual(appleAppSiteAssociation({}), null);
  assert.strictEqual(appleAppSiteAssociation({ APPLE_TEAM_ID: 'not-a-team' }), null);
});

test('iOS: the push team id is the same team', () => {
  assert.ok(appleAppSiteAssociation({ APNS_TEAM_ID: 'TEAM123456' }));
});

test('Android: a bare fingerprint covers every package; package=print covers one', () => {
  const doc = androidAssetLinks({
    SECURITY_MOBILE_APP_PACKAGES: 'com.realx8.app,com.realx8.acme',
    ANDROID_CERT_SHA256: `${A}, com.realx8.acme=${B}`,
  });
  assert.deepStrictEqual(doc.map((s) => s.target.package_name), ['com.realx8.app', 'com.realx8.acme']);
  assert.deepStrictEqual(doc[0].target.sha256_cert_fingerprints, [A]);
  assert.deepStrictEqual(doc[1].target.sha256_cert_fingerprints, [A, B.toUpperCase()]);
  assert.deepStrictEqual(doc[0].relation, ['delegate_permission/common.handle_all_urls']);
});

test('Android: malformed fingerprints are dropped, and nothing at all means null', () => {
  assert.strictEqual(androidAssetLinks({ ANDROID_CERT_SHA256: 'nonsense' }), null);
  assert.strictEqual(androidAssetLinks({}), null);
});

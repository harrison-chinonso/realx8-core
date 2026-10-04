const test = require('node:test');
const assert = require('node:assert');
const { buildAppConfig, SCHEMA_VERSION, allowedHosts, higherVersion } = require('../../shared/src/appConfig');

const company = { id: 7, name: 'Acme Homes', code: 'ABCDE' };

test('carries the company, its brand and the schema version', () => {
  const config = buildAppConfig({
    company,
    appearance: { app_name: 'Acme', primary_color: '#0A3D91', app_logo: 'https://res.cloudinary.com/x/logo.png' },
    hosts: [],
  });
  assert.strictEqual(config.schemaVersion, SCHEMA_VERSION);
  assert.deepStrictEqual(config.company, { name: 'Acme Homes', code: 'ABCDE' });
  assert.deepStrictEqual(config.branding, {
    app_name: 'Acme', primary_color: '#0A3D91', app_logo: 'https://res.cloudinary.com/x/logo.png',
  });
});

test('never leaks the company id or settings outside the allow-list', () => {
  const config = buildAppConfig({
    company,
    appearance: { app_name: 'Acme', smtp_password: 'secret', cloudinary_api_secret: 'secret' },
    support: { support_email: 'help@acme.test', support_internal_note: 'secret' },
    mobile: { api_key: 'secret' },
    hosts: [],
  });
  const json = JSON.stringify(config);
  assert.ok(!json.includes('secret'));
  assert.ok(!('id' in config.company));
  assert.deepStrictEqual(config.support, { email: 'help@acme.test' });
});

test('drops malformed values instead of shipping them to a phone', () => {
  const config = buildAppConfig({
    company,
    appearance: { primary_color: 'red; background:url(x)', app_logo: 'javascript:alert(1)' },
    mobile: { splash_bg: 'blue', splash_logo: 'http://insecure.test/a.png', min_app_version: '1.x', feature_biometrics: 'maybe' },
    hosts: [],
  });
  assert.deepStrictEqual(config.branding, {});
  assert.strictEqual(config.mobile, undefined);
});

test('reads the mobile group', () => {
  const config = buildAppConfig({
    company,
    mobile: {
      splash_bg: '#fff', splash_logo: '/uploads/logo.png', latest_app_version: '1.4.0',
      update_message: 'Please update.', feature_google_login: 'false', feature_biometrics: 'true',
    },
    hosts: [],
  });
  assert.deepStrictEqual(config.mobile, {
    splash_bg: '#fff',
    splash_logo: '/uploads/logo.png',
    latest_app_version: '1.4.0',
    update_message: 'Please update.',
    features: { googleLogin: false, biometrics: true },
  });
});

test('a company can raise the minimum app version but not lower it below the platform floor', () => {
  const raised = buildAppConfig({ company, mobile: { min_app_version: '1.5.0' }, platformMobile: { min_app_version: '1.2.0' }, hosts: [] });
  assert.strictEqual(raised.mobile.min_app_version, '1.5.0');
  const lowered = buildAppConfig({ company, mobile: { min_app_version: '1.0.0' }, platformMobile: { min_app_version: '1.2.0' }, hosts: [] });
  assert.strictEqual(lowered.mobile.min_app_version, '1.2.0');
  assert.strictEqual(higherVersion('1.10.0', '1.9.9'), '1.10.0');
  assert.strictEqual(higherVersion(null, null), null);
});

test('allowed hosts come only from the platform env, never from company settings', () => {
  const config = buildAppConfig({ company, mobile: { allowed_hosts: 'evil.test' }, hosts: [] });
  assert.strictEqual(config.web, undefined);
  assert.deepStrictEqual(allowedHosts(' app.realx8.com, res.cloudinary.com ,bad host'), ['app.realx8.com', 'res.cloudinary.com']);
});

test('configVersion changes exactly when the content does', () => {
  const a = buildAppConfig({ company, appearance: { primary_color: '#111111' }, hosts: [] });
  const b = buildAppConfig({ company, appearance: { primary_color: '#111111' }, hosts: [] });
  const c = buildAppConfig({ company, appearance: { primary_color: '#222222' }, hosts: [] });
  assert.strictEqual(a.configVersion, b.configVersion);
  assert.notStrictEqual(a.configVersion, c.configVersion);
});

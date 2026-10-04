const test = require('node:test');
const assert = require('node:assert');
const { withCompanyIdentity } = require('../../shared/src/appearanceSettings');

const fakeDb = (record) => ({ query: async () => (record ? [record] : []) });
const platform = { app_name: 'Realx8', app_logo: 'https://x.test/realx8.png', primary_color: '#111111' };

test("a company that set nothing shows its own name and logo, never the platform's", async () => {
  const out = await withCompanyIdentity(fakeDb({ name: 'Acme Homes', logo_url: 'https://x.test/acme.png' }), 'appearance', 7, platform, {});
  assert.strictEqual(out.app_name, 'Acme Homes');
  assert.strictEqual(out.app_logo, 'https://x.test/acme.png');
  assert.strictEqual(out.primary_color, '#111111', 'colours still inherit');
});

test('a company without a logo gets none rather than the platform logo', async () => {
  const out = await withCompanyIdentity(fakeDb({ name: 'Acme Homes', logo_url: null }), 'appearance', 7, platform, {});
  assert.strictEqual(out.app_logo, null);
});

test("the company's own Appearance settings win over its record", async () => {
  const out = await withCompanyIdentity(fakeDb({ name: 'Acme Homes Ltd', logo_url: 'a' }), 'appearance', 7, platform, { app_name: 'Acme', app_logo: 'b' });
  assert.deepStrictEqual([out.app_name, out.app_logo], ['Acme', 'b']);
});

test('the platform itself, other groups and unknown companies keep the plain merge', async () => {
  assert.strictEqual((await withCompanyIdentity(fakeDb(null), 'appearance', null, platform, {})).app_name, 'Realx8');
  assert.strictEqual((await withCompanyIdentity(fakeDb({ name: 'Acme' }), 'support', 7, { app_name: 'X' }, {})).app_name, 'X');
  assert.strictEqual((await withCompanyIdentity(fakeDb(null), 'appearance', 99, platform, {})).app_name, 'Realx8');
});

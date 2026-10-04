const test = require('node:test');
const assert = require('node:assert');
const { withinPin, pinRefusal, resolvePin } = require('../../shared/src/companyPin');

const pin = { company: { id: 7, name: 'Acme Homes', code: 'ABCDE' }, invalid: false };

test('nothing pinned lets every account through', () => {
  assert.ok(withinPin({ company: null }, { company_id: 3 }));
  assert.ok(withinPin(undefined, { company_id: 3 }));
});

test('pinned keeps only that company', () => {
  assert.ok(withinPin(pin, { company_id: 7 }));
  assert.ok(withinPin(pin, { company_id: '7' }));
  assert.ok(!withinPin(pin, { company_id: 8 }));
  assert.ok(!withinPin(pin, { company_id: null }));
});

test('the refusal names the company, or says it is gone', () => {
  assert.strictEqual(pinRefusal(pin).reason, 'company_pinned');
  assert.match(pinRefusal(pin).message, /Acme Homes/);
  assert.strictEqual(pinRefusal({ company: null, invalid: true }).reason, 'company_unavailable');
});

test('no code means nothing pinned, without touching the database', async () => {
  assert.deepStrictEqual(await resolvePin(null, ''), { company: null, invalid: false });
  assert.deepStrictEqual(await resolvePin(null, undefined), { company: null, invalid: false });
});

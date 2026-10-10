const test = require('node:test');
const assert = require('node:assert');

delete process.env.REDIS_URL;
const billing = require('../../shared/src/billing');

const DAY = billing.DAY_MS;
const at = (base, days) => new Date(base.getTime() + days * DAY);
const NOW = new Date('2026-10-10T12:00:00Z');

test('state is worked out from the dates: trial, active, grace, lapsed', () => {
  const trial = { status: 'trialing', trial_ends_at: at(NOW, 2) };
  assert.equal(billing.effectiveState(trial, NOW).status, 'trialing');
  assert.equal(billing.effectiveState(trial, at(NOW, 3)).status, 'grace');
  assert.equal(billing.effectiveState(trial, at(NOW, 5.1)).status, 'lapsed');
  assert.equal(billing.effectiveState(trial, at(NOW, 5.1)).readOnly, true);

  const paid = { status: 'active', current_period_end: at(NOW, 10) };
  assert.equal(billing.effectiveState(paid, NOW).status, 'active');
  assert.equal(billing.effectiveState(paid, at(NOW, 11)).status, 'grace');
  assert.equal(billing.effectiveState(paid, at(NOW, 11)).readOnly, false, 'grace is still usable');
  assert.equal(billing.effectiveState(paid, at(NOW, 13.5)).status, 'lapsed');

  assert.equal(billing.effectiveState(null, NOW).status, 'none');
  assert.equal(billing.effectiveState(null, NOW).readOnly, false, 'no row never locks a company out');
});

test('a lapsed company may still read everything', () => {
  for (const user of [{ type: 'admin', id: 1 }, { type: 'client', id: 2 }]) {
    assert.ok(billing.allowedWhileLapsed({ method: 'GET', path: '/finance/invoices', user }));
  }
});

test('clients can still buy and upload proof of payment; nothing else', () => {
  const client = { type: 'client', id: 7 };
  for (const [method, path] of [
    ['POST', '/properties/12/checkout'], ['POST', '/purchase-requests'], ['POST', '/media/upload'],
    ['POST', '/invoices/5/receipts'], ['PUT', '/receipts/9'], ['POST', '/receipts/9/cancel'],
  ]) assert.ok(billing.allowedWhileLapsed({ method, path, user: client }), `${method} ${path}`);
  assert.equal(billing.allowedWhileLapsed({ method: 'POST', path: '/properties', user: client }), false);
  assert.equal(billing.allowedWhileLapsed({ method: 'POST', path: '/share/token', user: client }), false);
});

test('realtors can still recommend', () => {
  const realtor = { type: 'realtor', id: 3 };
  for (const [method, path] of [['POST', '/share/token'], ['POST', '/properties/4/share-link'], ['POST', '/leads']]) {
    assert.ok(billing.allowedWhileLapsed({ method, path, user: realtor }), `${method} ${path}`);
  }
  assert.equal(billing.allowedWhileLapsed({ method: 'POST', path: '/commission-payouts', user: realtor }), false);
});

test('admins can do nothing but pay; everyone can sign in, read alerts and edit only their own profile', () => {
  const admin = { type: 'super_admin', id: 1 };
  assert.equal(billing.allowedWhileLapsed({ method: 'POST', path: '/properties', user: admin }), false);
  assert.equal(billing.allowedWhileLapsed({ method: 'PUT', path: '/receipts/9/approve', user: admin }), false);
  assert.equal(billing.allowedWhileLapsed({ method: 'POST', path: '/properties/12/checkout', user: admin }), false);
  assert.ok(billing.allowedWhileLapsed({ method: 'POST', path: '/billing/checkout', user: admin }));
  assert.ok(billing.allowedWhileLapsed({ method: 'POST', path: '/auth/logout', user: admin }));
  assert.ok(billing.allowedWhileLapsed({ method: 'PUT', path: '/notifications/read-all', user: admin }));
  assert.ok(billing.allowedWhileLapsed({ method: 'PUT', path: '/users/1', user: admin }));
  assert.equal(billing.allowedWhileLapsed({ method: 'PUT', path: '/users/2', user: admin }), false, 'not someone else');
});

test('with BILLING_ENABLED off nothing is limited or locked', async () => {
  delete process.env.BILLING_ENABLED;
  assert.equal(billing.isBillingEnabled(), false);
  const db = { query: async () => { throw new Error('must not touch the database'); } };
  assert.deepEqual(await billing.canAdmitMember(db, 1), { admit: true });
  assert.equal((await billing.billingState(db, 1)).readOnly, false);
});

test('admission: lapsed → held, at the limit → held, trial → no limit', async () => {
  process.env.BILLING_ENABLED = 'true';
  try {
    const fakeDb = (sub, plan, members) => ({
      query: async (sql) => {
        if (/FROM company_subscriptions/.test(sql)) return sub ? [sub] : [];
        if (/FROM billing_plans/.test(sql)) return plan ? [plan] : [];
        if (/COUNT\(\*\)/.test(sql)) return [{ n: members }];
        return [];
      },
    });
    const starter = { code: 'starter', name: 'Starter', monthly_price: 50000, annual_price: 500000, user_limit: 100, active: 1 };
    const future = at(new Date(), 10);
    const past = at(new Date(), -10);

    assert.equal((await billing.canAdmitMember(fakeDb({ status: 'active', plan_code: 'starter', current_period_end: future }, starter, 99), 1)).admit, true);
    const full = await billing.canAdmitMember(fakeDb({ status: 'active', plan_code: 'starter', current_period_end: future }, starter, 100), 1);
    assert.deepEqual([full.admit, full.reason], [false, 'limit']);
    const lapsed = await billing.canAdmitMember(fakeDb({ status: 'active', plan_code: 'starter', current_period_end: past }, starter, 1), 1);
    assert.deepEqual([lapsed.admit, lapsed.reason], [false, 'lapsed']);
    assert.equal((await billing.canAdmitMember(fakeDb({ status: 'trialing', trial_ends_at: future }, null, 5000), 1)).admit, true);
  } finally {
    delete process.env.BILLING_ENABLED;
  }
});

test('the seeded plans match the published prices', () => {
  const byCode = Object.fromEntries(billing.SEED_PLANS.map((p) => [p.code, p]));
  assert.deepEqual([byCode.starter.monthly_price, byCode.starter.annual_price, byCode.starter.user_limit], [50000, 500000, 100]);
  assert.deepEqual([byCode.professional.monthly_price, byCode.professional.annual_price, byCode.professional.user_limit], [75000, 750000, 250]);
  assert.deepEqual([byCode.enterprise.monthly_price, byCode.enterprise.annual_price, byCode.enterprise.user_limit], [100000, 1000000, null]);
});

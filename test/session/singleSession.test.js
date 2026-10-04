const test = require('node:test');
const assert = require('node:assert');

delete process.env.REDIS_URL;
delete process.env.SINGLE_SESSION_ENABLED;
const registry = require('../../shared/src/sessionRegistry');

const PHONE = 'phone-device-0000000001';
const LAPTOP = 'laptop-device-000000002';
let nextUser = 1000;
const freshUser = () => { nextUser += 1; return nextUser; };

test('on by default', () => {
  assert.strictEqual(registry.isEnabled(), true);
});

test('a second device is refused while the first session is live', async () => {
  const user = freshUser();
  await registry.startSession(user, { sid: 's-phone', device: PHONE });
  const verdict = await registry.canSignIn(user, { device: LAPTOP });
  assert.strictEqual(verdict.allowed, false);
});

test('a sign-in with no device id counts as a different device', async () => {
  const user = freshUser();
  await registry.startSession(user, { sid: 's-phone', device: PHONE });
  assert.strictEqual((await registry.canSignIn(user, {})).allowed, false);
});

test('the same device signing in again replaces its own session', async () => {
  const user = freshUser();
  await registry.startSession(user, { sid: 's-old', device: PHONE });
  const verdict = await registry.canSignIn(user, { device: PHONE });
  assert.deepStrictEqual([verdict.allowed, verdict.sameDevice], [true, true]);
});

test('a refresh without the device keeps the device recorded at sign-in', async () => {
  const user = freshUser();
  await registry.startSession(user, { sid: 's1', device: PHONE });
  await registry.startSession(user, { sid: 's1' });
  assert.strictEqual((await registry.activeSession(user)).device, PHONE);
});

test("signing out a stale session does not end another device's live one", async () => {
  const user = freshUser();
  await registry.startSession(user, { sid: 'live', device: PHONE });
  await registry.endSession(user, 'stale');
  assert.ok(await registry.activeSession(user), 'live session survives');
  assert.strictEqual((await registry.canSignIn(user, { device: LAPTOP })).allowed, false);
  await registry.endSession(user, 'live');
  assert.strictEqual(await registry.activeSession(user), null);
  assert.strictEqual((await registry.canSignIn(user, { device: LAPTOP })).allowed, true);
});

test('the older session reads as superseded once replaced', async () => {
  const user = freshUser();
  await registry.startSession(user, { sid: 'new', device: PHONE });
  const state = await registry.sessionState(user, 'old');
  assert.deepStrictEqual([state.valid, state.reason], [false, 'superseded']);
});

test('device ids are validated', () => {
  assert.strictEqual(registry.cleanDeviceId('short'), null);
  assert.strictEqual(registry.cleanDeviceId('has spaces in it here!!'), null);
  assert.strictEqual(registry.cleanDeviceId('6f1c2a9e-4b7d-4c1e-9a3f-2d8e7b6c5a41'), '6f1c2a9e-4b7d-4c1e-9a3f-2d8e7b6c5a41');
  assert.strictEqual(registry.deviceIdOf({ body: { device_id: PHONE } }), PHONE);
  assert.strictEqual(registry.deviceIdOf(null), null);
});

test('can be switched off', async () => {
  process.env.SINGLE_SESSION_ENABLED = 'false';
  try {
    const user = freshUser();
    await registry.startSession(user, { sid: 's', device: PHONE });
    assert.strictEqual((await registry.canSignIn(user, { device: LAPTOP })).allowed, true);
  } finally {
    delete process.env.SINGLE_SESSION_ENABLED;
  }
});

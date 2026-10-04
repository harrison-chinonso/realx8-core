const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FCM_SERVICE_ACCOUNT = Buffer.from(JSON.stringify({
  project_id: 'realx8-test',
  client_email: 'push@realx8-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
})).toString('base64');
delete process.env.APNS_KEY;

const { pushToDevices, nativePushStatus } = require('../../shared/src/nativePush');

/** Just enough of sequelize: SELECT returns the devices, writes are recorded. */
const fakeDb = (devices) => {
  const writes = [];
  return {
    writes,
    getDialect: () => 'mysql',
    options: { dialect: 'mysql' },
    query: async (sql, { replacements } = {}) => {
      if (/^\s*SELECT/i.test(sql)) return devices;
      writes.push({ sql: sql.trim().split(/\s+/)[0].toUpperCase(), id: replacements?.id });
      return [[], 1];
    },
  };
};

const withFetch = async (handler, fn) => {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => { calls.push({ url: String(url), init }); return handler(String(url), init); };
  try { return await fn(calls); } finally { global.fetch = original; }
};
const json = (status, body) => ({ ok: status < 300, status, json: async () => body });

test('reports which platforms are configured', () => {
  assert.deepStrictEqual(nativePushStatus(), { android: true, ios: false });
});

test('sends to Android through FCM v1, keeps live tokens and deletes dead ones', async () => {
  const db = fakeDb([
    { id: 1, platform: 'android', token: 'live-token' },
    { id: 2, platform: 'android', token: 'dead-token' },
    { id: 3, platform: 'ios', token: 'abc', app_id: 'com.realx8.app' }, // no APNs key: skipped
  ]);

  await withFetch((url, init) => {
    if (url.includes('oauth2')) return json(200, { access_token: 'ya29.test', expires_in: 3600 });
    const { message } = JSON.parse(init.body);
    if (message.token === 'dead-token') {
      return json(404, { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } });
    }
    return json(200, { name: 'projects/realx8-test/messages/1' });
  }, async (calls) => {
    const result = await pushToDevices(db, {
      userId: 9, title: 'Payment approved', body: 'Line one\nline two', url: '/payments/4', tag: 'payment:9', data: { id: 4 },
    });
    assert.deepStrictEqual(result, { sent: 1, failed: 0, removed: 1 });

    const send = calls.find((c) => c.url.includes('fcm.googleapis.com'));
    assert.ok(send.url.endsWith('/v1/projects/realx8-test/messages:send'));
    assert.strictEqual(send.init.headers.Authorization, 'Bearer ya29.test');
    const { message } = JSON.parse(send.init.body);
    assert.strictEqual(message.notification.title, 'Payment approved');
    assert.strictEqual(message.notification.body, 'Line one line two');
    assert.deepStrictEqual(message.data, { url: '/payments/4', id: '4' }, 'FCM data values are strings');
    assert.strictEqual(message.android.notification.tag, 'payment:9');
  });

  assert.deepStrictEqual(db.writes, [{ sql: 'UPDATE', id: 1 }, { sql: 'DELETE', id: 2 }]);
});

test('a transient FCM failure is counted, not deleted', async () => {
  const db = fakeDb([{ id: 5, platform: 'android', token: 't' }]);
  await withFetch((url) => (url.includes('oauth2')
    ? json(200, { access_token: 'x', expires_in: 3600 })
    : json(503, { error: { status: 'UNAVAILABLE' } })), async () => {
    assert.deepStrictEqual(await pushToDevices(db, { userId: 1, title: 't', body: 'b' }), { sent: 0, failed: 1, removed: 0 });
  });
  assert.deepStrictEqual(db.writes, [{ sql: 'UPDATE', id: 5 }]);
});

test('nobody registered means no calls at all', async () => {
  await withFetch(() => { throw new Error('should not be called'); }, async (calls) => {
    assert.deepStrictEqual(await pushToDevices(fakeDb([]), { userId: 1, title: 't', body: 'b' }), { sent: 0, failed: 0, removed: 0 });
    assert.strictEqual(calls.length, 0);
  });
});

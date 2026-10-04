const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
process.env.APPLE_TEAM_ID = 'TEAM123456';
process.env.APPLE_SIGNIN_KEY_ID = 'KEY1234567';
process.env.APPLE_SIGNIN_KEY = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');

const {
  clientSecret, exchangeAuthorizationCode, revokeRefreshToken, isConfigured, APPLE_AUDIENCE,
} = require('../../shared/src/appleTokens');

const withFetch = async (handler, fn) => {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => { calls.push({ url: String(url), body: Object.fromEntries(new URLSearchParams(String(init.body))) }); return handler(String(url)); };
  try { return await fn(calls); } finally { global.fetch = original; }
};
const respond = (status, body = {}) => ({ ok: status < 300, status, json: async () => body });

test('the client secret is the ES256 JWT Apple asks for', () => {
  assert.ok(isConfigured());
  const secret = clientSecret('com.realx8.app');
  const { header, payload } = jwt.decode(secret, { complete: true });
  assert.strictEqual(header.alg, 'ES256');
  assert.strictEqual(header.kid, 'KEY1234567');
  assert.strictEqual(payload.iss, 'TEAM123456');
  assert.strictEqual(payload.sub, 'com.realx8.app');
  assert.strictEqual(payload.aud, APPLE_AUDIENCE);
  assert.ok(payload.exp - payload.iat <= 300, 'short-lived');
  jwt.verify(secret, publicKey, { algorithms: ['ES256'] });
});

test('an authorisation code is exchanged for a refresh token', async () => {
  await withFetch(() => respond(200, { refresh_token: 'r.123', access_token: 'a' }), async (calls) => {
    assert.strictEqual(await exchangeAuthorizationCode({ code: 'c.abc', clientId: 'com.realx8.app' }), 'r.123');
    assert.strictEqual(calls[0].url, 'https://appleid.apple.com/auth/token');
    assert.strictEqual(calls[0].body.grant_type, 'authorization_code');
    assert.strictEqual(calls[0].body.code, 'c.abc');
    assert.strictEqual(calls[0].body.client_id, 'com.realx8.app');
  });
});

test('a refused exchange is null, never an exception', async () => {
  await withFetch(() => respond(400, { error: 'invalid_grant' }), async () => {
    assert.strictEqual(await exchangeAuthorizationCode({ code: 'used', clientId: 'com.realx8.app' }), null);
  });
  await withFetch(() => { throw new Error('offline'); }, async () => {
    assert.strictEqual(await exchangeAuthorizationCode({ code: 'c', clientId: 'com.realx8.app' }), null);
  });
});

test('revoking sends the refresh token to /auth/revoke', async () => {
  await withFetch(() => respond(200), async (calls) => {
    assert.strictEqual(await revokeRefreshToken({ refreshToken: 'r.123', clientId: 'com.realx8.app' }), 'revoked');
    assert.strictEqual(calls[0].url, 'https://appleid.apple.com/auth/revoke');
    assert.strictEqual(calls[0].body.token, 'r.123');
    assert.strictEqual(calls[0].body.token_type_hint, 'refresh_token');
  });
  await withFetch(() => respond(500), async () => {
    assert.strictEqual(await revokeRefreshToken({ refreshToken: 'r', clientId: 'com.realx8.app' }), 'failed');
  });
});

test('without credentials nothing is sent and it says so', async () => {
  const saved = process.env.APPLE_SIGNIN_KEY;
  delete process.env.APPLE_SIGNIN_KEY;
  try {
    await withFetch(() => { throw new Error('must not be called'); }, async (calls) => {
      assert.strictEqual(await revokeRefreshToken({ refreshToken: 'r', clientId: 'x' }), 'not_configured');
      assert.strictEqual(await exchangeAuthorizationCode({ code: 'c', clientId: 'x' }), null);
      assert.strictEqual(calls.length, 0);
    });
  } finally { process.env.APPLE_SIGNIN_KEY = saved; }
});

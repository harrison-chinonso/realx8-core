const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { verifyAppleIdentityToken, setAppleKeysForTesting, APPLE_ISSUER } = require('../../shared/src/appleIdentity');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'RS256', use: 'sig' };
setAppleKeysForTesting([jwk]);

const rawNonce = 'raw-nonce-123';
const hashed = crypto.createHash('sha256').update(rawNonce).digest('hex');
const sign = (claims = {}, options = {}) => jwt.sign({
  sub: '001234.abcd', email: 'Ada@PrivateRelay.AppleID.com', email_verified: 'true', is_private_email: 'true',
  nonce: hashed, ...claims,
}, privateKey, {
  algorithm: 'RS256', keyid: 'test-kid', issuer: APPLE_ISSUER, audience: 'com.realx8.app', expiresIn: '10m', ...options,
});

test('a genuine token yields the subject and the verified address', async () => {
  const identity = await verifyAppleIdentityToken(sign(), rawNonce);
  assert.deepStrictEqual(identity, {
    sub: '001234.abcd',
    clientId: 'com.realx8.app',
    email: 'ada@privaterelay.appleid.com',
    emailVerified: true,
    isPrivateEmail: true,
  });
});

test('an unverified address is not taken as proof of the address', async () => {
  const identity = await verifyAppleIdentityToken(sign({ email_verified: false }), rawNonce);
  assert.strictEqual(identity.email, null);
});

const refuses = (label, token, nonce = rawNonce) => test(label, async () => {
  await assert.rejects(verifyAppleIdentityToken(token, nonce));
});

refuses('a token for another app is refused', sign({}, { audience: 'com.someone.else' }));
refuses('a token from another issuer is refused', sign({}, { issuer: 'https://evil.test' }));
refuses('an expired token is refused', sign({}, { expiresIn: -10 }));
refuses('a replayed token with a different nonce is refused', sign(), 'another-nonce');
refuses('a token signed by anyone but Apple is refused', jwt.sign({ sub: 'x', nonce: hashed }, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey, {
  algorithm: 'RS256', keyid: 'test-kid', issuer: APPLE_ISSUER, audience: 'com.realx8.app',
}));
refuses('no token at all is refused', undefined);

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { buildSignupState, readSignupState } = require('../../shared/src/oauthState');
const {
  createHandoff, redeemHandoff, isAllowedNativeRedirect, isChallenge,
} = require('../../shared/src/oauthHandoff');
const { detectAutomatedTool } = require('../../platform/security/automatedToolDetection');

const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('hex');
const codeOf = (url) => new URL(url).searchParams.get('handoff');

test('the signed state carries the native return address and challenge', () => {
  const state = buildSignupState({ nativeRedirect: 'realx8://auth/callback', nativeChallenge: challenge });
  assert.ok(state, 'a native-only sign-in still gets a state');
  const read = readSignupState(state);
  assert.strictEqual(read.native_redirect, 'realx8://auth/callback');
  assert.strictEqual(read.native_challenge, challenge);
});

test('a tampered state loses the native fields', () => {
  const state = buildSignupState({ nativeRedirect: 'realx8://auth/callback', nativeChallenge: challenge });
  const [payload, signature] = state.split('.');
  const body = JSON.parse(Buffer.from(payload, 'base64url').toString());
  body.n = 'evil://steal';
  const forged = `${Buffer.from(JSON.stringify(body)).toString('base64url')}.${signature}`;
  assert.strictEqual(readSignupState(forged).native_redirect, null);
});

test('only allow-listed return addresses and well-formed challenges are accepted', () => {
  assert.ok(isAllowedNativeRedirect('realx8://auth/callback'));
  assert.ok(!isAllowedNativeRedirect('realx8://auth/callback/../x'));
  assert.ok(!isAllowedNativeRedirect('https://evil.test/cb'));
  assert.ok(!isAllowedNativeRedirect(null));
  assert.ok(isChallenge(challenge));
  assert.ok(!isChallenge('abc'));
});

test('the app scheme receives a code, never the tokens', async () => {
  const url = await createHandoff({
    nativeRedirect: 'realx8://auth/callback', challenge, params: 'token=secret-access&refreshToken=secret-refresh',
  });
  assert.ok(url.startsWith('realx8://auth/callback?handoff='));
  assert.ok(!url.includes('secret'));
});

test('a code redeems once, and only with the right verifier', async () => {
  const params = 'token=a&refreshToken=b';
  const good = codeOf(await createHandoff({ nativeRedirect: 'realx8://auth/callback', challenge, params }));
  assert.strictEqual(await redeemHandoff(good, verifier), params);
  assert.strictEqual(await redeemHandoff(good, verifier), null, 'spent');

  const stolen = codeOf(await createHandoff({ nativeRedirect: 'realx8://auth/callback', challenge, params }));
  assert.strictEqual(await redeemHandoff(stolen, 'not-the-verifier'), null);
  assert.strictEqual(await redeemHandoff(stolen, verifier), null, 'a wrong guess spends the code');

  assert.strictEqual(await redeemHandoff('unknown', verifier), null);
  assert.strictEqual(await redeemHandoff(undefined, verifier), null);
});

const browserHeaders = (extra = {}) => ({
  headers: {
    'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36 Realx8App/1.0.0',
    accept: 'application/json',
    'accept-language': 'en',
    'accept-encoding': 'gzip',
    ...extra,
  },
  socket: { remoteAddress: '203.0.113.9' },
  ip: '203.0.113.9',
});

test('the Android WebView of an allow-listed app passes the tool filter', () => {
  assert.strictEqual(detectAutomatedTool(browserHeaders({ 'x-requested-with': 'com.realx8.app' })).blocked, false);
  assert.strictEqual(detectAutomatedTool(browserHeaders({ 'x-requested-with': 'XMLHttpRequest' })).blocked, false);
});

test('any other X-Requested-With is still refused', () => {
  assert.strictEqual(detectAutomatedTool(browserHeaders({ 'x-requested-with': 'com.evil.scraper' })).blocked, true);
});

test('the app id does not excuse a non-browser client', () => {
  const req = browserHeaders({ 'x-requested-with': 'com.realx8.app', 'user-agent': 'okhttp/4.12.0' });
  assert.strictEqual(detectAutomatedTool(req).blocked, true);
});

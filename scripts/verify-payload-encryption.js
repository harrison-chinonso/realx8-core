/**
 * Payload encryption end to end, over a real HTTP server.
 *
 * A standalone express app mounting the SAME middleware the services mount, so
 * this exercises the actual wire format rather than the crypto functions in
 * isolation.
 */
const express = require('express');
const CORE = require('path').join(__dirname, '..');
const jwt = require('jsonwebtoken');
const pc = require(`${CORE}/shared/src/payloadCrypto`);

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

process.env.PAYLOAD_ENCRYPTION_SECRET = 'test-secret-for-e2e';
const SECRET = 'jwt-test-secret';
process.env.JWT_SECRET = SECRET;

const start = (mode) => new Promise((resolve) => {
  process.env.PAYLOAD_ENCRYPTION_MODE = mode;
  delete require.cache[require.resolve(`${CORE}/platform/payloadCrypto`)];
  const { payloadCrypto } = require(`${CORE}/platform/payloadCrypto`);

  const app = express();
  app.use(express.json());
  app.use(payloadCrypto());
  app.post('/echo', (req, res) => res.json({ received: req.body, encrypted: Boolean(req.payloadWasEncrypted) }));
  app.get('/thing', (req, res) => res.json({ secret: 'unit 7B', price: 45000000 }));
  app.post('/auth/session-key', (req, res) => res.json({ ok: true }));
  app.post('/uploads/file', (req, res) => res.json({ skipped: true }));
  const server = app.listen(0, () => resolve({ server, port: server.address().port }));
});

const call = async (port, path, { body, sid, encrypt, optIn = true, method = 'POST' } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (sid !== undefined) headers.Authorization = `Bearer ${jwt.sign({ id: 1, sid }, SECRET)}`;
  if (optIn && encrypt) headers['X-Payload-Encryption'] = 'on';
  const key = pc.deriveKey(sid ?? null);
  const payload = body === undefined ? undefined : (encrypt ? pc.encrypt(body, key) : body);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  const raw = await res.json().catch(() => null);
  const wasEncrypted = res.headers.get('x-payload-encrypted') === '1';
  return {
    status: res.status,
    wasEncrypted,
    body: wasEncrypted && pc.isEnvelope(raw) ? pc.decrypt(raw, key) : raw,
    raw,
  };
};

(async () => {
  console.log('\n== mode=off: nothing changes =================================');
  let { server, port } = await start('off');
  let r = await call(port, '/echo', { body: { a: 1 }, encrypt: false });
  check('A plaintext request works and the reply is plaintext',
    r.status === 200 && r.body.received.a === 1 && !r.wasEncrypted, JSON.stringify(r.body));
  server.close();

  console.log('\n== mode=permissive: both kinds of client work ================');
  ({ server, port } = await start('permissive'));

  r = await call(port, '/echo', { body: { a: 1 }, encrypt: false, optIn: false });
  check('An OLD plaintext client still works',
    r.status === 200 && r.body.received.a === 1 && !r.wasEncrypted,
    'this is what makes the rollout safe in either order');

  r = await call(port, '/echo', { body: { unit: '7B', amount: 45000000 }, sid: 'sess-A', encrypt: true });
  check('An encrypted request round-trips',
    r.status === 200 && r.body.received.unit === '7B' && r.body.encrypted === true && r.wasEncrypted,
    JSON.stringify(r.body));

  // The wire must not carry the plaintext.
  const rawRes = await fetch(`http://127.0.0.1:${port}/thing`, {
    headers: {
      Authorization: `Bearer ${jwt.sign({ id: 1, sid: 'sess-A' }, SECRET)}`,
      'X-Payload-Encryption': 'on',
    },
  });
  const rawText = await rawRes.text();
  check('The response body on the wire contains no plaintext',
    !rawText.includes('unit 7B') && !rawText.includes('45000000') && rawText.includes('"tag"'),
    `${rawText.slice(0, 90)}...`);

  console.log('\n== Session isolation =========================================');
  const envelopeA = pc.encrypt({ x: 1 }, pc.deriveKey('sess-A'));
  const crossRes = await fetch(`http://127.0.0.1:${port}/echo`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Session B's token, session A's envelope.
      Authorization: `Bearer ${jwt.sign({ id: 2, sid: 'sess-B' }, SECRET)}`,
      'X-Payload-Encryption': 'on',
    },
    body: JSON.stringify(envelopeA),
  });
  const crossBody = await crossRes.json();
  check("One session's payload cannot be replayed into another",
    crossRes.status === 400 && crossBody.reason === 'payload_decryption_failed',
    `${crossRes.status} ${crossBody.reason}`);

  // Forging a sid gains nothing: the forger cannot compute that key.
  const forged = await fetch(`http://127.0.0.1:${port}/echo`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt.sign({ id: 9, sid: 'victim-session' }, 'wrong-signing-key')}`,
      'X-Payload-Encryption': 'on',
    },
    body: JSON.stringify(pc.encrypt({ x: 1 }, pc.deriveKey('attacker-guess'))),
  });
  check('Naming another session in the token does not help an attacker',
    forged.status === 400,
    `${forged.status} — the key is derived from a server secret, not from the token`);

  console.log('\n== Tampering =================================================');
  const good = pc.encrypt({ amount: 100 }, pc.deriveKey('sess-A'));
  const bytes = Buffer.from(good.data, 'base64'); bytes[0] ^= 0xff;
  const tamperRes = await fetch(`http://127.0.0.1:${port}/echo`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt.sign({ id: 1, sid: 'sess-A' }, SECRET)}`,
      'X-Payload-Encryption': 'on',
    },
    body: JSON.stringify({ ...good, data: bytes.toString('base64') }),
  });
  check('A tampered payload is refused, not silently accepted',
    tamperRes.status === 400, `${tamperRes.status} — the GCM tag catches it`);

  console.log('\n== Exemptions ================================================');
  r = await call(port, '/uploads/file', { body: { a: 1 }, sid: 'sess-A', encrypt: false, optIn: false });
  check('Upload routes are left alone', r.status === 200 && !r.wasEncrypted, JSON.stringify(r.body));

  const mp = await fetch(`http://127.0.0.1:${port}/echo`, {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=x', 'X-Payload-Encryption': 'on' },
    body: '--x--',
  });
  check('Multipart is skipped by content type as well as by path',
    mp.headers.get('x-payload-encrypted') !== '1', `encrypted-header=${mp.headers.get('x-payload-encrypted')}`);
  server.close();

  console.log('\n== mode=strict: plaintext is refused =========================');
  ({ server, port } = await start('strict'));

  r = await call(port, '/echo', { body: { a: 1 }, encrypt: false, optIn: false });
  check('A plaintext body is refused',
    r.status === 400 && r.body.reason === 'payload_encryption_required', `${r.status} ${r.body?.reason}`);

  r = await call(port, '/thing', { method: 'GET', sid: 'sess-A', encrypt: true });
  check('A GET, which has no body, is NOT refused',
    r.status === 200 && r.body.secret === 'unit 7B',
    'refusing bodyless reads would break every page for no benefit');

  r = await call(port, '/echo', { body: { a: 1 }, sid: 'sess-A', encrypt: true });
  check('An encrypted body is accepted', r.status === 200 && r.body.received.a === 1);

  r = await call(port, '/uploads/file', { body: { a: 1 }, encrypt: false, optIn: false });
  check('Exempt routes still work in strict mode',
    r.status === 200, `${r.status} — uploads must not be locked out`);
  server.close();

  console.log(`\n  ${pass}/${pass + fail} passed.\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ABORTED:', e); process.exit(1); });

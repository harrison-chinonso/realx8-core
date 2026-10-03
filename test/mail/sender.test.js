const test = require('node:test');
const assert = require('node:assert');
const { senderAddress, sendMail } = require('../../shared/src/mailTransport');
const { fallbackBrand } = require('../../shared/src/companySettings');

const withEnv = (value, fn) => {
  const saved = process.env.SMTP_FROM;
  if (value === undefined) delete process.env.SMTP_FROM; else process.env.SMTP_FROM = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.SMTP_FROM; else process.env.SMTP_FROM = saved;
  }
};

test('the configured From address wins', () => withEnv('env@example.org', () => {
  assert.strictEqual(senderAddress(' noreply@example.net '), 'noreply@example.net');
}));

test('an empty setting falls back to SMTP_FROM', () => withEnv('env@example.org', () => {
  assert.strictEqual(senderAddress(''), 'env@example.org');
  assert.strictEqual(senderAddress(null), 'env@example.org');
}));

test('no setting and no SMTP_FROM means no sender, never an invented one', () => withEnv(undefined, () => {
  assert.strictEqual(senderAddress(null), null);
  assert.strictEqual(fallbackBrand().fromAddress, null);
}));

test('nothing in the mail code falls back to a domain we do not own', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['shared/src/companySettings.js', 'shared/src/mailTransport.js', 'services/auth-service/src/controllers/authController.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
    assert.ok(!/noreply@realto\.app/.test(source), `${file} still hardcodes noreply@realto.app`);
  }
});

test('sendMail refuses a message without a sender before connecting', async () => {
  const result = await sendMail({
    host: 'smtp.invalid', port: 587, user: 'u', pass: 'p',
    message: { from: '"Realx8" <null>', to: 'a@example.org', subject: 's', text: 't' },
    label: 'test',
  });
  assert.deepStrictEqual(result, { sent: false, reason: 'no_sender_address' });
});

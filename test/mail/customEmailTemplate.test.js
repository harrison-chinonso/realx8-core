const test = require('node:test');
const assert = require('node:assert');
const { prepareTemplateHtml, renderCustomEmail, MAX_TEMPLATE_BYTES } = require('../../shared/src/customEmailTemplate');

test('a design without {{message}} is refused', () => {
  assert.throws(() => prepareTemplateHtml('<p>Hello {{name}}</p>'), (err) => err.status === 422 && /\{\{message\}\}/.test(err.message));
});

test('an empty or oversized design is refused', () => {
  assert.throws(() => prepareTemplateHtml('   '), (err) => err.status === 422);
  assert.throws(() => prepareTemplateHtml(`{{message}}${'x'.repeat(MAX_TEMPLATE_BYTES)}`), (err) => err.status === 422);
});

test('scripts, event handlers and javascript: links are removed', () => {
  const out = prepareTemplateHtml('<div onclick="steal()"><script>alert(1)</script><a href="javascript:evil()">x</a>{{ message }}</div>');
  assert.ok(!/script|onclick|javascript:/i.test(out), out);
  assert.ok(out.includes('{{ message }}'));
});

test('placeholders are filled and every value is escaped', () => {
  const html = renderCustomEmail(
    '<h1>{{title}}</h1><p>Hi {{first_name}} ({{name}})</p><div>{{message}}</div><img src="{{logo_url}}"> {{company_name}} {{year}} {{unknown}}',
    {
      title: 'Price <update>',
      message: 'Line one\nline two\n\nNew paragraph',
      name: '<b>Ada</b> Obi',
      brand: { name: 'Acme & Co', logo: 'https://x.test/l.png', year: 2026 },
    },
  );
  assert.ok(html.includes('<h1>Price &lt;update&gt;</h1>'));
  assert.ok(html.includes('Hi &lt;b&gt;Ada&lt;/b&gt; (&lt;b&gt;Ada&lt;/b&gt; Obi)'));
  assert.ok(html.includes('Line one<br/>line two<br/><br/>New paragraph'));
  assert.ok(html.includes('src="https://x.test/l.png"'));
  assert.ok(html.includes('Acme &amp; Co 2026'));
  assert.ok(html.includes('{{unknown}}'), 'unknown placeholders are left alone');
});

test('a $ in the message is inserted literally', () => {
  assert.strictEqual(renderCustomEmail('{{message}}', { message: 'Pay $& now $1' }), 'Pay $&amp; now $1');
});

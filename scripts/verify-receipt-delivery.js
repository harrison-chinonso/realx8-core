/**
 * The emailed receipt and the downloaded receipt are the same document.
 *
 * That is the whole claim, and it is the one thing a re-implementation would
 * quietly break. A buyer who forwards an emailed receipt to their employer and
 * then prints the one in the app must not end up with two pieces of paper that
 * disagree about the balance, the unit, or which company issued them — and the
 * only durable way to guarantee that is for both to come out of one function,
 * asserted here against the REAL renderer rather than against a copy of it.
 *
 * Also checked, because each has its own way of going wrong quietly:
 *
 *   the settings merge the branding comes from, since the notifier and the
 *   receipt mailer now share it and a regression there mis-brands every email
 *   the platform sends rather than only these;
 *
 *   the currency fallback, because a company that has never opened Appearance
 *   has no row at all and the amount on a receipt still has to be money;
 *
 *   escaping, because a client's name reaches the document as HTML;
 *
 *   and the failure modes, because a receipt that throws would take an
 *   approved payment down with it.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_receipt_delivery`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }

process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifyreceiptdelivery';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

/*
 * The transport is replaced BEFORE the mailer is loaded.
 *
 * receiptMail destructures sendMail at require time, so patching the module
 * afterwards would leave it holding the real one and this script would try to
 * post mail to whatever SMTP host cred.env happens to name.
 */
const transport = require('../shared/src/mailTransport');
const sent = [];
transport.sendMail = async ({ message }) => {
  sent.push(message);
  return { sent: true, messageId: 'verify', port: 587 };
};

(async () => {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  const { sequelize } = require('../services/finance-service/src/config/database');
  const userModels = require('../services/user-service/src/models');
  await userModels.Setting.sync({ force: true });
  // Companies matter now: a company's own NAME is what a receipt falls back to
  // when it has no app name of its own, so the row has to exist to be read.
  await userModels.Company.sync({ force: true });

  const { mergedSettings } = require('../shared/src/companySettings');
  const { formatMoneyFor } = require('../shared/src/moneyFormat');
  const { buildReceiptHtml } = require('../shared/src/receiptDocument');
  const { deliverReceipt } = require('../shared/src/receiptMail');

  const COMPANY = 7;
  /** A company that has never opened the Appearance screen. */
  const QUIET = 8;

  const set = (key, value, group, companyId = null) => userModels.Setting.create({
    key, value, group, company_id: companyId,
  });

  await userModels.Company.bulkCreate([
    { id: COMPANY, name: 'Acme Homes Ltd', slug: 'acme', email: 'hello@acme.test', referral_code: 'ACME1', status: 'active' },
    { id: QUIET, name: 'Quiet Developments', slug: 'quiet', email: 'hello@quiet.test', referral_code: 'QUIE1', status: 'active' },
  ]);

  // The platform's own branding, and one company that has overridden part of it.
  await set('app_name', 'Realx8', 'appearance', null);
  await set('app_logo', 'https://cdn.example.test/platform-mark.png', 'appearance', null);
  await set('primary_color', '#111111', 'appearance', null);
  await set('mail_host', 'smtp.example.test', 'email', null);
  await set('mail_username', 'platform', 'email', null);
  await set('mail_password', 'secret', 'email', null);
  await set('app_name', 'Acme Homes', 'appearance', COMPANY);
  await set('primary_color', '#0F172A', 'appearance', COMPANY);
  await set('currency', 'NGN', 'appearance', COMPANY);

  console.log('\n── The settings the branding comes from ─────────────────────────\n');

  const platformCfg = await mergedSettings(sequelize, null);
  const companyCfg = await mergedSettings(sequelize, COMPANY);
  check('The platform sees its own name', platformCfg.app_name === 'Realx8', platformCfg.app_name);
  check("A company's own name wins over the platform's",
    companyCfg.app_name === 'Acme Homes', companyCfg.app_name);
  check('...and it still inherits what it has not overridden',
    companyCfg.mail_host === 'smtp.example.test', companyCfg.mail_host);
  check('A company row never leaks onto the platform',
    platformCfg.currency === undefined, String(platformCfg.currency));

  console.log('\n── Money, including where nothing is configured ─────────────────\n');

  const companyMoney = await formatMoneyFor(sequelize, COMPANY);
  const platformMoney = await formatMoneyFor(sequelize, null);
  check('A company that chose the naira gets the naira',
    companyMoney(2500000).includes('₦'), companyMoney(2500000));
  check('A company that has never opened Appearance still gets the naira',
    platformMoney(2500000).includes('₦'), platformMoney(2500000));
  check('...thousand-separated, not a bare number',
    companyMoney(2500000).includes(','), companyMoney(2500000));

  console.log('\n── The document ────────────────────────────────────────────────\n');

  const receipt = {
    id: 41,
    receipt_number: 'RCPT-0041',
    amount: 2500000,
    verified_at: new Date('2026-03-04T10:00:00Z'),
    client_name: 'Ada <script>alert(1)</script>',
    client_email: 'ada@example.test',
    invoice_reference: 'INV-0009',
    payment_method: 'transfer',
    reference: 'TRF/2026/991',
    property_name: 'Lekki Gardens',
    property_address: '12 Admiralty Way',
    unit_label: '3-Bedroom Terrace',
    quantity: 2,
    unit_price: 4000000,
    outstanding_balance: 5500000,
    company_id: COMPANY,
  };

  const { brandForCompany } = require('../shared/src/companySettings');
  const { brand } = await brandForCompany(sequelize, COMPANY);
  const document = buildReceiptHtml(receipt, { brand, fmt: companyMoney });

  /*
   * The renderer the DOWNLOAD endpoint uses, called directly.
   *
   * Comparing the email against a document this script built itself would only
   * prove that this script and the mailer agree. The claim is about the app's
   * two routes out, so the controller's own renderer is the thing to compare.
   */
  const { renderReceiptDocument } = require('../services/finance-service/src/controllers/financeController');
  const downloaded = await renderReceiptDocument(receipt);

  check("The document is branded with the company's name, not the platform's",
    document.includes('Acme Homes') && !document.includes('Realx8'));
  check('GET /receipts/:id/document renders exactly this', downloaded === document);
  check('The amount is in the naira', document.includes('₦2,500,000'));
  check('The outstanding balance is on it', document.includes('₦5,500,000'));
  check('The unit reads as one line', document.includes('2 × 3-Bedroom Terrace'));
  check("A client's name cannot inject markup",
    document.includes('&lt;script&gt;') && !document.includes('<script>'));

  console.log('\n── A company that never set an app name ─────────────────────────\n');
  {
    /*
     * The reported fault: this company's customer received proof of payment
     * carrying the PLATFORM's name and the PLATFORM's logo, with nothing on it
     * connecting the document to the company they had actually paid.
     */
    const { brand: quiet } = await brandForCompany(sequelize, QUIET);
    check('It is named after itself, not the platform',
      quiet.name === 'Quiet Developments', quiet.name);
    check('...and carries no logo rather than the platform’s mark',
      quiet.logo === null, String(quiet.logo));
    check('A colour still falls back — a theme is not a claim about who sent it',
      quiet.primaryColor === '#111111', quiet.primaryColor);
    check('So does the mail server it sends through',
      quiet._smtpHost === 'smtp.example.test', quiet._smtpHost);
    check('The email it sends from is named after it too',
      quiet.fromName === 'Quiet Developments', quiet.fromName);

    const quietDoc = buildReceiptHtml(receipt, { brand: quiet, fmt: companyMoney });
    check('Its receipt says so on the document',
      quietDoc.includes('Quiet Developments') && !quietDoc.includes('Realx8'), '');
    check('...with no platform mark on it',
      !quietDoc.includes('platform-mark.png'), '');

    const { brand: chosen } = await brandForCompany(sequelize, COMPANY);
    check('A company that DID choose a name keeps it',
      chosen.name === 'Acme Homes', chosen.name);

    const { brand: platform } = await brandForCompany(sequelize, null);
    check('And the platform still brands itself as itself',
      platform.name === 'Realx8' && platform.logo === 'https://cdn.example.test/platform-mark.png',
      `${platform.name} / ${platform.logo}`);
  }

  console.log('\n── The email carries that document, unchanged ──────────────────\n');

  sent.length = 0;
  const delivered = await deliverReceipt(sequelize, {
    companyId: COMPANY,
    to: receipt.client_email,
    toName: receipt.client_name,
    receipt,
    fmt: companyMoney,
  });
  const message = sent[0];

  check('It was sent', delivered === true && !!message);
  check('The body IS the document, byte for byte', message?.html === document);
  check('...and it is attached as well, to be kept',
    message?.attachments?.length === 1 && message.attachments[0].content === document,
    message?.attachments?.[0]?.filename);
  check('The attachment is named after the receipt',
    message?.attachments?.[0]?.filename === 'receipt-RCPT-0041.html');
  check('It goes to the person who paid', String(message?.to).includes('ada@example.test'));
  check('The subject names the receipt', String(message?.subject).includes('RCPT-0041'), message?.subject);
  check('A plain-text part exists for clients that never render HTML',
    typeof message?.text === 'string' && message.text.includes('₦2,500,000'));
  check("...and it is a summary, not the markup", !message?.text?.includes('<div'));

  console.log('\n── The company’s own file, where one was attached ──────────────\n');

  /*
   * Two different rules, deliberately, and this is the seam between them.
   *
   * At the point of payment the job is to send something NOW, so the generated
   * document goes out whether or not a file was attached. At download time the
   * uploaded file outranks it, and the endpoint below is what enforces that —
   * not the caller, and not the browser.
   */
  const UPLOADED = 'https://files.example.test/receipt-41.pdf';

  sent.length = 0;
  await deliverReceipt(sequelize, {
    companyId: COMPANY,
    to: receipt.client_email,
    receipt,
    fmt: companyMoney,
    companyReceiptUrl: UPLOADED,
  });
  check('At payment time the generated receipt is still sent',
    sent[0]?.html?.includes('What this is for') && sent[0]?.attachments?.length === 1);
  check('...with the company’s own copy named underneath it',
    sent[0]?.html?.includes(UPLOADED));
  check('...linked, not re-hosted', sent[0]?.attachments?.[0]?.content?.includes(UPLOADED) === false);
  check('The plain-text part points at it too', sent[0]?.text?.includes(UPLOADED));

  console.log('\n── Downloading: the uploaded file outranks the generated one ───\n');

  const { Receipt } = require('../services/finance-service/src/models');
  /*
   * receipts carries a foreign key to invoice_payments, which this scratch
   * database has no reason to hold — the rule under test is about a column on
   * the receipt, not about the ledger behind it.
   */
  await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
  await Receipt.sync({ force: true });
  await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
  const { getReceiptDocument } = require('../services/finance-service/src/controllers/financeController');

  const call = async (id) => {
    let body = null; let status = 200;
    const res = {
      json: (payload) => { body = payload; return res; },
      status: (code) => { status = code; return res; },
    };
    await getReceiptDocument(
      { params: { id }, query: {}, user: { id: 9, company_id: COMPANY, type: 'admin' } },
      res,
      (error) => { throw error; },
    );
    return { body, status };
  };

  const plain = await Receipt.create({
    receipt_number: 'RCPT-0042', amount: 2500000, status: 'verified', company_id: COMPANY,
  });
  const withFile = await Receipt.create({
    receipt_number: 'RCPT-0043', amount: 2500000, status: 'verified', company_id: COMPANY,
    company_receipt_url: UPLOADED,
  });

  const generated = await call(plain.id);
  check('With no uploaded receipt, the document is generated',
    !!generated.body?.data?.html && generated.body.data.company_receipt_url === null);

  const uploaded = await call(withFile.id);
  check('With one, the endpoint hands back the FILE',
    uploaded.body?.data?.company_receipt_url === UPLOADED);
  check('...and generates nothing at all', uploaded.body?.data?.html === null);
  check('The receipt number comes back either way',
    generated.body?.data?.receipt_number === 'RCPT-0042'
      && uploaded.body?.data?.receipt_number === 'RCPT-0043');

  /*
   * The case the browser could not get right on its own: the caller knows
   * nothing about an uploaded file, because the list it came from never
   * selected the column. The answer must not depend on that.
   */
  check('A caller that knew nothing about the file still gets it',
    (await call(String(withFile.id))).body?.data?.company_receipt_url === UPLOADED);

  console.log('\n── Nothing here may take a committed payment down ───────────────\n');

  sent.length = 0;
  const noAddress = await deliverReceipt(sequelize, { companyId: COMPANY, receipt, fmt: companyMoney });
  check('No email address on the account — declines, does not throw', noAddress === false);
  check('...and nothing was sent', sent.length === 0);

  /*
   * A company with no mail settings of its own AND no platform fallback. The
   * platform rows are removed rather than the company's, because the merge
   * means a company inherits them — leaving them would have this pass for the
   * wrong reason.
   */
  await userModels.Setting.destroy({ where: { group: 'email' } });
  // The environment fallback is cleared with them, or this asserts nothing on a
  // machine whose cred.env happens to carry SMTP credentials.
  delete process.env.SMTP_HOST; delete process.env.SMTP_USER; delete process.env.SMTP_PASS;
  const noSmtp = await deliverReceipt(sequelize, {
    companyId: COMPANY, to: receipt.client_email, receipt, fmt: companyMoney,
  });
  check('No SMTP configured anywhere — declines, does not throw', noSmtp === false);

  const thrown = await deliverReceipt(null, {
    companyId: COMPANY, to: receipt.client_email, receipt, fmt: companyMoney,
  }).then(() => 'resolved', () => 'threw');
  check('A broken database connection is swallowed too', thrown === 'resolved');

  console.log(`\n  ${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);

  await sequelize.close();
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(1); });

/**
 * A throwaway database with enough posted history to drive the accounting
 * screens in a browser.
 *
 * ── Why not just post into the dev database ─────────────────────────────────
 *
 * The journal is append-only and defended by database triggers that refuse
 * UPDATE and DELETE — which is the whole point of it. Anything posted into the
 * developer's own database to exercise a screen would therefore be permanent,
 * and would sit in their company's books for ever describing nothing.
 *
 * So the UI gets pointed at a scratch database instead, seeded here, dropped
 * afterwards. DB_NAME is read at require time by every service, so it must be
 * set before this runs:
 *
 *   DB_NAME=realto_uidrill node scripts/seed-ui-scratch.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { QueryTypes } = require('sequelize');

const COMPANY = 1;
const PROJECT = 4;

const SERVICE_DIRS = [
  'user-service', 'auth-service', 'property-service', 'finance-service',
  'crm-service', 'notification-service', 'investment-service', 'support-service',
];

(async () => {
  for (const dir of SERVICE_DIRS) {
    process.stdout.write(`migrating ${dir}... `);
    // eslint-disable-next-line no-await-in-loop, global-require
    await require(`../services/${dir}/src/index.js`).bootstrap();
    console.log('done');
  }

  const models = require('../services/finance-service/src/models');
  const { sequelize } = models;
  const userModels = require('../services/user-service/src/models');
  const propertyModels = require('../services/property-service/src/models');
  const { postEvent } = require('../shared/src/accounting/posting');

  await userModels.Company.findOrCreate({
    where: { id: COMPANY },
    defaults: {
      id: COMPANY, name: 'Drill Test Co', slug: 'drill-test', email: 'drill@test',
    },
  });

  // bcrypt of VerifyPass123!, the password every verification in this repo uses.
  const HASH = '$2a$10$Wt.JJJxpddt4vZ9jzYK94uV6XGuwLTkxF2uMhYSCrO7buE4kVwMEe';
  const [admin] = await userModels.User.findOrCreate({
    where: { email: 'drill.smoke@mailinator.com' },
    defaults: {
      name: 'Drill Smoke',
      email: 'drill.smoke@mailinator.com',
      password: HASH,
      type: 'super_admin',
      is_active: true,
      company_id: COMPANY,
    },
  });
  const [buyer] = await userModels.User.findOrCreate({
    where: { email: 'drill.buyer@mailinator.com' },
    defaults: {
      name: 'Kelvin Obi',
      email: 'drill.buyer@mailinator.com',
      password: HASH,
      type: 'client',
      is_active: true,
      company_id: COMPANY,
    },
  });

  /*
   * After the company row, not before.
   *
   * seedChartOfAccounts runs at boot and seeds whatever companies exist THEN
   * — which on a fresh scratch database is none of them. Without this the
   * chart has only the platform's own accounts, every posting falls through
   * to a suspense account that also does not exist, and the seed reports
   * three refusals and zero entries.
   */
  await require('../services/finance-service/src/migrations/seedChartOfAccounts')(sequelize);
  await require('../services/finance-service/src/migrations/seedExpenseTypes')(sequelize);

  const [role] = await sequelize.query(
    'SELECT id FROM roles ORDER BY id LIMIT 1', { type: QueryTypes.SELECT },
  );
  await sequelize.query(
    'INSERT INTO user_roles (user_id, role_id) VALUES (:user, :role)',
    { replacements: { user: admin.id, role: role.id }, type: QueryTypes.INSERT },
  ).catch(() => {});

  await propertyModels.Property.findOrCreate({
    where: { id: PROJECT },
    defaults: {
      id: PROJECT, name: 'Favour City Epe', type: 'estate', company_id: COMPANY, status: 'available',
    },
  });
  await propertyModels.PropertyUnits.findOrCreate({
    where: { id: 41 },
    defaults: {
      id: 41, property_id: PROJECT, name: 'Plot A', size: '400', price: 50000000, quantity: 1,
    },
  });

  await sequelize.query(
    `INSERT INTO settings (${sequelize.getDialect() === 'postgres' ? '"group", "key", "value"' : '`group`, `key`, `value`'}, company_id, created_at)
     VALUES ('accounting', 'post_to_ledger', 'true', :company, NOW())`,
    { replacements: { company: COMPANY }, type: QueryTypes.INSERT },
  ).catch(() => {});

  const invoice = await models.Invoice.create({
    company_id: COMPANY,
    invoice_id: 'INV-0001',
    client_id: buyer.id,
    property_id: PROJECT,
    amount: 53750000,
    status: 'sent',
    type: 'property_sale',
    due_date: '2026-05-01',
  });

  /* A sale, a payment against it, and a build cost — enough to drill through. */
  await postEvent(sequelize, {
    rule: 'invoice',
    companyId: COMPANY,
    entryDate: '2026-03-01',
    source: 'invoice',
    sourceId: String(invoice.id),
    memo: 'INV-0001 — Plot A, Favour City Epe',
    createdBy: admin.id,
    input: {
      grossMinor: 5000000000,
      vatMinor: 375000000,
      recognition: 'ON_HANDOVER',
      dimensions: { property_id: PROJECT, party_id: buyer.id, party_type: 'client' },
    },
  });
  await postEvent(sequelize, {
    rule: 'invoice_payment',
    companyId: COMPANY,
    entryDate: '2026-05-04',
    source: 'invoice_payment',
    sourceId: `${invoice.id}:1`,
    memo: 'Payment on INV-0001',
    createdBy: admin.id,
    input: {
      amountMinor: 5375000000,
      dimensions: { property_id: PROJECT, party_id: buyer.id, party_type: 'client' },
    },
  });
  await postEvent(sequelize, {
    rule: 'bill',
    companyId: COMPANY,
    entryDate: '2026-02-01',
    source: 'bill',
    sourceId: '1',
    memo: 'BILL-0001 — foundation pour',
    createdBy: admin.id,
    input: {
      netMinor: 8000000000,
      taxMinor: 600000000,
      withholdingMinor: 400000000,
      expenseRole: 'DEVELOPMENT_WIP',
      dimensions: { property_id: PROJECT, party_id: 1, party_type: 'vendor' },
    },
  });

  const [{ n }] = await sequelize.query(
    'SELECT COUNT(*) AS n FROM journal_entries', { type: QueryTypes.SELECT },
  );
  console.log(`\nseeded ${n} journal entries in ${process.env.DB_NAME}`);
  console.log('login: drill.smoke@mailinator.com / VerifyPass123!');
  process.exit(0);
})().catch((error) => {
  console.error('seed failed:', error.message);
  process.exit(1);
});

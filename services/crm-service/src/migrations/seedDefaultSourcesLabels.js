/**
 * Seed the platform-wide default CRM Sources and Labels.
 * Run: node services/crm-service/src/migrations/seedDefaultSourcesLabels.js
 *
 * Safe to re-run: each row is matched on (name, company_id IS NULL) and only
 * created when it is not already there.
 *
 * ── Why it goes through the models ──────────────────────────────────────────
 *
 * It used to open its own mysql2 connection with `?` placeholders, which made
 * it MySQL-only — so the one database it could never seed was production. The
 * SQL it ran was portable; the driver was not. Going through crm-service's own
 * Sequelize connection fixes that and drops half the file: findOrCreate is the
 * check-then-insert this was spelling out by hand.
 */
require('dotenv').config({
  path: require('path').resolve(__dirname, '../../../../cred.env'),
});

const { sequelize, Source, Label } = require('../models');

const DEFAULT_SOURCES = [
  'AI Chatbot',
  'Website',
  'Referral',
  'Social Media',
  'Walk-In',
  'Phone Call',
  'Email Campaign',
  'Property Exhibition',
  'WhatsApp',
  'Instagram',
  'Facebook',
  'Google Ads',
  'Agent Referral',
  'Cold Outreach',
  'Partner Channel',
];

const DEFAULT_LABELS = [
  { name: 'Hot Lead',         color: '#ef4444' },
  { name: 'Warm Lead',        color: '#f97316' },
  { name: 'Cold Lead',        color: '#64748b' },
  { name: 'VIP Client',       color: '#8b5cf6' },
  { name: 'Investor',         color: '#0ea5e9' },
  { name: 'First-Time Buyer', color: '#10b981' },
  { name: 'Returning Client', color: '#6366f1' },
  { name: 'Needs Follow-Up',  color: '#f59e0b' },
  { name: 'Do Not Contact',   color: '#dc2626' },
  { name: 'High Budget',      color: '#059669' },
  { name: 'Low Budget',       color: '#94a3b8' },
  { name: 'Commercial',       color: '#0284c7' },
  { name: 'Residential',      color: '#16a34a' },
  { name: 'Shortlet',         color: '#db2777' },
  { name: 'Land',             color: '#92400e' },
];

/**
 * Creates the row unless a platform-wide one with that name exists.
 *
 * `company_id: null` is part of the match, not just the payload: a company that
 * has made its own "Referral" source must not stop the platform-wide default
 * being seeded, and must not have its row adopted as one.
 */
const seed = async (Model, kind, rows) => {
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const [entity, created] = await Model.findOrCreate({
      where: { name: row.name, company_id: null },
      defaults: { ...row, created_by: null, company_id: null },
    });
    console.log(created ? `  ✓ ${kind}: ${entity.name}` : `  – ${kind} already exists: ${entity.name}`);
  }
};

async function run() {
  await sequelize.authenticate();
  console.log(`Connected (${sequelize.getDialect()}). Seeding default sources...`);
  await seed(Source, 'Source', DEFAULT_SOURCES.map((name) => ({ name })));

  console.log('\nSeeding default labels...');
  await seed(Label, 'Label', DEFAULT_LABELS);

  await sequelize.close();
  console.log('\n✅ Seed complete.');
}

run().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});

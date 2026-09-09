/**
 * Seed default CRM Sources and Labels.
 * Run: node services/crm-service/src/migrations/seedDefaultSourcesLabels.js
 *
 * Safe to re-run — uses INSERT IGNORE so existing rows are skipped.
 */
require('dotenv').config({
  path: require('path').resolve(__dirname, '../../../../cred.env'),
});

const mysql = require('mysql2/promise');

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

async function run() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || 'realto',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  });

  console.log('Connected. Seeding default sources...');

  for (const name of DEFAULT_SOURCES) {
    const [rows] = await connection.execute(
      'SELECT id FROM sources WHERE name = ? AND company_id IS NULL LIMIT 1',
      [name]
    );
    if (rows.length === 0) {
      await connection.execute(
        'INSERT INTO sources (name, created_by, company_id, created_at) VALUES (?, NULL, NULL, NOW())',
        [name]
      );
      console.log(`  ✓ Source: ${name}`);
    } else {
      console.log(`  – Source already exists: ${name}`);
    }
  }

  console.log('\nSeeding default labels...');

  for (const { name, color } of DEFAULT_LABELS) {
    const [rows] = await connection.execute(
      'SELECT id FROM labels WHERE name = ? AND company_id IS NULL LIMIT 1',
      [name]
    );
    if (rows.length === 0) {
      await connection.execute(
        'INSERT INTO labels (name, color, created_by, company_id, created_at) VALUES (?, ?, NULL, NULL, NOW())',
        [name, color]
      );
      console.log(`  ✓ Label: ${name} (${color})`);
    } else {
      console.log(`  – Label already exists: ${name}`);
    }
  }

  await connection.end();
  console.log('\n✅ Seed complete.');
}

run().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});

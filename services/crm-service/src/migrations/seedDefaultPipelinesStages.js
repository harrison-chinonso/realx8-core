/**
 * Seed default Pipelines, Stages, and Lead Stages for a real estate CRM.
 * Run: node services/crm-service/src/migrations/seedDefaultPipelinesStages.js
 *
 * Safe to re-run — checks existence before inserting.
 */
require('dotenv').config({
  path: require('path').resolve(__dirname, '../../../../cred.env'),
});

const mysql = require('mysql2/promise');

// ─── Default Pipelines with their Stages ────────────────────────────────────

const DEFAULT_PIPELINES = [
  {
    name: 'Residential Sales',
    stages: [
      { name: 'New Enquiry',          order: 1, color: '#64748b' },
      { name: 'Qualification',        order: 2, color: '#0ea5e9' },
      { name: 'Site Inspection',      order: 3, color: '#8b5cf6' },
      { name: 'Proposal Sent',        order: 4, color: '#f59e0b' },
      { name: 'Negotiation',          order: 5, color: '#f97316' },
      { name: 'Payment Processing',   order: 6, color: '#06b6d4' },
      { name: 'Documentation',        order: 7, color: '#6366f1' },
      { name: 'Closed Won',           order: 8, color: '#10b981' },
      { name: 'Closed Lost',          order: 9, color: '#ef4444' },
    ],
  },
  {
    name: 'Commercial Sales',
    stages: [
      { name: 'Lead Received',        order: 1, color: '#64748b' },
      { name: 'Needs Assessment',     order: 2, color: '#0ea5e9' },
      { name: 'Property Shortlisting',order: 3, color: '#8b5cf6' },
      { name: 'Site Visit',           order: 4, color: '#a855f7' },
      { name: 'Due Diligence',        order: 5, color: '#f59e0b' },
      { name: 'Offer Submitted',      order: 6, color: '#f97316' },
      { name: 'Legal Review',         order: 7, color: '#06b6d4' },
      { name: 'Closed Won',           order: 8, color: '#10b981' },
      { name: 'Closed Lost',          order: 9, color: '#ef4444' },
    ],
  },
  {
    name: 'Land Acquisition',
    stages: [
      { name: 'Enquiry',              order: 1, color: '#64748b' },
      { name: 'Site Survey',          order: 2, color: '#0ea5e9' },
      { name: 'Title Verification',   order: 3, color: '#f59e0b' },
      { name: 'Offer & Negotiation',  order: 4, color: '#f97316' },
      { name: 'Survey & Excision',    order: 5, color: '#8b5cf6' },
      { name: 'Payment',              order: 6, color: '#06b6d4' },
      { name: 'Deed of Assignment',   order: 7, color: '#6366f1' },
      { name: 'Closed Won',           order: 8, color: '#10b981' },
      { name: 'Closed Lost',          order: 9, color: '#ef4444' },
    ],
  },
  {
    name: 'Shortlet & Rental',
    stages: [
      { name: 'Enquiry',              order: 1, color: '#64748b' },
      { name: 'Property Matching',    order: 2, color: '#0ea5e9' },
      { name: 'Viewing Scheduled',    order: 3, color: '#8b5cf6' },
      { name: 'Application Submitted',order: 4, color: '#f59e0b' },
      { name: 'Reference Check',      order: 5, color: '#f97316' },
      { name: 'Lease Agreement',      order: 6, color: '#06b6d4' },
      { name: 'Move-In',              order: 7, color: '#10b981' },
      { name: 'Closed Lost',          order: 8, color: '#ef4444' },
    ],
  },
  {
    name: 'Investment Properties',
    stages: [
      { name: 'Investor Identified',  order: 1, color: '#64748b' },
      { name: 'Portfolio Review',     order: 2, color: '#0ea5e9' },
      { name: 'ROI Presentation',     order: 3, color: '#8b5cf6' },
      { name: 'Subscription',         order: 4, color: '#f59e0b' },
      { name: 'KYC & Documentation',  order: 5, color: '#f97316' },
      { name: 'Payment Received',     order: 6, color: '#06b6d4' },
      { name: 'Certificate Issued',   order: 7, color: '#10b981' },
      { name: 'Closed Lost',          order: 8, color: '#ef4444' },
    ],
  },
];

// ─── Default Lead Stages (Kanban-style, pipeline-independent) ────────────────

const DEFAULT_LEAD_STAGES = [
  'New',
  'Contacted',
  'Qualified',
  'Proposal Sent',
  'Follow-Up',
  'Inspection Scheduled',
  'Negotiation',
  'Documentation',
  'Closed Won',
  'Closed Lost',
  'On Hold',
];

// ─── Runner ──────────────────────────────────────────────────────────────────

async function run() {
  const connection = await mysql.createConnection({
    host:     process.env.DB_HOST     || 'localhost',
    port:     Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME     || 'realto',
    user:     process.env.DB_USER     || 'root',
    password: process.env.DB_PASSWORD || '',
  });

  console.log('Connected. Seeding default pipelines & stages...\n');

  for (const pipeline of DEFAULT_PIPELINES) {
    // Check if pipeline already exists (global, company_id IS NULL)
    const [existing] = await connection.execute(
      'SELECT id FROM pipelines WHERE name = ? AND company_id IS NULL LIMIT 1',
      [pipeline.name]
    );

    let pipelineId;
    if (existing.length > 0) {
      pipelineId = existing[0].id;
      console.log(`  – Pipeline already exists: "${pipeline.name}" (id=${pipelineId})`);
    } else {
      const [result] = await connection.execute(
        'INSERT INTO pipelines (name, created_by, company_id, created_at) VALUES (?, NULL, NULL, NOW())',
        [pipeline.name]
      );
      pipelineId = result.insertId;
      console.log(`  ✓ Pipeline: "${pipeline.name}" (id=${pipelineId})`);
    }

    // Seed stages for this pipeline
    for (const stage of pipeline.stages) {
      const [existingStage] = await connection.execute(
        'SELECT id FROM stages WHERE name = ? AND pipeline_id = ? AND company_id IS NULL LIMIT 1',
        [stage.name, pipelineId]
      );
      if (existingStage.length > 0) {
        console.log(`      – Stage already exists: "${stage.name}"`);
      } else {
        await connection.execute(
          'INSERT INTO stages (name, pipeline_id, `order`, color, created_by, company_id, created_at) VALUES (?, ?, ?, ?, NULL, NULL, NOW())',
          [stage.name, pipelineId, stage.order, stage.color]
        );
        console.log(`      ✓ Stage: "${stage.name}" [order=${stage.order}]`);
      }
    }
    console.log('');
  }

  console.log('Seeding default lead stages...');
  for (const name of DEFAULT_LEAD_STAGES) {
    const [existing] = await connection.execute(
      'SELECT id FROM lead_stages WHERE name = ? AND company_id IS NULL LIMIT 1',
      [name]
    );
    if (existing.length > 0) {
      console.log(`  – Lead stage already exists: "${name}"`);
    } else {
      await connection.execute(
        'INSERT INTO lead_stages (name, created_by, company_id, created_at) VALUES (?, NULL, NULL, NOW())',
        [name]
      );
      console.log(`  ✓ Lead stage: "${name}"`);
    }
  }

  await connection.end();
  console.log('\n✅ Seed complete.');
}

run().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});

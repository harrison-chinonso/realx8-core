#!/usr/bin/env node
/**
 * `npm run seed:demo` — a separate local database full of realistic, entirely
 * FICTIONAL demo data, for marketing screenshots of Realx8-Ui.
 *
 *   One company, "Realx8" (code RXDMO), in Realx8's own navy and gold, realtor
 *   ladder, commission plan, four Lagos developments, sixteen sales spread over
 *   the last six months, approved and pending payments, overdue invoices,
 *   commission entitlements (pending and payable), and a small CRM pipeline.
 *
 * ── It never touches the developer's database ───────────────────────────────
 *
 * The data goes into `realto_demo` (DEMO_DB_NAME to override), which is DROPPED
 * AND RECREATED on every run. The script refuses to run if that name matches
 * the DB_NAME configured in cred.env. DB_NAME is overridden in-process before
 * any service is loaded, because every service reads it at require time.
 *
 * ── Nothing leaves this machine ─────────────────────────────────────────────
 *
 * Seeding drives the app's real controllers (checkout, receipt submission,
 * receipt approval), and those notify people. So before anything is loaded:
 * SMTP / SMS / push / Cloudinary credentials are blanked, nodemailer, the shared
 * mail transport and the SMS sender are replaced by no-ops, and global fetch is
 * restricted to localhost. REDIS_URL is blanked so the in-process cache is used
 * — a shared Redis would leak demo settings into a running dev server.
 *
 * ── Logins ──────────────────────────────────────────────────────────────────
 *
 * Every account's password is `DemoPass123!`. It is a LOCAL DEMO-ONLY password,
 * bcrypt-hashed here; never reuse it anywhere real. All addresses use the
 * reserved `.test` TLD, so none of them can ever receive mail.
 *
 * ── Dates ───────────────────────────────────────────────────────────────────
 *
 * The app stamps everything "now". To give dashboards six months of history,
 * each step runs through `at(date, fn)`, which afterwards moves every
 * timestamp written during that step to the step's date (the append-only
 * journal and audit tables are left alone — their triggers refuse updates).
 *
 * Run it (from the repo root):
 *
 *   npm run seed:demo
 *
 * then start a second server against it:
 *
 *   DB_NAME=realto_demo REDIS_URL= SMTP_HOST= SMTP_USER= SMTP_PASS= SMS_ENABLED=false \
 *   SINGLE_SESSION_ENABLED=false CORS_ALLOWED_ORIGINS=http://localhost:5182 PORT=3100 node server.js
 *
 * Blanking SMTP/SMS stops the demo server sending mail with cred.env's real
 * relay. SINGLE_SESSION_ENABLED=false lets a screenshot script sign in again
 * and again (each run looks like a new device). CORS_ALLOWED_ORIGINS must name
 * the port the UI runs on. Then, in Realx8-Ui (with its .env, which holds the
 * request-signing key):
 *
 *   DEV_API_TARGET=http://localhost:3100 npx vite --port 5182
 *
 * DEMO_ENV_FILE may point at a cred.env elsewhere (e.g. when run from a git
 * worktree that has no cred.env of its own).
 */

const path = require('path');

const ENV_FILE = process.env.DEMO_ENV_FILE || path.join(__dirname, '..', 'cred.env');
require('dotenv').config({ path: ENV_FILE, quiet: true });

const { Sequelize, QueryTypes } = require('sequelize');

const REAL_DB = process.env.DB_NAME || 'realto';
const DEMO_DB = process.env.DEMO_DB_NAME || 'realto_demo';
const DEMO_PASSWORD = 'DemoPass123!'; // local demo-only password — see the header
const COMPANY_CODE = 'RXDMO';

if (!DEMO_DB || DEMO_DB === REAL_DB) {
  console.error(`Refusing to run: the demo database name "${DEMO_DB}" matches the configured DB_NAME.`);
  process.exit(1);
}
if (!/^[A-Za-z0-9_]+$/.test(DEMO_DB)) {
  console.error('Refusing to run: DEMO_DB_NAME may only contain letters, digits and underscores.');
  process.exit(1);
}

/* ── Isolation: set BEFORE any service module is required ─────────────────── */

/*
 * Blank rather than delete: every service's index.js calls dotenv again, and
 * dotenv only fills keys that are absent — an empty string stays empty.
 */
const OUTBOUND_ENV = /^(SMTP_|SMS_|EBULKSMS_|TERMII_|SENDCHAMP_|SMARTSMS_|CLOUDINARY_|FACEBOOK_|TWITTER_|LINKEDIN_|TIKTOK_|YOUTUBE_|FCM_|APNS_|GOOGLE_CLIENT|APPLE_)/;
Object.keys(process.env).filter((key) => OUTBOUND_ENV.test(key)).forEach((key) => { process.env[key] = ''; });
Object.assign(process.env, {
  DB_NAME: DEMO_DB,
  REDIS_URL: '',
  CACHE_PREFIX: 'realx8demo',
  SMS_ENABLED: 'false',
  SMTP_HOST: '',
  SMTP_USER: '',
  SMTP_PASS: '',
  // Receipts are "uploaded" as public Unsplash images; the upload guard only
  // accepts allow-listed hosts.
  UPLOAD_ALLOWED_HOSTS: 'images.unsplash.com',
  // The platform administrator user-service's bootstrap creates on an empty
  // database — given the demo identity instead of a generated password.
  SUPER_ADMIN_EMAIL: 'platform@realx8.test',
  SUPER_ADMIN_NAME: 'Tobi Adewale',
  SUPER_ADMIN_PASSWORD: DEMO_PASSWORD,
});

const suppressed = { mail: 0, sms: 0, fetch: 0 };

const nodemailer = require('nodemailer');

nodemailer.createTransport = () => ({
  sendMail: async () => { suppressed.mail += 1; return { messageId: 'suppressed-by-seed-demo' }; },
  verify: async () => true,
  close: () => {},
});
const mailTransport = require('../shared/src/mailTransport');

mailTransport.sendMail = async () => { suppressed.mail += 1; return { messageId: 'suppressed-by-seed-demo' }; };
if (mailTransport.warmMailPort) mailTransport.warmMailPort = async () => null;
const sms = require('../shared/src/sms');

sms.sendCompanySms = async () => { suppressed.sms += 1; return { sent: false, skipped: 'seed-demo' }; };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return realFetch(input, init);
  suppressed.fetch += 1;
  throw new Error(`seed-demo: outbound request to ${url.hostname} blocked`);
};

/* ── Helpers ──────────────────────────────────────────────────────────────── */

const SERVICE_DIRS = [
  // platform/registry.js boot order
  'user-service', 'auth-service', 'property-service', 'investment-service',
  'crm-service', 'finance-service', 'notification-service', 'support-service',
];

const DAY = 86400000;
const NOW = new Date();
const daysAgo = (days, hour = 10) => {
  const date = new Date(NOW.getTime() - days * DAY);
  date.setUTCHours(hour, (days * 7) % 60, 0, 0);
  return date;
};
const sqlDate = (date) => date.toISOString().slice(0, 19).replace('T', ' ');
/** The same instant as the server's local wall clock — some code paths write that. */
const localSqlDate = (date) => sqlDate(new Date(date.getTime() - date.getTimezoneOffset() * 60000));
const unsplash = (id, width = 1600) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${width}&q=80`;

const closeAllPools = async () => {
  for (const dir of SERVICE_DIRS) {
    try {
      // eslint-disable-next-line global-require
      const { sequelize } = require(`../services/${dir}/src/models`);
      // eslint-disable-next-line no-await-in-loop
      await sequelize.close();
    } catch { /* not loaded, or already closed */ }
  }
};

/** Drives an express handler without a server; rejects on a non-2xx answer. */
const call = (handler, { user, params = {}, body = {}, query = {} }) => new Promise((resolve, reject) => {
  const req = {
    user, params, body, query, headers: {}, protocol: 'http', hostname: 'localhost',
    get: () => undefined, header: () => undefined, ip: '127.0.0.1',
  };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) {
      if (this.statusCode >= 400) {
        reject(new Error(`${handler.name || 'handler'} answered ${this.statusCode}: ${payload?.message || JSON.stringify(payload)}`));
      } else resolve(payload);
      return this;
    },
    send(payload) { return this.json(payload); },
    setHeader() { return this; },
  };
  Promise.resolve(handler(req, res, (error) => reject(error || new Error('next() called')))).catch(reject);
});

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const LEVELS = [
  { name: 'Associate', position: 10, rate: 2.5, fee: 0, description: 'Entry level for newly verified realtors.' },
  { name: 'Senior Associate', position: 20, rate: 3.5, fee: 2500000, description: 'Five or more closed sales.' },
  { name: 'Executive', position: 30, rate: 4.5, fee: 5000000, description: 'Consistent top performers with a team.' },
  { name: 'Director', position: 40, rate: 5.5, fee: 10000000, description: 'Leads a network of realtors.' },
];

// key, name, level, upline key
const REALTORS = [
  ['chinedu', 'Chinedu Okeke', 'Director', null],
  ['funmi', 'Funmilayo Adebayo', 'Executive', 'chinedu'],
  ['ibrahim', 'Ibrahim Musa', 'Executive', 'chinedu'],
  ['ngozi', 'Ngozi Eze', 'Senior Associate', 'funmi'],
  ['tunde', 'Tunde Bakare', 'Senior Associate', 'ibrahim'],
  ['aisha', 'Aisha Bello', 'Associate', 'funmi'],
];

// key, name, realtor key
const CLIENTS = [
  ['emeka', 'Emeka Nwosu', 'ngozi'],
  ['halima', 'Halima Sani', 'ibrahim'],
  ['olumide', 'Olumide Coker', 'funmi'],
  ['blessing', 'Blessing Okon', 'aisha'],
  ['yetunde', 'Yetunde Alade', 'tunde'],
  ['kelechi', 'Kelechi Obi', 'chinedu'],
  ['zainab', 'Zainab Lawal', 'ibrahim'],
  ['babatunde', 'Babatunde Ogun', 'tunde'],
  ['chioma', 'Chioma Udeh', 'ngozi'],
  ['segun', 'Segun Oyelaran', 'funmi'],
];

const PROPERTIES = [
  {
    key: 'palm',
    name: 'Palm Grove Estate, Lekki',
    type: 'Land',
    address: 'Off Admiralty Way, Lekki Phase 1',
    city: 'Lekki',
    lat: '6.4474',
    lng: '3.4723',
    description: 'A gated estate of dry, fully serviced plots minutes from the Lekki-Epe Expressway. '
      + 'Paved roads, street lighting, a central park and 24-hour security, with Governor\'s Consent title.',
    amenities: ['Gated entrance', '24-hour security', 'Paved roads', 'Street lighting', 'Central park', 'Drainage'],
    images: ['1600596542815-ffad4c1539a9', '1580587771525-78b9dba3b914', '1564013799919-ab600027ffc6', '1568605114967-8130f3a36994'],
    units: [
      { key: 'p300', name: '300 sqm plot', size: '300', price: 18500000, quantity: 40 },
      { key: 'p450', name: '450 sqm plot', size: '450', price: 26000000, quantity: 30 },
      { key: 'p600', name: '600 sqm plot', size: '600', price: 34000000, quantity: 20 },
    ],
    plans: ['six', 'twelve'],
  },
  {
    key: 'harbour',
    name: 'Harbour View Apartments, Victoria Island',
    type: 'Apartment',
    address: 'Ozumba Mbadiwe Avenue, Victoria Island',
    city: 'Victoria Island',
    lat: '6.4281',
    lng: '3.4219',
    description: 'Waterfront serviced apartments with lagoon views, a rooftop pool, gym, backup power '
      + 'and dedicated parking. Finished to a high specification and ready for move-in.',
    amenities: ['Swimming pool', 'Fitness centre', '24/7 power', 'Lagoon views', 'Concierge', 'Covered parking'],
    images: ['1545324418-cc1a3fa10c00', '1502672260266-1c1ef2d93688', '1522708323590-d24dbb6b0267', '1560448204-e02f11c3d0e2'],
    units: [
      { key: 'h2', name: '2-bedroom apartment', size: '145', price: 145000000, quantity: 12 },
      { key: 'h3', name: '3-bedroom apartment', size: '210', price: 210000000, quantity: 10 },
      { key: 'hph', name: 'Penthouse', size: '420', price: 480000000, quantity: 2 },
    ],
    plans: ['twelve', 'twentyfour'],
  },
  {
    key: 'cedar',
    name: 'Cedar Court Terraces, Ikeja',
    type: 'Terrace',
    address: 'Joel Ogunnaike Street, Ikeja GRA',
    city: 'Ikeja',
    lat: '6.6018',
    lng: '3.3515',
    description: 'Contemporary terraced homes in the heart of Ikeja GRA, close to the airport and '
      + 'Allen Avenue. Each home has a private garden, fitted kitchen and a boys\' quarters.',
    amenities: ['Private garden', 'Fitted kitchen', 'Boys\' quarters', 'Children\'s play area', 'Estate security'],
    images: ['1600585154340-be6161a56a0c', '1570129477492-45c003edd2be', '1600607687939-ce8a6c25118c', '1600566753190-17f0baa2a6c3'],
    units: [
      { key: 'c3', name: '3-bedroom terrace', size: '220', price: 95000000, quantity: 14 },
      { key: 'c4', name: '4-bedroom terrace duplex', size: '310', price: 130000000, quantity: 8 },
    ],
    plans: ['twelve', 'twentyfour'],
  },
  {
    key: 'oak',
    name: 'Oakridge Gardens, Ibeju-Lekki',
    type: 'Land',
    address: 'Lekki-Epe Expressway, Ibeju-Lekki',
    city: 'Ibeju-Lekki',
    lat: '6.4698',
    lng: '3.8562',
    description: 'Affordable, well-drained plots in the fast-growing Lekki Free Trade Zone corridor, '
      + 'close to the Dangote Refinery and the new Lekki Deep Sea Port.',
    amenities: ['Perimeter fence', 'Estate gate', 'Motorable roads', 'Instant allocation'],
    images: ['1512917774080-9991f1c4c750', '1613490493576-7fde63acd811', '1605276374104-dee2a0ed3cd6'],
    units: [
      { key: 'o500', name: '500 sqm plot', size: '500', price: 9500000, quantity: 60 },
      { key: 'o1000', name: '1000 sqm plot', size: '1000', price: 18000000, quantity: 25 },
    ],
    plans: ['six', 'twelve'],
  },
];

const INSTALLMENT_PLANS = {
  six: {
    name: '6-month plan', duration: 6, surchargeType: 'none', surchargeValue: 0, roundingRule: 'nearest_1000',
    grace: 7, feeType: 'percentage', feeValue: 2, feeRecurrence: 'once',
  },
  twelve: {
    name: '12-month plan', duration: 12, surchargeType: 'percentage', surchargeValue: 5, roundingRule: 'nearest_1000',
    grace: 7, feeType: 'percentage', feeValue: 2.5, feeRecurrence: 'once',
  },
  twentyfour: {
    name: '24-month plan', duration: 24, surchargeType: 'percentage', surchargeValue: 10, roundingRule: 'nearest_1000',
    grace: 10, feeType: 'percentage', feeValue: 2.5, feeRecurrence: 'once',
  },
};

/*
 * Sixteen sales. `pays` are instalments in order: `days` ago, and either
 * `next` (the next schedule's outstanding amount), `share` of the total, or
 * `rest` (whatever is left). `pending` leaves the receipt awaiting approval.
 */
const SALES = [
  { client: 'emeka', unit: 'p450', type: 'outright', days: 172, pays: [{ days: 165, rest: true }] },
  {
    client: 'halima', unit: 'h2', type: 'installment', plan: 'twelve', days: 160,
    pays: [158, 128, 98, 68, 38].map((d) => ({ days: d, next: true })).concat({ days: 6, next: true, pending: true }),
  },
  {
    client: 'olumide', unit: 'c3', type: 'installment', plan: 'twelve', days: 150,
    pays: [148, 118, 88, 58, 28].map((d) => ({ days: d, next: true })),
  },
  {
    client: 'blessing', unit: 'p300', type: 'installment', plan: 'six', days: 140,
    // the fifth instalment fell due and was never paid: overdue
    pays: [138, 108, 78, 48].map((d) => ({ days: d, next: true })),
  },
  { client: 'yetunde', unit: 'o500', type: 'outright', days: 125, pays: [{ days: 120, rest: true }] },
  {
    client: 'kelechi', unit: 'h3', type: 'installment', plan: 'twentyfour', days: 110,
    pays: [108, 78, 48, 18].map((d) => ({ days: d, next: true })),
  },
  {
    client: 'zainab', unit: 'c4', type: 'outright', days: 95,
    pays: [{ days: 90, share: 0.5 }, { days: 62, rest: true }],
  },
  {
    client: 'babatunde', unit: 'o1000', type: 'installment', plan: 'six', days: 80,
    pays: [78, 48, 18].map((d) => ({ days: d, next: true })),
  },
  { client: 'chioma', unit: 'p600', type: 'outright', days: 66, pays: [{ days: 60, rest: true }] },
  {
    client: 'segun', unit: 'hph', type: 'installment', plan: 'twentyfour', days: 50,
    pays: [48, 18].map((d) => ({ days: d, next: true })),
  },
  { client: 'chioma', unit: 'p450', type: 'outright', days: 45, pays: [] }, // overdue
  {
    client: 'emeka', unit: 'o500', type: 'installment', plan: 'six', days: 40,
    pays: [{ days: 38, next: true }, { days: 4, next: true, pending: true }],
  },
  { client: 'blessing', unit: 'c3', type: 'outright', days: 28, pays: [{ days: 3, rest: true, pending: true }] },
  { client: 'kelechi', unit: 'p300', type: 'outright', days: 20, pays: [] }, // overdue
  {
    client: 'yetunde', unit: 'c4', type: 'installment', plan: 'twelve', days: 12,
    pays: [{ days: 10, next: true, pending: true }],
  },
  { client: 'zainab', unit: 'o1000', type: 'outright', days: 6, pays: [] }, // not yet due
];

const LEADS = [
  { name: 'Adaeze Nnamdi', status: 'negotiation', thermal: 'Hot', stage: 'Negotiation', realtor: 'funmi', source: 'Instagram', budget: '₦100m – ₦200m', profile: '3-bedroom apartment', window: '0–3 months', days: 21 },
  { name: 'Femi Ogunleye', status: 'inspection_scheduled', thermal: 'Warm', stage: 'Site Inspection', realtor: 'tunde', source: 'Website', budget: '₦20m – ₦40m', profile: 'Land (450–600 sqm)', window: '3–6 months', days: 14 },
  { name: 'Maryam Abdullahi', status: 'contacted', thermal: 'Warm', stage: 'Qualification', realtor: 'ibrahim', source: 'Referral', budget: '₦80m – ₦130m', profile: 'Terrace duplex', window: '3–6 months', days: 9 },
  { name: 'Obinna Chukwu', status: 'new', thermal: 'Cold', stage: 'New Enquiry', realtor: 'aisha', source: 'Property Exhibition', budget: '₦10m – ₦20m', profile: 'Land (500 sqm)', window: '6–12 months', days: 3 },
  { name: 'Folake Ajayi', status: 'follow_up', thermal: 'Warm', stage: 'Proposal Sent', realtor: 'ngozi', source: 'Walk-In', budget: '₦25m – ₦35m', profile: 'Land (600 sqm)', window: '0–3 months', days: 17 },
  { name: 'Sadiq Garba', status: 'closed_won', thermal: 'Hot', stage: 'Closed Won', realtor: 'chinedu', source: 'Referral', budget: '₦400m+', profile: 'Penthouse', window: 'Immediate', days: 58 },
  { name: 'Ifeoma Okafor', status: 'closed_lost', thermal: 'Cold', stage: 'Closed Lost', realtor: 'funmi', source: 'Instagram', budget: '₦50m – ₦80m', profile: '2-bedroom apartment', window: '6–12 months', days: 75 },
  { name: 'Damilola Peters', status: 'negotiation', thermal: 'Hot', stage: 'Negotiation', realtor: 'ibrahim', source: 'WhatsApp', budget: '₦130m – ₦150m', profile: '2-bedroom apartment', window: '0–3 months', days: 11 },
  { name: 'Uche Anyanwu', status: 'contacted', thermal: 'Warm', stage: 'Qualification', realtor: 'tunde', source: 'Website', budget: '₦90m – ₦100m', profile: '3-bedroom terrace', window: '3–6 months', days: 6 },
  { name: 'Rukayat Bello', status: 'new', thermal: 'Cold', stage: 'New Enquiry', realtor: 'aisha', source: 'Instagram', budget: '₦15m – ₦20m', profile: 'Land (1000 sqm)', window: '6–12 months', days: 1 },
];

const DEALS = [
  { lead: 'Adaeze Nnamdi', name: 'Harbour View 3-bed — Nnamdi', amount: 210000000, stage: 'Negotiation', status: 'open', closeIn: 20 },
  { lead: 'Femi Ogunleye', name: 'Palm Grove 450 sqm — Ogunleye', amount: 26000000, stage: 'Site Inspection', status: 'open', closeIn: 45 },
  { lead: 'Folake Ajayi', name: 'Palm Grove 600 sqm — Ajayi', amount: 34000000, stage: 'Proposal Sent', status: 'open', closeIn: 25 },
  { lead: 'Sadiq Garba', name: 'Harbour View Penthouse — Garba', amount: 480000000, stage: 'Closed Won', status: 'won', closeIn: -50 },
  { lead: 'Ifeoma Okafor', name: 'Harbour View 2-bed — Okafor', amount: 145000000, stage: 'Closed Lost', status: 'lost', closeIn: -40 },
  { lead: 'Damilola Peters', name: 'Harbour View 2-bed — Peters', amount: 145000000, stage: 'Negotiation', status: 'open', closeIn: 15 },
];

/* ── Main ─────────────────────────────────────────────────────────────────── */

const main = async () => {
  /* The database */
  const admin = new Sequelize('', process.env.DB_USER, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    dialect: 'mysql',
    logging: false,
  });
  const leftovers = await admin.query('SHOW PROCESSLIST', { type: QueryTypes.SELECT });
  for (const connection of leftovers) {
    if (connection.db === DEMO_DB) {
      // eslint-disable-next-line no-await-in-loop
      await admin.query(`KILL ${Number(connection.Id)}`).catch(() => {});
    }
  }
  await admin.query('SET SESSION lock_wait_timeout = 10');
  await admin.query(`DROP DATABASE IF EXISTS \`${DEMO_DB}\``);
  await admin.query(`CREATE DATABASE \`${DEMO_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.close();
  console.log(`Demo database ${DEMO_DB} created (${REAL_DB} untouched).`);

  /* Every service's schema, in boot order */
  for (const dir of SERVICE_DIRS) {
    process.stdout.write(`Migrating ${dir}... `);
    // eslint-disable-next-line no-await-in-loop, global-require
    await require(`../services/${dir}/src/index.js`).bootstrap();
    console.log('done');
  }

  // eslint-disable-next-line global-require
  const bcrypt = require('bcryptjs');
  const { BCRYPT_ROUNDS } = require('../shared/src/passwordPolicy');
  const userModels = require('../services/user-service/src/models');
  const propertyModels = require('../services/property-service/src/models');
  const crmModels = require('../services/crm-service/src/models');
  const financeModels = require('../services/finance-service/src/models');
  const { sequelize } = financeModels;
  const propertyController = require('../services/property-service/src/controllers/propertyController');
  const financeController = require('../services/finance-service/src/controllers/financeController');
  const planController = require('../services/finance-service/src/controllers/commissionPlanController');
  const { readPaymentPlan } = require('../shared/src/paymentPlanGateway');
  const { runScheduleSweep } = require('../services/finance-service/src/utils/scheduleJob');
  const { ensureRealtorCode } = require('../shared/src/realtorCode');
  const commissionStore = require('../shared/src/commissionStore');
  const { asMinor, toMajor } = require('../shared/src/money');

  const raw = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  const exec = (sql, replacements = {}) => sequelize.query(sql, { replacements });

  /*
   * Time travel. Every datetime column written while `fn` ran is moved to
   * `date`, except due dates and anything in the append-only tables.
   */
  const timestampColumns = await raw(
    `SELECT c.TABLE_NAME AS t, c.COLUMN_NAME AS c
       FROM information_schema.COLUMNS c
       JOIN information_schema.TABLES tb ON tb.TABLE_SCHEMA = c.TABLE_SCHEMA AND tb.TABLE_NAME = c.TABLE_NAME
      WHERE c.TABLE_SCHEMA = DATABASE() AND tb.TABLE_TYPE = 'BASE TABLE'
        AND c.DATA_TYPE IN ('datetime', 'timestamp')
        AND c.TABLE_NAME NOT IN (SELECT EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE())
        AND c.COLUMN_NAME NOT IN ('due_date', 'expected_close_date', 'plan_expire_date', 'passcode_locked_until',
                                  'public_expires_at', 'effective_from', 'effective_to', 'attribution_date')`,
  );
  const dbNow = async () => (await raw("SELECT DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') AS n"))[0].n;
  /*
   * Three clocks write timestamps here: Sequelize (UTC), MySQL's NOW(), and the
   * odd raw query that formats a JS Date in the machine's local time. The
   * window covers all three; nothing else is written during a step.
   */
  const byTable = new Map();
  timestampColumns.forEach(({ t, c }) => byTable.set(t, [...(byTable.get(t) || []), c]));
  const at = async (date, fn) => {
    const started = new Date(Date.now() - 1000);
    const startDb = await dbNow();
    const result = await fn();
    await new Promise((resolve) => { setTimeout(resolve, 300); }); // fire-and-forget notices
    const ended = new Date(Date.now() + 1000);
    const endDb = await dbNow();
    const windows = [
      [sqlDate(started), sqlDate(ended)],
      [localSqlDate(started), localSqlDate(ended)],
      [startDb, endDb],
    ];
    const replacements = { target: sqlDate(date) };
    const conditions = (column) => windows
      .map((_, i) => `\`${column}\` BETWEEN :from${i} AND :to${i}`).join(' OR ');
    windows.forEach(([from, to], i) => { replacements[`from${i}`] = from; replacements[`to${i}`] = to; });
    for (const [table, columns] of byTable) {
      for (const column of columns) {
        // eslint-disable-next-line no-await-in-loop
        await exec(`UPDATE \`${table}\` SET \`${column}\` = :target WHERE ${conditions(column)}`, replacements);
      }
    }
    return result;
  };

  /* Company */
  const company = await userModels.Company.create({
    name: 'Realx8',
    slug: 'realx8-demo',
    email: 'hello@demo.realx8.test',
    phone: '+2348005550100',
    address: '14 Admiralty Way, Lekki Phase 1, Lagos',
    status: 'active',
    plan: 'standard',
    referral_code: COMPANY_CODE,
  });
  const companyId = company.id;

  // Boot-time seeds that run per company, and so found none on the empty database.
  await require('../services/finance-service/src/migrations/seedChartOfAccounts')(sequelize);
  await require('../services/finance-service/src/migrations/seedExpenseTypes')(sequelize);

  /* Appearance */
  const setting = (group, key, value, scope) => userModels.Setting.create({
    group, key, value, company_id: scope,
  });
  await setting('appearance', 'app_name', 'Realx8', null);
  for (const [key, value] of Object.entries({
    // Realx8's own look, so screenshots show Realx8 rather than a tenant.
    app_name: 'Realx8',
    primary_color: '#C9965B',
    secondary_color: '#0E1220',
    template: 'launcher',
    currency: 'NGN',
  })) {
    // eslint-disable-next-line no-await-in-loop
    await setting('appearance', key, value, companyId);
  }

  /* Users */
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_ROUNDS);
  const roleId = async (name) => (await raw('SELECT id FROM roles WHERE name = :name LIMIT 1', { name }))[0]?.id;
  const giveRole = async (userId, name) => {
    const id = await roleId(name);
    if (id) await exec('INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (:userId, :id)', { userId, id });
  };
  const emailFor = (name, domain) => `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@${domain}`;
  const phoneFor = (n) => `+23480355501${String(n).padStart(2, '0')}`;

  // The platform admin is created by user-service's own bootstrap (see the env above).
  const [platformAdmin] = await raw("SELECT id, email FROM users WHERE type = 'superior_admin' LIMIT 1");

  const companyAdmin = await userModels.User.create({
    name: 'Amaka Okafor',
    email: 'admin@demo.realx8.test',
    password: passwordHash,
    phone: phoneFor(0),
    type: 'super_admin',
    is_active: true,
    company_id: companyId,
  });
  await giveRole(companyAdmin.id, 'super_admin');
  const adminUser = {
    id: companyAdmin.id, name: companyAdmin.name, email: companyAdmin.email,
    type: 'super_admin', company_id: companyId, isSuperiorAdmin: false,
  };

  /* Realtor ladder (the company's own) */
  const levelIds = {};
  for (const level of LEVELS) {
    // eslint-disable-next-line no-await-in-loop
    const row = await userModels.RealtorLevel.create({
      name: level.name,
      description: level.description,
      position: level.position,
      commission_percentage: level.rate,
      levelup_fee_minor: level.fee,
      is_active: true,
      created_by: companyAdmin.id,
      company_id: companyId,
    });
    levelIds[level.name] = row.id;
  }

  const realtors = {};
  let phoneSeq = 1;
  for (const [key, name, level, upline] of REALTORS) {
    // eslint-disable-next-line no-await-in-loop
    const row = await userModels.User.create({
      name,
      email: emailFor(name, 'demo.realx8.test'),
      password: passwordHash,
      phone: phoneFor(phoneSeq),
      type: 'realtor',
      is_active: true,
      company_id: companyId,
      realtor_level_id: levelIds[level],
      realtor_id: upline ? realtors[upline].id : null,
    });
    phoneSeq += 1;
    realtors[key] = row;
    // eslint-disable-next-line no-await-in-loop
    await giveRole(row.id, 'realtor');
    // An approved identity check — the gate on referral codes and payouts.
    // eslint-disable-next-line no-await-in-loop
    await userModels.RealtorKyc.create({
      user_id: row.id,
      id_type: 'national_id',
      id_number: `DEMO-${String(row.id).padStart(6, '0')}`,
      id_document_url: unsplash('1554224155-6726b3ff858f', 1200),
      address_document_type: 'utility_bill',
      address_line: 'Lagos, Nigeria',
      address_document_url: unsplash('1450101499163-c8848c66ca85', 1200),
      status: 'approved',
      reviewed_by: companyAdmin.id,
      reviewed_at: daysAgo(230),
      submitted_at: daysAgo(232),
      company_id: companyId,
    });
    // eslint-disable-next-line no-await-in-loop
    await ensureRealtorCode(sequelize, row.id);
  }

  const clients = {};
  for (const [key, name, realtorKey] of CLIENTS) {
    // eslint-disable-next-line no-await-in-loop
    const row = await userModels.User.create({
      name,
      email: emailFor(name, 'mail.test'),
      password: passwordHash,
      phone: phoneFor(phoneSeq),
      type: 'client',
      is_active: true,
      company_id: companyId,
      realtor_id: realtors[realtorKey].id,
    });
    phoneSeq += 1;
    clients[key] = row;
    // eslint-disable-next-line no-await-in-loop
    await giveRole(row.id, 'client');
  }

  // Everyone joined well before the first sale; a realtor's standing is dated
  // from then, or the commission gate would refuse to place them on old deals.
  await exec('UPDATE users SET created_at = :at, updated_at = :at WHERE company_id = :companyId OR type = \'superior_admin\'',
    { at: sqlDate(daysAgo(240)), companyId });
  await exec('UPDATE realtor_status_history SET effective_from = :at, created_at = :at', { at: sqlDate(daysAgo(240)) });
  await exec('UPDATE companies SET created_at = :at, updated_at = :at WHERE id = :companyId', { at: sqlDate(daysAgo(260)), companyId });
  await exec('UPDATE realtor_levels SET created_at = :at, updated_at = :at WHERE company_id = :companyId',
    { at: sqlDate(daysAgo(250)), companyId });

  /* Commission plan — through the plan screens' own controller */
  const levelRows = await raw('SELECT id, name, commission_percentage FROM realtor_levels WHERE company_id = :companyId ORDER BY position',
    { companyId });
  const planConfig = {
    commissionable_base: { mode: 'GROSS_PRICE' },
    pool: { mode: 'PERCENTAGE', percentage: 8 },
    resolution: 'PRORATE',
    vesting: { release_trigger: 'PRO_RATA' },
    deductions: [
      { code: 'wht', label: 'Withholding tax', type: 'PERCENTAGE', value: 5, basis: 'GROSS', order: 1 },
    ],
    clawback_window_months: 12,
    clawback_recovery_percentage: 50,
    rules: [
      {
        id: 'direct',
        type: 'DIRECT_SALE',
        value_type: 'PERCENTAGE',
        basis: 'OF_COMMISSIONABLE_BASE',
        level_rates: levelRows.map((level) => ({
          level_id: level.id, level_name: level.name, value: Number(level.commission_percentage),
        })),
      },
      {
        id: 'override',
        type: 'GENERATIONAL_OVERRIDE',
        compression: 'NONE',
        tiers: [
          { generation: 1, value_type: 'PERCENTAGE', value: 1, basis: 'OF_COMMISSIONABLE_BASE' },
          { generation: 2, value_type: 'PERCENTAGE', value: 0.5, basis: 'OF_COMMISSIONABLE_BASE' },
        ],
      },
    ],
  };
  const createdPlan = await call(planController.createPlan, {
    user: adminUser,
    body: {
      name: 'Realx8 Standard Plan',
      description: 'Level-based direct commission with two generations of team override, released as the buyer pays.',
      is_default: true,
      config: planConfig,
    },
  });
  const [planVersion] = await raw('SELECT id FROM commission_plan_versions WHERE plan_id = :id ORDER BY version DESC LIMIT 1',
    { id: createdPlan.data.id });
  await call(planController.activateVersion, {
    user: adminUser,
    params: { versionId: planVersion.id },
    body: { effective_from: daysAgo(235).toISOString() },
  });
  await exec('UPDATE commission_plans SET created_at = :at, updated_at = :at', { at: sqlDate(daysAgo(236)) });
  await exec('UPDATE commission_plan_versions SET created_at = :at, approved_at = :at', { at: sqlDate(daysAgo(236)) });

  /* Properties */
  const typeIds = {};
  for (const name of ['Land', 'Apartment', 'Terrace']) {
    // eslint-disable-next-line no-await-in-loop
    const row = await propertyModels.PropertyType.create({ name, company_id: companyId, created_by: companyAdmin.id });
    typeIds[name] = row.id;
  }

  const insertPlan = async (plan) => {
    await exec(
      `INSERT INTO installment_plans
         (name, duration_months, surcharge_type, surcharge_value, rounding_rule,
          grace_period_days, default_fee_type, default_fee_value, default_fee_recurrence,
          is_active, created_by, company_id, created_at, updated_at)
       VALUES (:name, :duration, :surchargeType, :surchargeValue, :roundingRule,
               :grace, :feeType, :feeValue, :feeRecurrence, 1, :createdBy, :companyId, :at, :at)`,
      { ...plan, createdBy: companyAdmin.id, companyId, at: sqlDate(daysAgo(220)) },
    );
    return (await raw('SELECT LAST_INSERT_ID() AS id'))[0].id;
  };
  const planIds = {};
  for (const [key, plan] of Object.entries(INSTALLMENT_PLANS)) {
    // eslint-disable-next-line no-await-in-loop
    planIds[key] = await insertPlan(plan);
  }

  const units = {};
  const propertyIds = {};
  for (const [index, spec] of PROPERTIES.entries()) {
    const listedAt = daysAgo(215 - index * 8);
    // eslint-disable-next-line no-await-in-loop
    const property = await propertyModels.Property.create({
      name: spec.name,
      description: spec.description,
      type: spec.type,
      address: spec.address,
      city: spec.city,
      state: 'Lagos',
      country: 'Nigeria',
      latitude: spec.lat,
      longitude: spec.lng,
      price: Math.min(...spec.units.map((unit) => unit.price)),
      status: 'available',
      images: spec.images.map((id) => ({ url: unsplash(id), type: 'image' })),
      unit_quantity: spec.units.reduce((sum, unit) => sum + unit.quantity, 0),
      unit_measurement_unit: 'sqm',
      approval_status: 'approved',
      approved_by: companyAdmin.id,
      approved_at: listedAt,
      created_by: companyAdmin.id,
      company_id: companyId,
    });
    propertyIds[spec.key] = property.id;
    for (const amenity of spec.amenities) {
      // eslint-disable-next-line no-await-in-loop
      await propertyModels.PropertyAmenity.create({ property_id: property.id, name: amenity, company_id: companyId });
    }
    for (const unitSpec of spec.units) {
      // eslint-disable-next-line no-await-in-loop
      const unit = await propertyModels.PropertyUnits.create({
        property_id: property.id,
        name: unitSpec.name,
        price: unitSpec.price,
        size: unitSpec.size,
        unit: 'sqm',
        quantity: unitSpec.quantity,
        status: 'available',
      });
      units[unitSpec.key] = { id: unit.id, propertyId: property.id, name: unitSpec.name };
      for (const planKey of spec.plans) {
        // eslint-disable-next-line no-await-in-loop
        await exec(
          `INSERT INTO installment_plan_units (installment_plan_id, property_unit_id, company_id, created_at)
           VALUES (:planId, :unitId, :companyId, :at)`,
          { planId: planIds[planKey], unitId: unit.id, companyId, at: sqlDate(listedAt) },
        );
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await exec(
      `UPDATE properties SET created_at = :at, updated_at = :at WHERE id = :id`,
      { at: sqlDate(listedAt), id: property.id },
    );
    // eslint-disable-next-line no-await-in-loop
    await exec('UPDATE property_units SET created_at = :at, updated_at = :at WHERE property_id = :id',
      { at: sqlDate(listedAt), id: property.id }).catch(() => {});
    // eslint-disable-next-line no-await-in-loop
    await exec('UPDATE property_amenities SET created_at = :at WHERE property_id = :id',
      { at: sqlDate(listedAt), id: property.id }).catch(() => {});
  }

  /* Sales — checkout, receipts and approvals through the real controllers */
  const clientUser = (key) => {
    const row = clients[key];
    return {
      id: row.id, name: row.name, email: row.email, type: 'client', company_id: companyId,
      realtor_id: row.realtor_id, isSuperiorAdmin: false,
    };
  };

  const events = [];
  SALES.forEach((sale, index) => {
    events.push({ when: daysAgo(sale.days, 9 + (index % 6)), kind: 'checkout', sale });
    sale.pays.forEach((pay, payIndex) => {
      const submittedAt = daysAgo(pay.days, 11 + (payIndex % 5));
      events.push({ when: submittedAt, kind: 'submit', sale, pay });
      if (!pay.pending) {
        events.push({ when: new Date(submittedAt.getTime() + 3 * 3600000), kind: 'approve', sale, pay });
      }
    });
  });
  events.sort((a, b) => a.when - b.when);

  let reference = 240911;
  for (const event of events) {
    const { sale } = event;
    if (event.kind === 'checkout') {
      // eslint-disable-next-line no-await-in-loop
      const created = await at(event.when, () => call(propertyController.checkoutPurchase, {
        user: clientUser(sale.client),
        params: { id: units[sale.unit].propertyId },
        body: {
          unit_id: units[sale.unit].id,
          quantity: 1,
          payment_type: sale.type,
          installment_plan_id: sale.plan ? planIds[sale.plan] : undefined,
        },
      }));
      sale.invoiceId = created.data.invoice_id;
      sale.total = created.data.amount;
      // The plan was dated from today; move its calendar back to the sale date.
      const shift = Math.round((NOW - event.when) / DAY);
      // eslint-disable-next-line no-await-in-loop
      await exec('UPDATE invoices SET due_date = DATE_SUB(due_date, INTERVAL :shift DAY) WHERE id = :id',
        { shift, id: sale.invoiceId });
      // eslint-disable-next-line no-await-in-loop
      await exec('UPDATE payment_schedules SET due_date = DATE_SUB(due_date, INTERVAL :shift DAY) WHERE invoice_id = :id',
        { shift, id: sale.invoiceId });
    } else if (event.kind === 'submit') {
      const { pay } = event;
      // eslint-disable-next-line no-await-in-loop
      const loaded = await readPaymentPlan(sequelize, sale.invoiceId);
      let amountMinor;
      if (pay.next) {
        const next = loaded.schedules.find((s) => s.settlement_status !== 'paid');
        amountMinor = asMinor(next.principal_outstanding_minor) + asMinor(next.fee_outstanding_minor);
      } else if (pay.share) {
        amountMinor = Math.round(asMinor(loaded.plan.total_minor) * pay.share);
      } else {
        amountMinor = loaded.schedules.reduce(
          (sum, s) => sum + asMinor(s.principal_outstanding_minor) + asMinor(s.fee_outstanding_minor), 0,
        );
      }
      reference += 7919;
      pay.reference = `FT26${reference}NG`;
      pay.amount = toMajor(amountMinor);
      // eslint-disable-next-line no-await-in-loop
      await at(event.when, () => call(financeController.submitInvoiceReceipt, {
        user: clientUser(sale.client),
        params: { id: sale.invoiceId },
        body: {
          document_url: unsplash('1554224155-6726b3ff858f', 1200),
          amount: pay.amount,
          payment_method: 'transfer',
          reference: pay.reference,
          notes: 'Transfer from my GTBank account.',
        },
      }));
      // eslint-disable-next-line no-await-in-loop
      [pay.receipt] = await raw('SELECT id FROM receipts WHERE invoice_id = :id ORDER BY id DESC LIMIT 1',
        { id: sale.invoiceId });
    } else {
      const { pay } = event;
      // eslint-disable-next-line no-await-in-loop
      await at(event.when, () => call(financeController.verifyReceipt, {
        user: adminUser,
        params: { id: pay.receipt.id },
        body: { payment_method: 'transfer', reference: pay.reference, amount: pay.amount },
      }));
    }
  }
  console.log(`Seeded ${SALES.length} sales through checkout, ${events.filter((e) => e.kind === 'submit').length} receipts, `
    + `${events.filter((e) => e.kind === 'approve').length} approved.`);

  /* Timing statuses and default fees, as the nightly job would have them */
  await runScheduleSweep(new Date()).catch((error) => console.warn('[seed-demo] schedule sweep:', error.message));

  /* One realtor asks for a payout of what has vested */
  const requester = realtors.ibrahim.id;
  const vested = await raw(
    `SELECT id FROM commission_entitlements
      WHERE realtor_id = :id AND released_minor > paid_minor AND status IN ('RELEASED', 'PARTIALLY_RELEASED')`,
    { id: requester },
  );
  if (vested.length) {
    await at(daysAgo(2), () => commissionStore.requestPayoutFor(sequelize, {
      realtorId: requester, entitlementIds: vested.map((row) => row.id),
    }));
  }

  /* CRM */
  const pipeline = await crmModels.Pipeline.create({ name: 'Residential Sales', company_id: companyId, created_by: companyAdmin.id });
  const stageIds = {};
  const STAGES = ['New Enquiry', 'Qualification', 'Site Inspection', 'Proposal Sent', 'Negotiation',
    'Payment Processing', 'Documentation', 'Closed Won', 'Closed Lost'];
  const STAGE_COLOURS = ['#64748b', '#0ea5e9', '#8b5cf6', '#f59e0b', '#f97316', '#06b6d4', '#6366f1', '#10b981', '#ef4444'];
  for (const [index, name] of STAGES.entries()) {
    // eslint-disable-next-line no-await-in-loop
    const stage = await crmModels.Stage.create({
      name, pipeline_id: pipeline.id, order: index + 1, color: STAGE_COLOURS[index], company_id: companyId, created_by: companyAdmin.id,
    });
    stageIds[name] = stage.id;
  }
  const sourceIds = {};
  for (const name of ['Website', 'Referral', 'Instagram', 'WhatsApp', 'Walk-In', 'Property Exhibition']) {
    // eslint-disable-next-line no-await-in-loop
    sourceIds[name] = (await crmModels.Source.create({ name, company_id: companyId, created_by: companyAdmin.id })).id;
  }
  const labelIds = {};
  for (const [name, color] of [['Hot Lead', '#ef4444'], ['Warm Lead', '#f97316'], ['Cold Lead', '#64748b'], ['Investor', '#0ea5e9']]) {
    // eslint-disable-next-line no-await-in-loop
    labelIds[name] = (await crmModels.Label.create({ name, color, company_id: companyId, created_by: companyAdmin.id })).id;
  }
  for (const name of ['New', 'Contacted', 'Qualified', 'Proposal Sent', 'Follow-Up', 'Inspection Scheduled',
    'Negotiation', 'Closed Won', 'Closed Lost']) {
    // eslint-disable-next-line no-await-in-loop
    await crmModels.LeadStage.create({ name, company_id: companyId, created_by: companyAdmin.id });
  }
  const leadIds = {};
  for (const lead of LEADS) {
    // eslint-disable-next-line no-await-in-loop
    const row = await crmModels.Lead.create({
      name: lead.name,
      email: emailFor(lead.name, 'mail.test'),
      phone: phoneFor(phoneSeq),
      source_id: sourceIds[lead.source],
      pipeline_id: pipeline.id,
      stage_id: stageIds[lead.stage],
      label_id: labelIds[`${lead.thermal} Lead`],
      status: lead.status,
      assigned_to: realtors[lead.realtor].id,
      created_by: realtors[lead.realtor].id,
      description: `Interested in ${lead.profile.toLowerCase()}. Prefers to be contacted on WhatsApp.`,
      budget_category: lead.budget,
      property_profile: lead.profile,
      intent_driver: lead.profile.startsWith('Land') ? 'Investment' : 'Owner-occupier',
      purchase_window: lead.window,
      lead_thermal: lead.thermal,
      company_id: companyId,
    });
    phoneSeq += 1;
    leadIds[lead.name] = row.id;
    // eslint-disable-next-line no-await-in-loop
    await exec('UPDATE leads SET created_at = :at WHERE id = :id', { at: sqlDate(daysAgo(lead.days, 14)), id: row.id });
  }
  for (const deal of DEALS) {
    const lead = LEADS.find((entry) => entry.name === deal.lead);
    // eslint-disable-next-line no-await-in-loop
    const row = await crmModels.Deal.create({
      name: deal.name,
      amount: deal.amount,
      pipeline_id: pipeline.id,
      stage_id: stageIds[deal.stage],
      lead_id: leadIds[deal.lead],
      status: deal.status,
      assigned_to: realtors[lead.realtor].id,
      expected_close_date: new Date(NOW.getTime() + deal.closeIn * DAY),
      created_by: realtors[lead.realtor].id,
      company_id: companyId,
    });
    // eslint-disable-next-line no-await-in-loop
    await exec('UPDATE deals SET created_at = :at WHERE id = :id', { at: sqlDate(daysAgo(Math.max(lead.days - 2, 0), 15)), id: row.id });
  }
  await exec('UPDATE pipelines SET created_at = :at WHERE company_id = :companyId', { at: sqlDate(daysAgo(200)), companyId });
  for (const table of ['stages', 'sources', 'labels', 'lead_stages']) {
    // eslint-disable-next-line no-await-in-loop
    await exec(`UPDATE ${table} SET created_at = :at WHERE company_id = :companyId`, { at: sqlDate(daysAgo(200)), companyId });
  }

  /* Summary */
  await new Promise((resolve) => { setTimeout(resolve, 1500); }); // let fire-and-forget work drain
  const count = async (sql) => Number((await raw(sql, { companyId }))[0].n);
  const counts = {
    properties: await count('SELECT COUNT(*) n FROM properties WHERE company_id = :companyId'),
    unit_configurations: await count('SELECT COUNT(*) n FROM property_units u JOIN properties p ON p.id = u.property_id WHERE p.company_id = :companyId'),
    invoices: await count('SELECT COUNT(*) n FROM invoices WHERE company_id = :companyId'),
    approved_payments: await count("SELECT COUNT(*) n FROM invoice_payments WHERE company_id = :companyId AND status = 'completed'"),
    pending_receipts: await count("SELECT COUNT(*) n FROM receipts WHERE company_id = :companyId AND status = 'pending'"),
    commission_entitlements: await count('SELECT COUNT(*) n FROM commission_entitlements WHERE company_id = :companyId'),
    leads: await count('SELECT COUNT(*) n FROM leads WHERE company_id = :companyId'),
    deals: await count('SELECT COUNT(*) n FROM deals WHERE company_id = :companyId'),
  };
  const statuses = await raw('SELECT status, COUNT(*) n FROM invoices WHERE company_id = :companyId GROUP BY status', { companyId });

  const line = '─'.repeat(64);
  console.log(`\n${line}`);
  console.log(`Demo data ready in database "${DEMO_DB}"`);
  console.log(`Company: Realx8   code: ${COMPANY_CODE}`);
  console.log(`Counts: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`Invoices by status: ${statuses.map((s) => `${s.status} ${s.n}`).join(', ')}`);
  console.log(`\nEvery login's password: ${DEMO_PASSWORD}   (local demo-only)`);
  console.log(`  platform admin   ${platformAdmin?.email}`);
  console.log(`  company admin    ${companyAdmin.email}`);
  Object.values(realtors).forEach((r) => console.log(`  realtor          ${r.email}`));
  Object.values(clients).forEach((c) => console.log(`  client           ${c.email}`));
  console.log('\nStart a second server against it (PORT is server.js\'s port variable):');
  console.log(`  DB_NAME=${DEMO_DB} REDIS_URL= SMTP_HOST= SMTP_USER= SMTP_PASS= SMS_ENABLED=false SINGLE_SESSION_ENABLED=false CORS_ALLOWED_ORIGINS=http://localhost:5182 PORT=3100 node server.js`);
  console.log('and point Realx8-Ui at it:  DEV_API_TARGET=http://localhost:3100 npx vite --port 5182');
  console.log(`Outbound traffic suppressed during seeding: ${suppressed.mail} mail, ${suppressed.sms} sms, ${suppressed.fetch} http.`);
  console.log(line);
};

main()
  .then(async () => {
    await closeAllPools();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('seed-demo failed:', error);
    await closeAllPools();
    process.exit(1);
  });

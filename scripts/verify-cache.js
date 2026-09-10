/**
 * The cache layer, verified against a real MySQL and a real Redis.
 *
 * The unit-level behaviour of cache.js is covered by its own checks; what this
 * script exists for is the property that a cache can silently destroy and that
 * no amount of testing get/set will reveal: ISOLATION. A key that collides
 * across companies or users turns a caching change into a data leak, and it
 * would look exactly like a working cache in every other test.
 *
 * Runs against a throwaway database, never the development one.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const mysql = require('mysql2/promise');
const { Sequelize, QueryTypes } = require('sequelize');

const SOURCE_DB = process.env.DB_NAME;
const DB = `${SOURCE_DB}_verify_cache`;

process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
process.env.CACHE_PREFIX = 'verifycache';
delete process.env.CACHE_ENABLED;

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, multipleStatements: true,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  const sequelize = new Sequelize(DB, process.env.DB_USER, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    dialect: 'mysql', logging: false,
  });

  // Only the tables the cached readers touch.
  await sequelize.query(`
    CREATE TABLE permissions (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) UNIQUE);
  `);
  await sequelize.query(`CREATE TABLE roles (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120), company_id INT NULL);`);
  await sequelize.query(`CREATE TABLE role_permissions (role_id INT, permission_id INT);`);
  await sequelize.query(`
    CREATE TABLE users (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120), company_id INT NULL,
      is_active TINYINT DEFAULT 1, deleted_at DATETIME NULL
    );
  `);
  await sequelize.query(`CREATE TABLE user_roles (user_id INT, role_id INT);`);
  await sequelize.query(`
    CREATE TABLE notification_configs (
      id INT AUTO_INCREMENT PRIMARY KEY, company_id INT NULL, event_key VARCHAR(120),
      enabled TINYINT DEFAULT 1, notify_subject TINYINT DEFAULT 1, notify_realtor TINYINT DEFAULT 0,
      notify_permissions TEXT, channel VARCHAR(20) DEFAULT 'both'
    );
  `);

  // Two companies. Company 1 is ours, company 2 is the rival that must never
  // appear in company 1's answers.
  await sequelize.query(`INSERT INTO permissions (name) VALUES ('finance.invoices.view'), ('finance.invoices.edit');`);
  await sequelize.query(`INSERT INTO roles (id, name, company_id) VALUES (10,'accountant',1), (20,'accountant',2);`);
  await sequelize.query(`INSERT INTO role_permissions VALUES (10,1), (20,1);`);
  await sequelize.query(`
    INSERT INTO users (id, name, company_id) VALUES
      (100,'Ours A',1), (101,'Ours B',1), (200,'Rival',2), (300,'Platform',NULL);
  `);
  await sequelize.query(`INSERT INTO user_roles VALUES (100,10), (101,10), (200,20);`);

  const { cache } = require('../shared/src/cache');
  const { usersWithPermissions, resolveNotificationConfig } = require('../shared/src/notificationConfig');
  const evict = require('../shared/src/cacheEvict');
  await sleep(700);
  check('Backend is redis (so eviction is cross-instance)',
    cache.stats().backend === 'redis', JSON.stringify(cache.stats()));
  await cache.delByPrefix('');

  // ── Counting real queries, to prove the cache is actually used ────────────
  let queries = 0;
  const counted = new Sequelize(DB, process.env.DB_USER, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306, dialect: 'mysql',
    logging: () => { queries += 1; },
  });

  console.log('\n── Isolation: the property a bad cache key destroys ─────────────');

  const ours = await usersWithPermissions(counted, { companyId: 1, permissionNames: ['finance.invoices.view'] });
  const rival = await usersWithPermissions(counted, { companyId: 2, permissionNames: ['finance.invoices.view'] });
  const platform = await usersWithPermissions(counted, { companyId: null, permissionNames: ['finance.invoices.view'] });

  check('Company 1 sees only its own users',
    JSON.stringify([...ours].sort()) === '[100,101]', JSON.stringify(ours));
  check('Company 2 gets a DIFFERENT answer, not company 1\'s cached one',
    JSON.stringify(rival) === '[200]', JSON.stringify(rival));
  check('The platform scope does not inherit a company\'s cached answer',
    JSON.stringify(platform) === '[]', `${JSON.stringify(platform)} — user 300 holds no role`);

  // Re-read: same answers, no new queries.
  const before = queries;
  const oursAgain = await usersWithPermissions(counted, { companyId: 1, permissionNames: ['finance.invoices.view'] });
  const rivalAgain = await usersWithPermissions(counted, { companyId: 2, permissionNames: ['finance.invoices.view'] });
  check('Repeat reads hit the cache (no further queries)',
    queries === before, `queries added=${queries - before}`);
  check('Cached repeats keep the companies separate',
    JSON.stringify(oursAgain) === JSON.stringify(ours)
      && JSON.stringify(rivalAgain) === JSON.stringify(rival),
    `${JSON.stringify(oursAgain)} vs ${JSON.stringify(rivalAgain)}`);

  // A different permission set must be a different key, not a cache hit.
  const editors = await usersWithPermissions(counted, { companyId: 1, permissionNames: ['finance.invoices.edit'] });
  check('A different permission set is a different key',
    JSON.stringify(editors) === '[]', `${JSON.stringify(editors)} — nobody holds edit`);

  // Order must not create a second entry for the same question.
  const q1 = queries;
  await usersWithPermissions(counted, { companyId: 1, permissionNames: ['finance.invoices.view', 'finance.invoices.edit'] });
  const q2 = queries;
  await usersWithPermissions(counted, { companyId: 1, permissionNames: ['finance.invoices.edit', 'finance.invoices.view'] });
  check('Permission order does not split one answer into two entries',
    queries === q2 && q2 > q1, `first=${q2 - q1} query, reordered=${queries - q2} queries`);

  console.log('\n── Eviction: a revoked permission stops being served ────────────');

  // Revoke view from company 1's role.
  await sequelize.query(`DELETE FROM role_permissions WHERE role_id = 10 AND permission_id = 1;`);
  const stillCached = await usersWithPermissions(counted, { companyId: 1, permissionNames: ['finance.invoices.view'] });
  check('Before eviction the stale answer is still served (the risk being managed)',
    JSON.stringify([...stillCached].sort()) === '[100,101]',
    'this is why authorisation TTLs are minutes and eviction is explicit');

  await evict.evictRole(10);
  const afterEvict = await usersWithPermissions(counted, { companyId: 1, permissionNames: ['finance.invoices.view'] });
  check('After evictRole the revocation is visible',
    JSON.stringify(afterEvict) === '[]', JSON.stringify(afterEvict));
  const rivalUntouched = await usersWithPermissions(counted, { companyId: 2, permissionNames: ['finance.invoices.view'] });
  check('Company 2 is unaffected by company 1\'s eviction',
    JSON.stringify(rivalUntouched) === '[200]', JSON.stringify(rivalUntouched));

  console.log('\n── Deactivating a user drops them from recipients ───────────────');
  await sequelize.query(`INSERT INTO role_permissions VALUES (10,1);`);
  await evict.evictRole(10);
  const bothActive = await usersWithPermissions(counted, { companyId: 1, permissionNames: ['finance.invoices.view'] });
  await sequelize.query(`UPDATE users SET is_active = 0 WHERE id = 101;`);
  await evict.evictUserMembership(101);
  const oneActive = await usersWithPermissions(counted, { companyId: 1, permissionNames: ['finance.invoices.view'] });
  check('A deactivated user is no longer notified',
    JSON.stringify(bothActive.sort()) === '[100,101]' && JSON.stringify(oneActive) === '[100]',
    `${JSON.stringify(bothActive)} -> ${JSON.stringify(oneActive)}`);

  console.log('\n── Notification config: cached, scoped, evicted ─────────────────');

  await sequelize.query(`
    INSERT INTO notification_configs (company_id, event_key, enabled, notify_subject, notify_permissions)
    VALUES (NULL, 'invoice_created', 1, 1, '["finance.invoices.view"]');
  `);
  await sequelize.query(`
    INSERT INTO notification_configs (company_id, event_key, enabled, notify_subject, notify_permissions)
    VALUES (1, 'invoice_created', 0, 0, '[]');
  `);
  await evict.evictNotificationConfig(null);

  const c1 = (await resolveNotificationConfig(counted, 1))('invoice_created');
  const c2 = (await resolveNotificationConfig(counted, 2))('invoice_created');
  check('Company 1 gets its OWN configuration (event switched off)',
    c1.enabled === false, JSON.stringify(c1));
  check('Company 2, with no rows, does not receive company 1\'s cached config',
    c2.enabled === true, JSON.stringify(c2));

  const qBefore = queries;
  await resolveNotificationConfig(counted, 1);
  check('A repeat resolve costs no query', queries === qBefore, `added=${queries - qBefore}`);

  // The company switches the event back on.
  await sequelize.query(`UPDATE notification_configs SET enabled = 1 WHERE company_id = 1;`);
  await evict.evictNotificationConfig(1);
  const c1After = (await resolveNotificationConfig(counted, 1))('invoice_created');
  check('After eviction the company sees its own change',
    c1After.enabled === true, JSON.stringify(c1After));

  // A PLATFORM save must drop the companies that resolve against it.
  await sequelize.query(`UPDATE notification_configs SET channel = 'email' WHERE company_id IS NULL;`);
  await evict.evictNotificationConfig(null);
  const c2After = (await resolveNotificationConfig(counted, 2))('invoice_created');
  check('A platform-level save reaches companies that inherit from it',
    c2After.channel === 'email',
    `channel=${c2After.channel} — company 2 has no rows of its own, so it must see this`);

  console.log('\n── A failed load is never cached ────────────────────────────────');
  await sequelize.query(`RENAME TABLE notification_configs TO notification_configs_hidden;`);
  await evict.evictNotificationConfig(null);
  const broken = (await resolveNotificationConfig(counted, 1))('invoice_created');
  await sequelize.query(`RENAME TABLE notification_configs_hidden TO notification_configs;`);
  const recovered = (await resolveNotificationConfig(counted, 1))('invoice_created');
  check('An outage falls back to the event CATALOGUE, not to silence',
    broken.enabled === true && broken.permissions.includes('finance.invoices.view'),
    `${JSON.stringify(broken)} — a missed OVERDUE notice is the failure that matters, `
      + 'so an unreadable config table must not mean nobody is told');
  /**
   * Company 1 has its OWN row, so recovery must show that row rather than the
   * catalogue. The two are distinguishable: the catalogue says subject:true and
   * carries a permission, company 1's row says subject:false and carries none.
   * Asserting on those fields is what makes this a real check — asserting only
   * on `enabled` would pass against either.
   */
  check('The fallback is not cached, so recovery reads the database again',
    recovered.subject === false && recovered.permissions.length === 0,
    `after recovery=${JSON.stringify(recovered)} — company 1's own row `
      + '(subject:false, no permissions), not the catalogue it fell back to during the outage');

  console.log('\n── The kill switch ─────────────────────────────────────────────');
  process.env.CACHE_ENABLED = 'false';
  const { createCache } = require('../shared/src/cache');
  const off = createCache();
  await sleep(300);
  await off.set('x', 1, 60);
  check('CACHE_ENABLED=false makes every read a miss', (await off.get('x')) === null);
  delete process.env.CACHE_ENABLED;

  // ── Teardown ─────────────────────────────────────────────────────────────
  await cache.delByPrefix('');
  await cache.disconnect();
  await off.disconnect();
  await sequelize.close();
  await counted.close();
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();

  console.log(`\n  ${pass}/${pass + fail} passed.\n`);
  process.exit(fail ? 1 : 0);
})().catch(async (error) => {
  console.error('ABORTED:', error);
  process.exit(1);
});

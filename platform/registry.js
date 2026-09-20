/**
 * The service registry — the single source of truth for what this backend is
 * made of and which URL prefix belongs to which service.
 *
 * Both deployment shapes read this one table:
 *
 *   server.js                   mounts every enabled service in ONE process and
 *                               HTTP-proxies the rest (the default: one deploy).
 *   services/api-gateway        proxies every prefix to a separately deployed
 *                               service (the fully split shape).
 *
 * That is the whole point of keeping it here: adding a route prefix or moving
 * one between services is a one-line change that both shapes pick up, so the
 * two can never drift apart.
 *
 * `prefixes` is the API contract with Realx8-Ui. Do not rename one without
 * changing the frontend call that uses it.
 */

const SERVICES = [
  // Listed in BOOT order, not routing order. user-service is first because it
  // owns `users`, `companies` and `settings` — tables the other services read
  // (and, in auth-service's case, add a column to) during their own migrations.
  // Prefixes never overlap on a path segment, so routing order is irrelevant.
  {
    name: 'user',
    dir: 'user-service',
    port: 3002,
    urlEnv: 'USER_SERVICE_URL',
    prefixes: [
      '/users', '/employees', '/clients', '/dashboard', '/realtor-kyc',
      '/realtor-levels', '/realtors', '/roles', '/permissions', '/settings',
      '/share', '/companies', '/platform', '/my-company', '/media',
      // The audit trail. Owned by this service because it owns `users` and
      // `companies`, which are what an entry is scoped and attributed to — but
      // WRITTEN by all nine, so every service's activity lands in one table.
      '/audit-logs',
      '/social-accounts', '/training', '/leaderboard', '/recruitment', '/uploads',
    ],
  },
  {
    name: 'auth',
    dir: 'auth-service',
    port: 3001,
    urlEnv: 'AUTH_SERVICE_URL',
    prefixes: ['/auth'],
  },
  {
    name: 'property',
    dir: 'property-service',
    port: 3003,
    urlEnv: 'PROPERTY_SERVICE_URL',
    prefixes: [
      '/properties', '/property-types', '/property-units', '/property-documents',
      '/purchase-requests', '/inspections', '/public',
      /**
       * Promotions, and the per-unit price they produce. Both top-level, so
       * both have to be named here — a route added to a service's own router
       * is unreachable until the gateway knows which service owns its path,
       * and the symptom is a flat "no route found" with nothing in the log.
       */
      '/promotions', '/units',
      // A company's offices. Top-level, so it needs naming here too.
      '/branches',
    ],
  },
  {
    name: 'investment',
    dir: 'investment-service',
    port: 3004,
    urlEnv: 'INVESTMENT_SERVICE_URL',
    prefixes: [
      '/investments', '/investment-plans', '/investment-categories',
      '/investment-periods',
    ],
  },
  {
    name: 'crm',
    dir: 'crm-service',
    port: 3005,
    urlEnv: 'CRM_SERVICE_URL',
    prefixes: [
      '/leads', '/lead-stages', '/deals', '/tasks', '/task-stages', '/pipelines',
      '/stages', '/sources', '/labels', '/objections', '/activities', '/crm',
      '/analytics',
    ],
  },
  {
    name: 'finance',
    dir: 'finance-service',
    port: 3006,
    urlEnv: 'FINANCE_SERVICE_URL',
    prefixes: [
      '/invoices', '/payment-analysis', '/payment-plans', '/payment-reminders',
      // The buyer's own view of what they bought. A TOP-LEVEL prefix, so it has
      // to be registered here — a route added to finance-service's router is
      // unreachable until the gateway knows which service owns its path, and
      // the symptom is a flat "no route found" with nothing in the service log.
      '/my-properties',
      '/payments', '/taxes', '/transactions', '/bank-accounts', '/credit-notes',
      /*
       * '/debit-notes' is gone (ACC-0.6). The instrument did three unrelated
       * jobs — paying commission, refunding an overpayment, and charging a
       * party — none of which is what a debit note means. Each has its own
       * document now.
       */
      '/commissions', '/commission-rules', '/receipts',
      '/referral', '/reports',
      /**
       * Approval queue for credit and debit notes, and the reminder-schedule
       * configuration. Both top-level, so both have to be named here.
       */
      '/notes', '/reminder-schedules',
      // Refunding an overpayment (ACC-0.5). Top-level, so it has to be named.
      '/refunds',
      // A realtor's or client's own notes. Top-level and separate from
      // '/notes' on purpose — see the routes file.
      '/my-notes',
      /**
       * The commission ENGINE's configuration — distinct from '/commissions',
       * which is the older per-sale payable. Both top-level, so both have to be
       * named here: a route added to finance-service's router is unreachable
       * until the gateway knows which service owns its path, and the symptom is
       * a flat "no route found" with nothing in the service log.
       */
      '/commission-plans', '/commission-plan-versions',
      '/commission-reports', '/commission-payouts', '/commission-statements',
      // The property purchase journey. `/installment-plans` is the plan
      // templates and is a different resource from `/payment-plans` above,
      // which is the subscription price list.
      '/installment-plans', '/payment-schedules',
      /**
       * The general ledger — the chart of accounts, the journal and the
       * statements read off it. Top-level, so it has to be named here like
       * every other prefix above: a route added to finance-service's router is
       * unreachable until the gateway knows which service owns its path.
       */
      '/ledger',
      /*
       * The entitlement approval queue, which is a commission route rather
       * than an accounting one but shares the top-level problem above.
       */
      '/commission-entitlements',
    ],
  },
  {
    name: 'notification',
    dir: 'notification-service',
    port: 3007,
    urlEnv: 'NOTIFICATION_SERVICE_URL',
    prefixes: ['/notifications', '/notification-templates', '/notification-configs'],
  },
  {
    name: 'support',
    dir: 'support-service',
    port: 3008,
    urlEnv: 'SUPPORT_SERVICE_URL',
    prefixes: ['/support', '/assistant', '/visitors', '/attendance', '/care'],
  },
];

/**
 * The assistant streams its reply and may run several tool rounds first, so it
 * needs longer than a normal request — 30s would cut an answer mid-sentence.
 * Only relevant when the prefix is being proxied to another process.
 */
const LONG_RUNNING_PREFIXES = ['/assistant'];

const byName = new Map(SERVICES.map((service) => [service.name, service]));

/** prefix -> service, for O(1) first-segment routing. */
const byPrefix = new Map();
SERVICES.forEach((service) => {
  service.prefixes.forEach((prefix) => {
    if (byPrefix.has(prefix)) {
      throw new Error(`Registry: prefix ${prefix} is claimed by both `
        + `${byPrefix.get(prefix).name} and ${service.name}`);
    }
    byPrefix.set(prefix, service);
  });
});

/** Where a service lives when it is a separate deployment. */
const targetUrl = (service) => process.env[service.urlEnv]
  || `http://localhost:${service.port}`;

module.exports = {
  SERVICES,
  LONG_RUNNING_PREFIXES,
  byName,
  byPrefix,
  targetUrl,
  serviceNames: SERVICES.map((s) => s.name),
};

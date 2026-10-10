const { QueryTypes } = require('sequelize');
const { cache } = require('./cache');

/**
 * Subscription billing: plans, a 7-day trial, user limits, and what a company
 * can still do once its subscription has lapsed.
 *
 * ── Behind a flag ───────────────────────────────────────────────────────────
 *
 * BILLING_ENABLED turns all of it on, and it is OFF unless set to "true" —
 * production sets it (render.yaml); development and local databases never see
 * a trial clock, a limit or a read-only company. With it off every function
 * here answers "allowed" and the app behaves exactly as it did before billing.
 *
 * ── The rules (agreed with the business) ────────────────────────────────────
 *
 *   - A new company gets a 7-day trial: all features, no user limit, no card.
 *   - Plans limit USER ACCOUNTS in the company — every account, clients
 *     included. A person in two companies has two accounts, so counts once in
 *     each.
 *   - When a trial or paid period ends there are 3 days' grace, then the
 *     company is LAPSED: read-only for its admins and staff. Clients can still
 *     buy (checkout creates the invoice) and upload proof of payment; realtors
 *     can still recommend (share and referral links, leads).
 *   - Sign-ups to a lapsed company, or one at its user limit, are HELD: the
 *     account exists but is inactive, waits in a queue the admin can see, and
 *     is released only when the company renews or upgrades
 *     (releaseHeldAccounts in user-service's billing service).
 *
 * The state is DERIVED from dates every time it is read, never stored as
 * "lapsed": a missed sweep cannot leave a company locked or unlocked wrongly.
 *
 * Writes (trials, payments, releases) live in user-service, which owns the
 * tables through its models. This module only reads, so every service — and
 * the edge — can ask the same questions the same way.
 */

const TRIAL_DAYS = 7;
const GRACE_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const isBillingEnabled = () => String(process.env.BILLING_ENABLED ?? 'false').toLowerCase() === 'true';

/** The plans as launched. Seeded once (user-service); platform admins edit them after. */
const SEED_PLANS = [
  {
    code: 'starter', name: 'Starter', description: 'For small and growing real estate companies',
    monthly_price: 50000, annual_price: 500000, user_limit: 100, sort_order: 1,
  },
  {
    code: 'professional', name: 'Professional', description: 'For expanding real estate businesses',
    monthly_price: 75000, annual_price: 750000, user_limit: 250, sort_order: 2,
  },
  {
    code: 'enterprise', name: 'Enterprise', description: 'For large developers and real estate organizations',
    monthly_price: 100000, annual_price: 1000000, user_limit: null, sort_order: 3,
  },
];

const toNumber = (value) => (value === null || value === undefined ? null : Number(value));
const toDate = (value) => (value ? new Date(value) : null);

const presentPlan = (row) => ({
  code: row.code,
  name: row.name,
  description: row.description || '',
  monthly_price: toNumber(row.monthly_price),
  annual_price: toNumber(row.annual_price),
  currency: row.currency || 'NGN',
  user_limit: toNumber(row.user_limit),
  sort_order: toNumber(row.sort_order) || 0,
  active: row.active === undefined ? true : Boolean(Number(row.active) || row.active === true),
});

/** Active plans, cheapest first — what the website and the app show. */
const listPlans = async (sequelize, { includeInactive = false } = {}) => {
  const rows = await sequelize.query(
    `SELECT code, name, description, monthly_price, annual_price, currency, user_limit, sort_order, active
       FROM billing_plans ORDER BY sort_order ASC, monthly_price ASC`,
    { type: QueryTypes.SELECT },
  ).catch(() => []);
  const plans = rows.map(presentPlan);
  return includeInactive ? plans : plans.filter((p) => p.active);
};

const planByCode = async (sequelize, code) => {
  if (!code) return null;
  const [row] = await sequelize.query(
    `SELECT code, name, description, monthly_price, annual_price, currency, user_limit, sort_order, active
       FROM billing_plans WHERE code = :code`,
    { replacements: { code }, type: QueryTypes.SELECT },
  ).catch(() => []);
  return row ? presentPlan(row) : null;
};

/**
 * Where a subscription stands at `now`, from its dates alone.
 *
 *   trialing → trial running              (no limit)
 *   active   → paid period running        (plan's limit)
 *   grace    → ended, within GRACE_DAYS   (still usable; banner)
 *   lapsed   → ended, past grace          (read-only)
 *   none     → no subscription row        (treated as allowed: never locks a
 *                                          company out because a row is missing)
 */
const effectiveState = (sub, now = new Date()) => {
  if (!sub) return { status: 'none', endsAt: null, graceEndsAt: null, readOnly: false };
  const ref = sub.status === 'trialing' ? toDate(sub.trial_ends_at) : toDate(sub.current_period_end);
  if (sub.status === 'cancelled' && !ref) return { status: 'lapsed', endsAt: null, graceEndsAt: null, readOnly: true };
  if (!ref) return { status: sub.status === 'trialing' ? 'trialing' : 'active', endsAt: null, graceEndsAt: null, readOnly: false };
  const graceEndsAt = new Date(ref.getTime() + GRACE_DAYS * DAY_MS);
  if (now < ref) {
    return { status: sub.status === 'trialing' ? 'trialing' : 'active', endsAt: ref, graceEndsAt, readOnly: false };
  }
  if (now < graceEndsAt) return { status: 'grace', endsAt: ref, graceEndsAt, readOnly: false };
  return { status: 'lapsed', endsAt: ref, graceEndsAt, readOnly: true };
};

const subscriptionFor = async (sequelize, companyId) => {
  const [row] = await sequelize.query(
    `SELECT company_id, plan_code, billing_interval, status, trial_ends_at,
            current_period_end, auto_renew, paystack_authorization_code
       FROM company_subscriptions WHERE company_id = :companyId`,
    { replacements: { companyId }, type: QueryTypes.SELECT },
  );
  return row || null;
};

/** Every account in the company that is live and not waiting in the queue. */
const countMembers = async (sequelize, companyId) => {
  const [row] = await sequelize.query(
    `SELECT COUNT(*) AS n FROM users
      WHERE company_id = :companyId AND deleted_at IS NULL
        AND is_active = :yes AND (billing_hold IS NULL OR billing_hold = :no)`,
    { replacements: { companyId, yes: true, no: false }, type: QueryTypes.SELECT },
  );
  return Number(row?.n || 0);
};

const countHeld = async (sequelize, companyId) => {
  const [row] = await sequelize.query(
    `SELECT COUNT(*) AS n FROM users
      WHERE company_id = :companyId AND deleted_at IS NULL AND billing_hold = :yes`,
    { replacements: { companyId, yes: true }, type: QueryTypes.SELECT },
  );
  return Number(row?.n || 0);
};

const billingKey = (companyId) => `billing:company:${companyId}`;
const BILLING_TTL = 60;

/**
 * The company's billing state, cached for a minute and evicted on every change
 * (evictBilling). What the edge gate, sign-up and the app's banners read.
 */
const billingState = async (sequelize, companyId, { fresh = false } = {}) => {
  if (!isBillingEnabled()) return { enabled: false, status: 'off', readOnly: false };
  if (companyId === null || companyId === undefined) return { enabled: true, status: 'platform', readOnly: false };
  const load = async () => {
    const sub = await subscriptionFor(sequelize, companyId);
    const state = effectiveState(sub);
    const plan = sub?.plan_code ? await planByCode(sequelize, sub.plan_code) : null;
    return {
      enabled: true,
      companyId: Number(companyId),
      status: state.status,
      readOnly: state.readOnly,
      endsAt: state.endsAt ? state.endsAt.toISOString() : null,
      graceEndsAt: state.graceEndsAt ? state.graceEndsAt.toISOString() : null,
      trial: sub?.status === 'trialing',
      planCode: sub?.plan_code || null,
      planName: plan?.name || null,
      interval: sub?.billing_interval || null,
      // The trial has no limit: the company sees everything before choosing.
      userLimit: sub?.status === 'trialing' ? null : (plan ? plan.user_limit : null),
      autoRenew: Boolean(Number(sub?.auto_renew) || sub?.auto_renew === true),
      hasCard: Boolean(sub?.paystack_authorization_code),
    };
  };
  if (fresh) return load();
  return cache.wrap(billingKey(companyId), BILLING_TTL, load);
};

const evictBilling = async (companyId) => {
  if (companyId === null || companyId === undefined) return;
  await cache.del(billingKey(companyId)).catch(() => {});
};

/**
 * May one more account join this company now?
 *   { admit: true }                          — go ahead
 *   { admit: false, reason: 'lapsed'|'limit' } — hold it in the queue
 */
const canAdmitMember = async (sequelize, companyId) => {
  if (!isBillingEnabled() || companyId === null || companyId === undefined) return { admit: true };
  const state = await billingState(sequelize, companyId, { fresh: true });
  if (state.readOnly) return { admit: false, reason: 'lapsed', state };
  if (state.userLimit === null || state.userLimit === undefined) return { admit: true, state };
  const used = await countMembers(sequelize, companyId);
  return used < state.userLimit ? { admit: true, state } : { admit: false, reason: 'limit', state };
};

const heldMessage = (companyName) => `Your account has been created and is waiting for ${companyName || 'the company'} `
  + 'to complete its setup. You will get an email as soon as you can sign in.';

/* ── What a lapsed company may still do ────────────────────────────────────── */

const anyone = [
  ['*', /^\/auth\//],
  ['*', /^\/billing(\/|$)/],
  ['*', /^\/webhooks\//],
  ['POST', /^\/legal\/terms\/accept$/],
  ['PUT', /^\/notifications\/(read-all|\d+\/read)$/],
  ['*', /^\/notifications\/push\//],
  ['*', /^\/notifications\/devices(\/|$)/],
  ['POST', /^\/assistant\//],
];
const forClients = [
  ['POST', /^\/properties\/\d+\/checkout$/],
  ['POST', /^\/purchase-requests$/],
  ['POST', /^\/media\/upload$/],
  ['POST', /^\/invoices\/\d+\/receipts$/],
  ['PUT', /^\/receipts\/\d+$/],
  ['POST', /^\/receipts\/\d+\/cancel$/],
];
const forRealtors = [
  ['POST', /^\/share\/token$/],
  ['POST', /^\/properties\/\d+\/share-link$/],
  ['POST', /^\/leads$/],
  ['POST', /^\/inspections$/],
  // A realtor buying for themselves or a client is a sale, not admin work.
  ['POST', /^\/properties\/\d+\/checkout$/],
  ['POST', /^\/purchase-requests$/],
  ['POST', /^\/media\/upload$/],
];

const matches = (rules, method, path) => rules.some(([m, re]) => (m === '*' || m === method) && re.test(path));

/**
 * Whether a request may proceed while the company is lapsed. Reads always
 * may; writes only from the allow-lists above. `path` is the API path without
 * any /api prefix (req.securityPath at the edge).
 */
const allowedWhileLapsed = ({ method, path, user }) => {
  const verb = String(method || 'GET').toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(verb)) return true;
  const p = String(path || '').split('?')[0].replace(/\/+$/, '') || '/';
  if (matches(anyone, verb, p)) return true;
  // Your own profile, and nobody else's.
  const self = p.match(/^\/users\/(\d+)$/);
  if (self && verb === 'PUT' && Number(self[1]) === Number(user?.id)) return true;
  const type = String(user?.effectiveType || user?.type || '');
  if (type === 'client') return matches(forClients, verb, p);
  if (type === 'realtor') return matches(forRealtors, verb, p);
  return false;
};

const LAPSED_MESSAGE = 'Your company\'s subscription is inactive, so this is read-only for now. '
  + 'A company admin can renew it under Billing & plan.';

module.exports = {
  TRIAL_DAYS,
  GRACE_DAYS,
  DAY_MS,
  SEED_PLANS,
  isBillingEnabled,
  listPlans,
  planByCode,
  effectiveState,
  subscriptionFor,
  countMembers,
  countHeld,
  billingState,
  evictBilling,
  canAdmitMember,
  heldMessage,
  allowedWhileLapsed,
  LAPSED_MESSAGE,
};

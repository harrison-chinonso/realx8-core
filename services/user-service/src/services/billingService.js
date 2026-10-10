const crypto = require('crypto');
const cron = require('node-cron');
const { Op } = require('sequelize');
const billing = require('../../../../shared/src/billing');
const { createNotifier } = require('../../../../shared/src/notifier');

/**
 * Subscription billing's writes: plans, trials, payments, the sign-up queue,
 * Paystack and the daily sweep. The rules themselves are in
 * shared/src/billing.js; this file is what changes the data.
 *
 * Everything that makes a company billing-active again — a Paystack payment
 * (redirect, webhook or automatic renewal), a payment recorded by a platform
 * admin, or a plan change — goes through activatePeriod / changePlan, and
 * those are the ONLY callers of releaseHeldAccounts. That is the agreed rule:
 * held sign-ups are completed when, and only when, the company renews.
 */

const models = () => require('../models');
const addMonths = (date, months) => {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
};
const frontend = () => String(process.env.FRONTEND_URL || '').replace(/\/+$/, '');
const ADMIN_TYPES = ['super_admin', 'admin'];

/* ── Setup ─────────────────────────────────────────────────────────────── */

/** Seed the plans once (never overwrite an admin's edits), and start trials where billing is on. */
const prepareBilling = async ({ BillingPlan, Company, CompanySubscription }) => {
  for (const plan of billing.SEED_PLANS) {
    // eslint-disable-next-line no-await-in-loop
    await BillingPlan.findOrCreate({ where: { code: plan.code }, defaults: plan });
  }
  if (!billing.isBillingEnabled()) return;
  /*
   * Every company without a subscription starts a fresh 7-day trial — the
   * agreed treatment of existing companies when billing first goes live. Rows
   * are only ever inserted, so this does nothing on later boots.
   */
  const have = new Set((await CompanySubscription.findAll({ attributes: ['company_id'] })).map((r) => Number(r.company_id)));
  const companies = await Company.findAll({ attributes: ['id'] });
  const trialEnd = new Date(Date.now() + billing.TRIAL_DAYS * billing.DAY_MS);
  let started = 0;
  for (const company of companies) {
    if (have.has(Number(company.id))) continue;
    // eslint-disable-next-line no-await-in-loop
    await CompanySubscription.create({ company_id: company.id, status: 'trialing', trial_ends_at: trialEnd });
    started += 1;
  }
  if (started) console.log(`[billing] started a ${billing.TRIAL_DAYS}-day trial for ${started} existing compan${started === 1 ? 'y' : 'ies'}`);
};

/** A new company's trial. Only where billing is on: a trial started while it is off would be long expired by the time it is switched on. */
const startTrial = async (companyId, { transaction } = {}) => {
  if (!billing.isBillingEnabled()) return null;
  const { CompanySubscription } = models();
  const [row] = await CompanySubscription.findOrCreate({
    where: { company_id: companyId },
    defaults: { company_id: companyId, status: 'trialing', trial_ends_at: new Date(Date.now() + billing.TRIAL_DAYS * billing.DAY_MS) },
    transaction,
  });
  await billing.evictBilling(companyId);
  return row;
};

/* ── The queue ─────────────────────────────────────────────────────────── */

/**
 * Completes held sign-ups, oldest first, as far as the plan's limit allows.
 * Called only from activatePeriod and changePlan. Anyone still over the limit
 * stays held. Safe to run twice: released accounts are no longer held.
 */
const releaseHeldAccounts = async (companyId) => {
  const { User, sequelize } = models();
  await billing.evictBilling(companyId);
  const state = await billing.billingState(sequelize, companyId, { fresh: true });
  if (state.enabled && state.readOnly) return [];
  const held = await User.findAll({
    where: { company_id: companyId, billing_hold: true, deleted_at: null },
    order: [['id', 'ASC']],
  });
  if (!held.length) return [];
  let slots = Infinity;
  if (state.enabled && state.userLimit !== null && state.userLimit !== undefined) {
    slots = Math.max(0, state.userLimit - await billing.countMembers(sequelize, companyId));
  }
  const toRelease = held.slice(0, slots === Infinity ? held.length : slots);
  const { notifyUser } = createNotifier(sequelize);
  for (const user of toRelease) {
    // eslint-disable-next-line no-await-in-loop
    await user.update({ is_active: true, billing_hold: false });
    notifyUser({
      userId: user.id,
      companyId,
      type: 'account_ready',
      title: 'Your account is ready',
      body: 'Your account has been completed. You can now sign in.',
      actionLabel: frontend() ? 'Sign in' : null,
      actionUrl: frontend() ? `${frontend()}/login` : null,
      channel: 'in_app,email,push',
    }).catch(() => {});
  }
  if (toRelease.length) console.log(`[billing] company ${companyId}: released ${toRelease.length} held account(s), ${held.length - toRelease.length} still waiting`);
  return toRelease.map((u) => u.id);
};

/* ── Payments and plan changes ─────────────────────────────────────────── */

/**
 * Records a payment and extends the paid period: from the end of the current
 * period when it is still running (an early renewal loses nothing), else from
 * now. Idempotent by reference. Then releases the queue.
 */
const activatePeriod = async ({
  companyId, planCode, interval, amount, reference, provider, recordedBy = null, note = null,
  authorizationCode = null, email = null,
}) => {
  const { sequelize, CompanySubscription, SubscriptionPayment } = models();
  const plan = await billing.planByCode(sequelize, planCode);
  if (!plan) throw Object.assign(new Error('Unknown plan.'), { status: 422 });
  if (!['monthly', 'annual'].includes(interval)) throw Object.assign(new Error('Interval must be monthly or annual.'), { status: 422 });

  const result = await sequelize.transaction(async (transaction) => {
    if (await SubscriptionPayment.findOne({ where: { reference }, transaction })) return { duplicate: true };
    const [sub] = await CompanySubscription.findOrCreate({
      where: { company_id: companyId }, defaults: { company_id: companyId, status: 'trialing' }, transaction,
    });
    const now = new Date();
    const running = sub.status === 'active' && sub.current_period_end && new Date(sub.current_period_end) > now;
    const start = running ? new Date(sub.current_period_end) : now;
    const end = addMonths(start, interval === 'annual' ? 12 : 1);
    const payment = await SubscriptionPayment.create({
      company_id: companyId, plan_code: plan.code, billing_interval: interval, amount, currency: plan.currency,
      reference, provider, status: 'success', period_start: start, period_end: end, paid_at: now, recorded_by: recordedBy, note,
    }, { transaction });
    await sub.update({
      plan_code: plan.code, billing_interval: interval, status: 'active', current_period_end: end, last_reminder: null,
      ...(authorizationCode ? { paystack_authorization_code: authorizationCode } : {}),
      ...(email ? { paystack_email: email } : {}),
    }, { transaction });
    return { payment, subscription: sub };
  });
  if (result.duplicate) return result;
  const released = await releaseHeldAccounts(companyId);
  return { ...result, released };
};

/** A platform admin's change of plan without a payment (a complimentary plan, a downgrade). */
const changePlan = async ({ companyId, planCode, interval, periodEnd = null }) => {
  const { sequelize, CompanySubscription } = models();
  const plan = await billing.planByCode(sequelize, planCode);
  if (!plan) throw Object.assign(new Error('Unknown plan.'), { status: 422 });
  const [sub] = await CompanySubscription.findOrCreate({ where: { company_id: companyId }, defaults: { company_id: companyId } });
  await sub.update({
    plan_code: plan.code,
    billing_interval: interval || sub.billing_interval || 'monthly',
    status: 'active',
    current_period_end: periodEnd ? new Date(periodEnd) : (sub.current_period_end && sub.status === 'active' ? sub.current_period_end : addMonths(new Date(), 1)),
    last_reminder: null,
  });
  const released = await releaseHeldAccounts(companyId);
  return { subscription: sub, released };
};

const extendTrial = async ({ companyId, days }) => {
  const { CompanySubscription } = models();
  const [sub] = await CompanySubscription.findOrCreate({ where: { company_id: companyId }, defaults: { company_id: companyId } });
  const from = sub.trial_ends_at && new Date(sub.trial_ends_at) > new Date() ? new Date(sub.trial_ends_at) : new Date();
  await sub.update({ status: 'trialing', trial_ends_at: new Date(from.getTime() + days * billing.DAY_MS), last_reminder: null });
  await billing.evictBilling(companyId);
  // A trial has no limit and is not lapsed, so the queue can go too.
  const released = await releaseHeldAccounts(companyId);
  return { subscription: sub, released };
};

/* ── Paystack (the platform's own account) ─────────────────────────────── */

const paystackKey = () => String(process.env.BILLING_PAYSTACK_SECRET_KEY || '').trim();

const paystack = async (path, { method = 'GET', body } = {}) => {
  const key = paystackKey();
  if (!key) throw Object.assign(new Error('Online payment is not set up yet. Please contact us to pay by bank transfer.'), { status: 503 });
  const response = await fetch(`https://api.paystack.co${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.status === false) {
    throw Object.assign(new Error(data.message || 'The payment provider refused the request.'), { status: 502 });
  }
  return data.data;
};

const priceFor = (plan, interval) => (interval === 'annual' ? plan.annual_price : plan.monthly_price);
const newReference = (companyId) => `RXB-${companyId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

/** Paystack's checkout page for a plan; the person comes back to `callbackUrl` with ?reference=. */
const startCheckout = async ({ companyId, planCode, interval, email, callbackUrl }) => {
  const { sequelize } = models();
  const plan = await billing.planByCode(sequelize, planCode);
  if (!plan || !plan.active) throw Object.assign(new Error('Choose one of the available plans.'), { status: 422 });
  if (!['monthly', 'annual'].includes(interval)) throw Object.assign(new Error('Choose monthly or annual billing.'), { status: 422 });
  const reference = newReference(companyId);
  const data = await paystack('/transaction/initialize', {
    method: 'POST',
    body: {
      email,
      amount: Math.round(priceFor(plan, interval) * 100),
      currency: plan.currency,
      reference,
      callback_url: callbackUrl,
      channels: ['card', 'bank', 'ussd', 'bank_transfer'],
      metadata: { kind: 'subscription', company_id: companyId, plan_code: plan.code, interval },
    },
  });
  return { authorization_url: data.authorization_url, reference };
};

/**
 * Settles a Paystack reference: asks Paystack (never trusts the caller), and
 * if it was a successful subscription charge for the right amount, extends the
 * company's period. Used by the redirect back, the webhook and renewals.
 */
const confirmReference = async (reference, { expectCompanyId = null } = {}) => {
  const { sequelize } = models();
  const data = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`);
  const meta = data.metadata || {};
  if (data.status !== 'success') return { status: data.status || 'failed' };
  if (meta.kind !== 'subscription') return { status: 'ignored' };
  const companyId = Number(meta.company_id);
  if (expectCompanyId !== null && companyId !== Number(expectCompanyId)) {
    throw Object.assign(new Error('That payment belongs to a different company.'), { status: 403 });
  }
  const plan = await billing.planByCode(sequelize, meta.plan_code);
  const expected = plan ? Math.round(priceFor(plan, meta.interval) * 100) : null;
  if (!plan || Number(data.amount) < expected) {
    console.error(`[billing] reference ${reference}: amount ${data.amount} does not cover ${meta.plan_code}/${meta.interval}`);
    return { status: 'amount_mismatch' };
  }
  const auth = data.authorization || {};
  const result = await activatePeriod({
    companyId, planCode: plan.code, interval: meta.interval, amount: Number(data.amount) / 100, reference,
    provider: 'paystack', authorizationCode: auth.reusable ? auth.authorization_code : null, email: data.customer?.email || null,
  });
  return { status: 'success', duplicate: Boolean(result.duplicate), released: result.released || [] };
};

/** Paystack's webhook signature: HMAC-SHA512 of the raw body with the secret key. */
const validWebhookSignature = (rawBody, signature) => {
  const key = paystackKey();
  if (!key || !rawBody || !signature) return false;
  const expected = crypto.createHmac('sha512', key).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const chargeRenewal = async (sub) => {
  const { sequelize, SubscriptionPayment } = models();
  const plan = await billing.planByCode(sequelize, sub.plan_code);
  if (!plan || !sub.paystack_authorization_code || !sub.paystack_email) return { status: 'skipped' };
  const interval = sub.billing_interval || 'monthly';
  const reference = newReference(sub.company_id);
  try {
    const data = await paystack('/transaction/charge_authorization', {
      method: 'POST',
      body: {
        authorization_code: sub.paystack_authorization_code,
        email: sub.paystack_email,
        amount: Math.round(priceFor(plan, interval) * 100),
        reference,
        metadata: { kind: 'subscription', company_id: sub.company_id, plan_code: plan.code, interval, renewal: true },
      },
    });
    if (data.status === 'success') return confirmReference(reference);
    return { status: data.status || 'pending' };
  } catch (error) {
    await SubscriptionPayment.create({
      company_id: sub.company_id, plan_code: plan.code, billing_interval: interval, amount: priceFor(plan, interval),
      currency: plan.currency, reference, provider: 'paystack', status: 'failed', note: String(error.message).slice(0, 250),
    }).catch(() => {});
    return { status: 'failed', message: error.message };
  }
};

/* ── The daily sweep ───────────────────────────────────────────────────── */

const notifyAdmins = async (companyId, { title, body, type }) => {
  const { User, sequelize } = models();
  const admins = await User.findAll({
    where: { company_id: companyId, type: { [Op.in]: ADMIN_TYPES }, is_active: true, deleted_at: null },
    attributes: ['id'],
  });
  const { notifyUser } = createNotifier(sequelize);
  await Promise.all(admins.map((a) => notifyUser({
    userId: a.id, companyId, type, title, body,
    actionLabel: frontend() ? 'Open Billing & plan' : null,
    actionUrl: frontend() ? `${frontend()}/billing` : null,
    channel: 'in_app,email,push',
  }).catch(() => {})));
};

const dayKey = (date) => new Date(date).toISOString().slice(0, 10);

/**
 * Reminders before a trial or period ends (3 days, 1 day, on the day), the
 * automatic renewal of a saved card, and one notice each for grace and lapse.
 * Each notice is recorded in last_reminder, so a re-run sends nothing twice.
 */
const runBillingSweep = async (now = new Date()) => {
  if (!billing.isBillingEnabled()) return { skipped: true };
  const { CompanySubscription } = models();
  const subs = await CompanySubscription.findAll();
  const summary = { reminded: 0, renewed: 0, failed: 0 };
  for (const sub of subs) {
    const state = billing.effectiveState(sub, now);
    let key = null;
    let notice = null;
    if (state.status === 'trialing' || state.status === 'active') {
      const daysLeft = Math.ceil((new Date(state.endsAt) - now) / billing.DAY_MS);
      if (state.status === 'active' && sub.auto_renew && sub.paystack_authorization_code && daysLeft <= 1) {
        const renewKey = `renew:${dayKey(now)}`;
        if (sub.last_reminder !== renewKey) {
          // eslint-disable-next-line no-await-in-loop
          await sub.update({ last_reminder: renewKey });
          // eslint-disable-next-line no-await-in-loop
          const outcome = await chargeRenewal(sub);
          if (outcome.status === 'success') summary.renewed += 1;
          else {
            summary.failed += 1;
            // eslint-disable-next-line no-await-in-loop
            await notifyAdmins(sub.company_id, {
              type: 'billing_renewal_failed',
              title: 'We could not renew your subscription',
              body: 'The automatic payment did not go through. Please pay under Billing & plan to keep full access.',
            });
          }
        }
        continue;
      }
      if ([3, 1, 0].includes(daysLeft)) {
        const what = state.status === 'trialing' ? 'trial' : 'period';
        key = `${what}:${daysLeft}:${dayKey(state.endsAt)}`;
        const when = daysLeft === 0 ? 'today' : `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
        notice = state.status === 'trialing'
          ? { type: 'billing_trial_ending', title: `Your free trial ends ${when}`, body: 'Choose a plan under Billing & plan to keep using everything without interruption.' }
          : { type: 'billing_period_ending', title: `Your subscription renews ${when}`, body: 'Pay under Billing & plan to keep full access.' };
      }
    } else if (state.status === 'grace' && sub.auto_renew && sub.paystack_authorization_code
      && sub.last_reminder !== `renew:${dayKey(now)}`) {
      // Try the saved card once a day through the grace period.
      // eslint-disable-next-line no-await-in-loop
      await sub.update({ last_reminder: `renew:${dayKey(now)}` });
      // eslint-disable-next-line no-await-in-loop
      const outcome = await chargeRenewal(sub);
      if (outcome.status === 'success') summary.renewed += 1;
      else summary.failed += 1;
      continue;
    } else if (state.status === 'grace') {
      key = `grace:${dayKey(state.endsAt)}`;
      notice = { type: 'billing_grace', title: 'Your subscription has ended', body: `You have until ${dayKey(state.graceEndsAt)} to renew before your company becomes read-only.` };
    } else if (state.status === 'lapsed') {
      key = `lapsed:${dayKey(state.endsAt)}`;
      notice = { type: 'billing_lapsed', title: 'Your company is now read-only', body: 'Renew under Billing & plan to restore full access. New sign-ups are waiting in your queue until then.' };
    }
    if (key && notice && sub.last_reminder !== key) {
      // eslint-disable-next-line no-await-in-loop
      await sub.update({ last_reminder: key });
      // eslint-disable-next-line no-await-in-loop
      await notifyAdmins(sub.company_id, notice);
      summary.reminded += 1;
    }
  }
  return summary;
};

const startBillingSweep = () => {
  if (!billing.isBillingEnabled()) {
    console.info('[billing] sweep not started (BILLING_ENABLED is off)');
    return;
  }
  cron.schedule('0 7 * * *', () => {
    runBillingSweep().then((s) => console.info('[billing] sweep', JSON.stringify(s)))
      .catch((error) => console.error('[billing] sweep failed:', error.message));
  });
  console.info('[billing] sweep scheduled (daily at 07:00)');
};

module.exports = {
  prepareBilling,
  startTrial,
  releaseHeldAccounts,
  activatePeriod,
  changePlan,
  extendTrial,
  startCheckout,
  confirmReference,
  validWebhookSignature,
  runBillingSweep,
  startBillingSweep,
  priceFor,
};

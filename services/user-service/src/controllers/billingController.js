const { Op } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize, Company, User, BillingPlan, CompanySubscription, SubscriptionPayment } = require('../models');
const billing = require('../../../../shared/src/billing');
const { likeOperator } = require('../../../../shared/src/dialect');
const service = require('../services/billingService');

/**
 * Subscription billing's API. Company admins see and pay for their own
 * company's plan; platform administrators manage plans and every company's
 * subscription. With BILLING_ENABLED off, /billing/status says so and the app
 * shows nothing; the rest still answer, so platform admins can prepare plans.
 */

const fail = (res, error, fallback) => res.status(error.status || 500).json({ message: error.status ? error.message : fallback });

const statusFor = async (companyId) => {
  const state = await billing.billingState(sequelize, companyId, { fresh: true });
  if (!state.enabled || companyId === null || companyId === undefined) return state;
  const [used, held] = await Promise.all([billing.countMembers(sequelize, companyId), billing.countHeld(sequelize, companyId)]);
  return { ...state, users: { used, limit: state.userLimit, held } };
};

/** GET /billing/status — the caller's company. */
const status = asyncHandler(async (req, res) => {
  res.json({ data: await statusFor(req.user?.company_id ?? null) });
});

/** POST /billing/checkout { plan_code, interval } — Paystack's payment page. */
const checkout = asyncHandler(async (req, res) => {
  const companyId = req.user?.company_id;
  if (!companyId) return res.status(400).json({ message: 'Only a company can subscribe.' });
  const me = await User.findByPk(req.user.id, { attributes: ['email'] });
  const back = `${String(process.env.FRONTEND_URL || '').replace(/\/+$/, '')}/billing`;
  try {
    const data = await service.startCheckout({
      companyId, planCode: req.body?.plan_code, interval: req.body?.interval, email: me?.email, callbackUrl: back,
    });
    return res.json({ data });
  } catch (error) {
    return fail(res, error, 'Could not start the payment.');
  }
});

/** GET /billing/confirm/:reference — after Paystack sends the admin back. */
const confirm = asyncHandler(async (req, res) => {
  try {
    const outcome = await service.confirmReference(req.params.reference, { expectCompanyId: req.user?.company_id ?? null });
    return res.json({ data: { ...outcome, billing: await statusFor(req.user?.company_id ?? null) } });
  } catch (error) {
    return fail(res, error, 'Could not confirm the payment.');
  }
});

/** GET /billing/payments — the company's subscription payments. */
const payments = asyncHandler(async (req, res) => {
  const rows = await SubscriptionPayment.findAll({ where: { company_id: req.user?.company_id ?? -1 }, order: [['id', 'DESC']], limit: 100 });
  res.json({ data: rows });
});

/** GET /billing/held — sign-ups waiting in the company's queue. Visible, not approvable: renewal releases them. */
const held = asyncHandler(async (req, res) => {
  const rows = await User.findAll({
    where: { company_id: req.user?.company_id ?? -1, billing_hold: true, deleted_at: null },
    attributes: ['id', 'name', 'email', 'phone', 'type', 'created_at'],
    order: [['id', 'ASC']],
  });
  res.json({ data: rows });
});

/* ── Platform administrators ───────────────────────────────────────────── */

const listPlans = asyncHandler(async (req, res) => {
  res.json({ data: await billing.listPlans(sequelize, { includeInactive: true }) });
});

const updatePlan = asyncHandler(async (req, res) => {
  const plan = await BillingPlan.findByPk(req.params.code);
  if (!plan) return res.status(404).json({ message: 'Plan not found.' });
  const patch = {};
  const num = (v) => (v === '' || v === null ? null : Number(v));
  if (req.body.name !== undefined) patch.name = String(req.body.name).trim().slice(0, 80);
  if (req.body.description !== undefined) patch.description = String(req.body.description).trim().slice(0, 255);
  for (const key of ['monthly_price', 'annual_price']) {
    if (req.body[key] !== undefined) {
      const value = num(req.body[key]);
      if (!(value >= 0)) return res.status(422).json({ message: `${key.replace('_', ' ')} must be a number.` });
      patch[key] = value;
    }
  }
  if (req.body.user_limit !== undefined) {
    const value = num(req.body.user_limit);
    if (value !== null && !(Number.isInteger(value) && value > 0)) return res.status(422).json({ message: 'User limit must be a whole number, or empty for unlimited.' });
    patch.user_limit = value;
  }
  if (req.body.active !== undefined) patch.active = Boolean(req.body.active);
  await plan.update(patch);
  res.json({ data: plan });
});

/** GET /billing/admin/subscriptions?status=&search= — every company, with its derived state. */
const listSubscriptions = asyncHandler(async (req, res) => {
  const search = String(req.query.search || '').trim();
  const where = search ? { name: { [likeOperator(sequelize)]: `%${search}%` } } : {};
  const companies = await Company.findAll({ where, attributes: ['id', 'name', 'referral_code', 'status'], order: [['name', 'ASC']] });
  const subs = await CompanySubscription.findAll({ where: { company_id: { [Op.in]: companies.map((c) => c.id) } } });
  const byCompany = new Map(subs.map((s) => [Number(s.company_id), s]));
  const plans = new Map((await billing.listPlans(sequelize, { includeInactive: true })).map((p) => [p.code, p]));
  const rows = await Promise.all(companies.map(async (c) => {
    const sub = byCompany.get(Number(c.id)) || null;
    const state = billing.effectiveState(sub);
    return {
      company_id: c.id,
      company_name: c.name,
      company_code: c.referral_code,
      company_status: c.status,
      status: state.status,
      plan_code: sub?.plan_code || null,
      plan_name: sub?.plan_code ? plans.get(sub.plan_code)?.name || sub.plan_code : null,
      interval: sub?.billing_interval || null,
      ends_at: state.endsAt,
      grace_ends_at: state.graceEndsAt,
      has_card: Boolean(sub?.paystack_authorization_code),
      users: await billing.countMembers(sequelize, c.id),
      held: await billing.countHeld(sequelize, c.id),
    };
  }));
  const wanted = String(req.query.status || '');
  res.json({ data: wanted ? rows.filter((r) => r.status === wanted) : rows, enabled: billing.isBillingEnabled() });
});

const companyIdParam = (req) => Number(req.params.companyId);

/** POST /billing/admin/subscriptions/:companyId/mark-paid { plan_code, interval, amount?, reference?, note? } */
const markPaid = asyncHandler(async (req, res) => {
  const companyId = companyIdParam(req);
  const plan = await billing.planByCode(sequelize, req.body?.plan_code);
  if (!plan) return res.status(422).json({ message: 'Choose a plan.' });
  const interval = req.body?.interval === 'annual' ? 'annual' : 'monthly';
  try {
    const result = await service.activatePeriod({
      companyId, planCode: plan.code, interval,
      amount: req.body?.amount !== undefined && req.body.amount !== '' ? Number(req.body.amount) : service.priceFor(plan, interval),
      reference: String(req.body?.reference || `MANUAL-${companyId}-${Date.now()}`).slice(0, 120),
      provider: 'manual', recordedBy: req.user?.id ?? null, note: req.body?.note ? String(req.body.note).slice(0, 255) : null,
    });
    if (result.duplicate) return res.status(409).json({ message: 'A payment with that reference is already recorded.' });
    return res.json({ data: { released: result.released, billing: await statusFor(companyId) } });
  } catch (error) {
    return fail(res, error, 'Could not record the payment.');
  }
});

/** POST /billing/admin/subscriptions/:companyId/extend-trial { days } */
const extendTrial = asyncHandler(async (req, res) => {
  const days = Number(req.body?.days);
  if (!(Number.isInteger(days) && days > 0 && days <= 90)) return res.status(422).json({ message: 'Days must be a whole number from 1 to 90.' });
  const result = await service.extendTrial({ companyId: companyIdParam(req), days });
  res.json({ data: { released: result.released, billing: await statusFor(companyIdParam(req)) } });
});

/** POST /billing/admin/subscriptions/:companyId/change-plan { plan_code, interval, period_end? } */
const changePlan = asyncHandler(async (req, res) => {
  try {
    const result = await service.changePlan({
      companyId: companyIdParam(req), planCode: req.body?.plan_code,
      interval: req.body?.interval === 'annual' ? 'annual' : 'monthly', periodEnd: req.body?.period_end || null,
    });
    return res.json({ data: { released: result.released, billing: await statusFor(companyIdParam(req)) } });
  } catch (error) {
    return fail(res, error, 'Could not change the plan.');
  }
});

/** POST /webhooks/paystack — signature-checked; the charge is re-verified with Paystack before anything changes. */
const paystackWebhook = asyncHandler(async (req, res) => {
  if (!service.validWebhookSignature(req.rawBody, req.headers['x-paystack-signature'])) {
    return res.status(401).json({ message: 'Invalid signature' });
  }
  const event = req.body || {};
  // Answer at once: Paystack retries slow replies. The settling is idempotent.
  res.status(200).json({ received: true });
  if (event.event === 'charge.success' && event.data?.reference && event.data?.metadata?.kind === 'subscription') {
    service.confirmReference(event.data.reference)
      .catch((error) => console.error('[billing] webhook settle failed:', error.message));
  }
  return undefined;
});

/** GET /public/plans is served by property-service; this is the same list for the app. */
const plansForApp = asyncHandler(async (req, res) => {
  res.json({ data: await billing.listPlans(sequelize), trial_days: billing.TRIAL_DAYS, enabled: billing.isBillingEnabled() });
});

module.exports = {
  status, checkout, confirm, payments, held, plansForApp,
  listPlans, updatePlan, listSubscriptions, markPaid, extendTrial, changePlan,
  paystackWebhook,
};

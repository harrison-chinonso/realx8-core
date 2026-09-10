const asyncHandler = require('../utils/asyncHandler');
const { buildCrudController, buildCompanyScope, withCompanyAudit } = require('../utils/crudFactory');
const { InvestmentPlan, InvestmentCategory, InvestmentPeriod, Investment, InvestmentTransaction, InvestmentPayout , sequelize } = require('../models');
const { createDispatcher } = require('../../../../shared/src/notificationDispatcher');
const { appUrl } = require('../../../../shared/src/appOrigin');
// Recipients come from configuration, not from these call sites.
const notify = createDispatcher(sequelize);

/**
 * Announces something that happened to one investment.
 *
 * The investor is the subject; the wider group is whoever holds the
 * investments permission the event is configured against. None of these
 * events existed before — an investor could have a cash-out approved or a
 * payout recorded with no notification at all.
 */
const announceInvestment = (investment, req, { eventKey, title, subjectLine, othersLine }) => notify.dispatch({
  eventKey,
  subjectUserId: investment.user_id ?? investment.client_id ?? null,
  companyId: investment.company_id ?? null,
  context: { investment },
  title: () => title,
  body: (role, ctx) => (role === 'subject'
    ? subjectLine(investment)
    : othersLine(investment, ctx.subject?.name || 'An investor')),
  data: { investment_id: investment.id },
  actionLabel: 'View investment',
  actionUrl: appUrl(`investments/${investment.id}`, req),
}).catch(() => {});

const companyScope = (req) => buildCompanyScope(req);

/**
 * Investments a caller may see.
 *
 * `investments.view` is full visibility. Holders of only `investments.own.view`
 * (realtors, clients) are narrowed to their own rows — the company scope alone
 * would expose every client's investment to them.
 *
 * A plain user_id key, deliberately: crudFactory spreads the search filter over
 * this object and that filter uses Op.or, so an Op-keyed clause here would be
 * silently overwritten the moment someone typed in the search box.
 */
const investmentScope = (req) => {
  const scope = companyScope(req);
  const permissions = req.user?.permissions || [];
  const seesAll = req.user?.isSuperiorAdmin === true
    || permissions.includes('*')
    || permissions.includes('investments.view');
  if (seesAll) return scope;
  // -1 rather than undefined: an unknown caller must match nothing, not everything.
  return { ...scope, user_id: req.user?.id ?? -1 };
};

const planCrud = buildCrudController(InvestmentPlan, {
  include: ['category', 'period'], searchFields: ['name', 'status'],
  defaultWhere: companyScope, scopeWhere: companyScope,
  beforeCreate: (req) => withCompanyAudit(req),
});
const categoryCrud = buildCrudController(InvestmentCategory, {
  searchFields: ['name'],
  defaultWhere: companyScope, scopeWhere: companyScope,
  beforeCreate: (req) => withCompanyAudit(req),
});
const periodCrud = buildCrudController(InvestmentPeriod, {
  searchFields: ['name'],
  defaultWhere: companyScope, scopeWhere: companyScope,
  beforeCreate: (req) => withCompanyAudit(req),
});
const investmentCrud = buildCrudController(Investment, {
  include: ['plan', 'transactions', 'payouts'], searchFields: ['status'],
  defaultWhere: investmentScope, scopeWhere: investmentScope,
  beforeCreate: (req) => withCompanyAudit(req),
});

const getTransactions = asyncHandler(async (req, res) => {
  const investment = await Investment.findOne({ where: { id: req.params.id, ...investmentScope(req) } });
  if (!investment) return res.status(404).json({ message: 'Investment not found' });
  const rows = await InvestmentTransaction.findAll({ where: { investment_id: req.params.id, ...companyScope(req) }, order: [['id', 'DESC']] });
  res.json({ data: rows });
});

const getPayouts = asyncHandler(async (req, res) => {
  const investment = await Investment.findOne({ where: { id: req.params.id, ...investmentScope(req) } });
  if (!investment) return res.status(404).json({ message: 'Investment not found' });
  const rows = await InvestmentPayout.findAll({ where: { investment_id: req.params.id, ...companyScope(req) }, order: [['id', 'DESC']] });
  res.json({ data: rows });
});


// ── Client-facing subscription ────────────────────────────────────────────────

/** Plans a client may subscribe to: active plans in their company. */
const listOpenPlans = asyncHandler(async (req, res) => {
  const plans = await InvestmentPlan.findAll({
    where: { ...companyScope(req), status: 'active' },
    include: ['category', 'period'],
    order: [['id', 'DESC']],
  });
  res.json({ data: plans });
});

/**
 * Subscribe the CALLER to a plan.
 *
 * Separate from the admin create endpoint on purpose: user_id is taken from the
 * session, never the body, so a client cannot open an investment in someone
 * else's name. Subscriptions start pending and an admin activates them.
 */
const subscribeToPlan = asyncHandler(async (req, res) => {
  // Clients and realtors invest on their own behalf. Staff use the admin create
  // endpoint, which lets them open an investment for someone else.
  const SELF_SUBSCRIBERS = ['client', 'realtor'];
  if (!SELF_SUBSCRIBERS.includes(req.user?.effectiveType || req.user?.type)) {
    return res.status(403).json({ message: 'Only client and realtor accounts can subscribe to an investment plan.' });
  }

  const plan = await InvestmentPlan.findOne({
    where: { id: req.body.plan_id, ...companyScope(req), status: 'active' },
  });
  if (!plan) return res.status(404).json({ message: 'That investment plan is not available.' });

  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ message: 'Enter a valid amount to invest.' });
  }

  const min = Number(plan.min_amount) || 0;
  const max = Number(plan.max_amount) || 0;
  if (min && amount < min) {
    return res.status(400).json({ message: `The minimum for this plan is ${min.toLocaleString()}.` });
  }
  // A max of 0 means "no ceiling".
  if (max && amount > max) {
    return res.status(400).json({ message: `The maximum for this plan is ${max.toLocaleString()}.` });
  }

  const investment = await Investment.create({
    user_id: req.user.id,
    plan_id: plan.id,
    amount,
    status: 'pending',
    cash_out_status: 'not_requested',
    created_by: req.user.id,
    company_id: plan.company_id ?? req.user.company_id ?? null,
  });

  announceInvestment(investment, req, {
    eventKey: 'investment_subscribed',
    title: 'Investment subscribed',
    subjectLine: () => `Your subscription to "${plan.name}" has been recorded and is awaiting activation.`,
    othersLine: (inv, who) => `${who} has subscribed to "${plan.name}".`,
  });

  res.status(201).json({ data: investment });
});

const activateInvestment = asyncHandler(async (req, res) => {
  if (!requireManage(req, res, 'Activating an investment')) return;
  const investment = await Investment.findOne({ where: { id: req.params.id, ...investmentScope(req) }, include: ['plan'] });
  if (!investment) {
    return res.status(404).json({ message: 'Investment not found' });
  }

  const startDate = new Date();
  const period = investment.plan ? await InvestmentPeriod.findOne({ where: { id: investment.plan.period_id, ...companyScope(req) } }) : null;
  const endDate = period ? new Date(startDate.getTime() + period.days * 24 * 60 * 60 * 1000) : null;

  await investment.update({ status: 'active', start_date: startDate, end_date: endDate });
  await InvestmentTransaction.create({
    investment_id: investment.id,
    user_id: investment.user_id,
    amount: investment.amount,
    type: 'deposit',
    status: 'completed',
    description: 'Initial investment activation deposit',
    company_id: investment.company_id,
  });


  announceInvestment(investment, req, {
    eventKey: 'investment_activated',
    title: 'Investment activated',
    subjectLine: () => 'Your investment is now active and has started earning.',
    othersLine: (inv, who) => `${who}'s investment has been activated.`,
  });
  res.json({ data: investment });
});

const createPayout = asyncHandler(async (req, res) => {
  if (!requireManage(req, res, 'Recording a payout')) return;
  const investment = await Investment.findOne({ where: { id: req.params.id, ...investmentScope(req) }, include: ['plan'] });
  if (!investment) {
    return res.status(404).json({ message: 'Investment not found' });
  }

  const amount = Number(req.body.amount || (Number(investment.amount) * Number(investment.plan?.return_rate || 0)) / 100);
  const payout = await InvestmentPayout.create({
    investment_id: investment.id,
    user_id: investment.user_id,
    amount,
    status: req.body.status || 'pending',
    payout_date: req.body.payout_date || new Date(),
    company_id: investment.company_id,
  });

  await InvestmentTransaction.create({
    investment_id: investment.id,
    user_id: investment.user_id,
    amount,
    type: 'payout',
    status: payout.status,
    description: 'Investment payout created',
    company_id: investment.company_id,
  });

  announceInvestment(investment, req, {
    eventKey: 'payout_created',
    title: 'Payout recorded',
    subjectLine: () => `A payout of ${Number(amount).toLocaleString()} has been recorded on your investment.`,
    othersLine: (inv, who) => `A payout of ${Number(amount).toLocaleString()} was recorded for ${who}.`,
  });

  res.status(201).json({ data: payout });
});

const getRetentionAlerts = async (req, res) => {
  try {
    const { Op } = require('sequelize');
    const scope = req.user?.company_id ? { company_id: req.user.company_id } : {};
    const now = new Date();
    const in90 = new Date(now.getTime() + 90 * 86400000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 86400000);

    const expiringInvestments = await Investment.findAll({
      where: {
        ...scope,
        status: 'active',
        end_date: { [Op.between]: [now, in90] },
      },
      include: [{ model: InvestmentPlan, as: 'plan' }],
    });

    const completedInvestments = await Investment.findAll({
      where: {
        ...scope,
        status: 'completed',
        end_date: { [Op.gte]: sixtyDaysAgo },
      },
      include: [{ model: InvestmentPlan, as: 'plan' }],
    });

    const alerts = [];

    for (const inv of expiringInvestments) {
      const daysLeft = Math.ceil((new Date(inv.end_date) - now) / 86400000);
      const urgency = daysLeft <= 30 ? 'high' : daysLeft <= 60 ? 'medium' : 'low';
      const churnRisk = urgency === 'high' ? 85 : urgency === 'medium' ? 60 : 35;

      alerts.push({
        type: 'expiring',
        urgency,
        user_id: inv.user_id,
        investment_id: inv.id,
        plan_name: inv.plan?.name || 'Unknown Plan',
        amount: Number(inv.amount),
        end_date: inv.end_date,
        days_remaining: daysLeft,
        churn_risk_pct: churnRisk,
        action: `Contact client ${daysLeft <= 30 ? 'immediately' : `within ${daysLeft - 30} days`} to discuss renewal`,
        reinvestment_potential: 'high',
      });
    }

    for (const inv of completedInvestments) {
      const daysSinceEnd = Math.ceil((now - new Date(inv.end_date)) / 86400000);
      const reinvestProbability = daysSinceEnd <= 7 ? 80 : daysSinceEnd <= 30 ? 60 : daysSinceEnd <= 60 ? 40 : 20;

      alerts.push({
        type: 'reinvestment_opportunity',
        urgency: reinvestProbability >= 70 ? 'high' : reinvestProbability >= 50 ? 'medium' : 'low',
        user_id: inv.user_id,
        investment_id: inv.id,
        plan_name: inv.plan?.name || 'Unknown Plan',
        amount: Number(inv.amount),
        end_date: inv.end_date,
        days_since_completed: daysSinceEnd,
        reinvestment_probability_pct: reinvestProbability,
        action: 'Present new investment plans aligned with previous investment profile',
        suggested_plan: inv.plan?.name,
      });
    }

    const urgencyOrder = { high: 0, medium: 1, low: 2 };
    alerts.sort((a, b) => (urgencyOrder[a.urgency] ?? 2) - (urgencyOrder[b.urgency] ?? 2));

    res.json({
      data: alerts,
      summary: {
        total_alerts: alerts.length,
        high_urgency: alerts.filter((alert) => alert.urgency === 'high').length,
        expiring_soon: alerts.filter((alert) => alert.type === 'expiring').length,
        reinvestment_opportunities: alerts.filter((alert) => alert.type === 'reinvestment_opportunity').length,
      },
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch retention alerts', error: error.message });
  }
};

/** Full investment management — create, edit, pay out, delete, cash-out. */
const canManageInvestments = (req) => {
  const permissions = req.user?.permissions || [];
  return req.user?.isSuperiorAdmin === true
    || permissions.includes('*')
    || permissions.includes('investments.manage');
};

/**
 * Guard for administrative investment actions. Holders of investments.own.view
 * can SEE their own investment, which without this would let them activate it,
 * pay themselves out, or approve their own cash-out.
 */
const requireManage = (req, res, action = 'This action') => {
  if (canManageInvestments(req)) return true;
  res.status(403).json({ message: `${action} is handled by an administrator.` });
  return false;
};

const requestCashOut = asyncHandler(async (req, res) => {
  // Hiding the menu item is not enforcement — cash-out is an administrative
  // action, not something a realtor or client raises for themselves.
  if (!requireManage(req, res, 'Requesting a cash-out')) return;

  const investment = await Investment.findOne({ where: { id: req.params.id, ...investmentScope(req) } });
  if (!investment) return res.status(404).json({ message: 'Investment not found' });
  if (investment.cash_out_status !== 'not_requested') return res.status(400).json({ message: 'Cash-out already requested' });
  await investment.update({
    cash_out_status: 'requested',
    cash_out_requested_at: new Date(),
    cash_out_notes: req.body.notes || null,
  });

  announceInvestment(investment, req, {
    eventKey: 'cashout_requested',
    title: 'Cash-out requested',
    subjectLine: () => 'A cash-out has been requested on your investment and is awaiting review.',
    othersLine: (inv, who) => `${who} has a cash-out request awaiting review.`,
  });
  res.json({ data: investment });
});

const approveCashOut = asyncHandler(async (req, res) => {
  if (!requireManage(req, res, 'Approving a cash-out')) return;
  const investment = await Investment.findOne({ where: { id: req.params.id, ...investmentScope(req) } });
  if (!investment) return res.status(404).json({ message: 'Investment not found' });
  if (investment.cash_out_status !== 'requested') return res.status(400).json({ message: 'No pending cash-out request' });
  await investment.update({
    cash_out_status: 'paid',
    cash_out_approved_by: req.user?.id,
    status: 'completed',
  });

  announceInvestment(investment, req, {
    eventKey: 'cashout_approved',
    title: 'Cash-out approved',
    subjectLine: () => 'Your cash-out request has been approved.',
    othersLine: (inv, who) => `${who}'s cash-out request was approved.`,
  });
  res.json({ data: investment });
});

const rejectCashOut = asyncHandler(async (req, res) => {
  if (!requireManage(req, res, 'Reviewing a cash-out')) return;
  const investment = await Investment.findOne({ where: { id: req.params.id, ...investmentScope(req) } });
  if (!investment) return res.status(404).json({ message: 'Investment not found' });
  // Mirrors approveCashOut: without this, a settled (or never-requested)
  // cash-out could be flipped to rejected, overwriting a 'paid' record.
  if (investment.cash_out_status !== 'requested') {
    return res.status(400).json({ message: 'No pending cash-out request' });
  }
  await investment.update({
    cash_out_status: 'rejected',
    cash_out_notes: req.body.notes || investment.cash_out_notes,
  });

  announceInvestment(investment, req, {
    eventKey: 'cashout_rejected',
    title: 'Cash-out declined',
    subjectLine: (inv) => 'Your cash-out request was declined.'
      + (inv.cash_out_notes ? ` Reason: ${inv.cash_out_notes}` : ''),
    othersLine: (inv, who) => `${who}'s cash-out request was declined.`,
  });
  res.json({ data: investment });
});

module.exports = {
  planCrud,
  categoryCrud,
  periodCrud,
  investmentCrud,
  getTransactions,
  getPayouts,
  listOpenPlans,
  subscribeToPlan,
  activateInvestment,
  createPayout,
  getRetentionAlerts,
  requestCashOut,
  approveCashOut,
  rejectCashOut,
};

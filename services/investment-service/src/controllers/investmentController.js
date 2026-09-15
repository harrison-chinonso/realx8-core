const asyncHandler = require('../utils/asyncHandler');
const { buildCrudController, buildCompanyScope, withCompanyAudit } = require('../utils/crudFactory');
const { InvestmentPlan, InvestmentCategory, InvestmentPeriod, Investment, InvestmentTransaction, InvestmentPayout , sequelize } = require('../models');
const { createDispatcher } = require('../../../../shared/src/notificationDispatcher');
const { appUrl } = require('../../../../shared/src/appOrigin');
const { QueryTypes } = require('sequelize');
const { toMinor, toMajor, asMinor } = require('../../../../shared/src/money');
const { nextNumber } = require('../../../../shared/src/documentSequence');
const { termsFrom, describeTerms } = require('../../../../shared/src/investments/terms');
const {
  subscriptionWindow, recordFunding, positionOf, exitQuoteFor,
} = require('../services/investmentEngine');
const { runAccrual } = require('../services/accrualRun');
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

  const amountMinor = toMinor(amount);

  /*
   * Open, inside its window, and with headroom under the cap. Three separate
   * questions, each with its own message — "unavailable" would send somebody to
   * support to learn something this screen already knows.
   */
  const window = await subscriptionWindow(sequelize, plan, { amountMinor });
  if (!window.open) {
    return res.status(409).json({ message: window.message, reason: window.reason });
  }

  const companyId = plan.company_id ?? req.user.company_id ?? null;

  /**
   * The subscription and its invoice commit together.
   *
   * A subscription with no invoice is a promise nobody can pay, and an invoice
   * with no subscription is a bill for nothing. Either one alone is worse than
   * the coupling, which is the same reasoning property-service applies to a
   * purchase and its invoice.
   */
  const transaction = await sequelize.transaction();
  let investment;
  try {
    investment = await Investment.create({
      user_id: req.user.id,
      plan_id: plan.id,
      amount,
      principal_minor: amountMinor,
      funded_minor: 0,
      // Terms are COPIED, never referenced: editing the opportunity afterwards
      // must not rewrite what this investor agreed to.
      terms: termsFrom(plan),
      status: 'pending',
      cash_out_status: 'not_requested',
      created_by: req.user.id,
      company_id: companyId,
    }, { transaction });

    const invoiceRef = await nextNumber(sequelize, {
      docType: 'invoice', table: 'invoices', field: 'invoice_id', prefix: 'INV-',
      companyId, transaction,
    });

    /*
     * Billed through finance, like every other thing a client pays for — so the
     * investor uploads proof, an administrator approves it, and a receipt is
     * issued, all through machinery that already exists and is already
     * reconciled. A second payment rail inside this service would be a second
     * ledger to disagree with the first.
     */
    await sequelize.query(
      `INSERT INTO invoices (invoice_id, client_id, property_id, amount, due_date, status, discount, created_by, company_id, created_at)
       VALUES (:invoiceRef, :clientId, :propertyId, :amount, :dueDate, 'sent', 0, :createdBy, :companyId, NOW())`,
      {
        replacements: {
          invoiceRef,
          clientId: req.user.id,
          // The property being funded, when the opportunity names one — so the
          // invoice reads as what it is rather than as an unexplained charge.
          propertyId: plan.property_id ?? null,
          amount,
          dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
          createdBy: req.user.id,
          companyId,
        },
        type: QueryTypes.INSERT,
        transaction,
      },
    );

    const [invoice] = await sequelize.query(
      `SELECT id FROM invoices WHERE invoice_id = :invoiceRef
         AND company_id ${companyId == null ? 'IS NULL' : '= :companyId'} LIMIT 1`,
      { replacements: { invoiceRef, companyId }, type: QueryTypes.SELECT, transaction },
    );

    await investment.update({ invoice_id: invoice?.id ?? null }, { transaction });
    await transaction.commit();
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }

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

/**
 * One investor's position: what they put in, what it has earned, what is still
 * owed, and when the next release falls.
 *
 * Computed from the terms stored on the subscription rather than from the
 * opportunity, so the figure here is the figure the payout will use. A
 * statement that quotes a different number from the payment is how disputes
 * start.
 */
const myPositions = asyncHandler(async (req, res) => {
  const rows = await Investment.findAll({
    where: { user_id: req.user.id },
    include: ['plan'],
    order: [['id', 'DESC']],
  });

  const data = rows.map((investment) => {
    const position = positionOf(investment);
    return {
      id: investment.id,
      plan: investment.plan?.name ?? null,
      status: investment.status,
      invoice_id: investment.invoice_id,
      committed: toMajor(asMinor(investment.principal_minor)),
      funded: toMajor(position.principal_minor),
      earned: toMajor(position.earned_minor),
      paid: toMajor(position.paid_minor),
      due: toMajor(position.due_minor),
      capital_outstanding: toMajor(position.capital_outstanding_minor),
      matured: position.matured,
      maturity_date: position.maturity_date,
      next_payout_date: position.next_payout_date,
      // The same sentences shown before they committed, so the agreement can be
      // read back at any time rather than remembered.
      terms: describeTerms(position.terms),
    };
  });

  res.json({ data });
});

/**
 * Catch one subscription up with the money that has arrived.
 *
 * Finance approves a payment and knows nothing about investments, so somebody
 * has to read the invoice. The accrual run does this for everything nightly;
 * this endpoint exists so an administrator watching a payment land does not
 * have to wait for it.
 */
const syncFunding = asyncHandler(async (req, res) => {
  const investment = await Investment.findOne({
    where: { id: req.params.id, ...investmentScope(req) },
  });
  if (!investment) return res.status(404).json({ message: 'Investment not found' });

  const result = await recordFunding(sequelize, investment);
  await investment.reload();

  res.json({
    data: {
      funded: toMajor(asMinor(investment.funded_minor)),
      funded_at: investment.funded_at,
      status: investment.status,
      changed: result.changed,
    },
    message: result.changed
      ? 'Funding recorded. The tenor runs from the date the first payment landed.'
      : 'No new payment has been approved against this investment yet.',
  });
});

/**
 * What leaving early would cost — quoted, not committed.
 *
 * An early exit is the one moment an investor loses money they can see on their
 * own screen. They are entitled to the arithmetic before they agree to it,
 * rather than after, when the only remedy is a reversal.
 */
const exitQuote = asyncHandler(async (req, res) => {
  const investment = await Investment.findOne({
    where: { id: req.params.id, ...investmentScope(req) },
  });
  if (!investment) return res.status(404).json({ message: 'Investment not found' });

  const quote = exitQuoteFor(investment);
  res.json({
    data: {
      ...quote,
      capital: toMajor(quote.capital_minor),
      earned: toMajor(quote.earned_minor),
      penalty: toMajor(quote.penalty_minor),
      net: toMajor(quote.net_minor),
      lines: (quote.lines || []).map((line) => ({ ...line, amount: toMajor(line.amount_minor) })),
    },
  });
});

/**
 * Run the accrual sweep by hand.
 *
 * The scheduler does this nightly. Exposed because the first question after an
 * outage is "did tonight's run happen", and the honest way to answer it is to
 * run it again — which is safe precisely because the engine answers cumulative
 * earnings and this pays the difference.
 */
const runAccrualNow = asyncHandler(async (req, res) => {
  if (!canManageInvestments(req)) {
    return res.status(403).json({ message: 'Only an administrator can run the accrual.' });
  }
  const summary = await runAccrual(require('../models'));
  res.json({
    data: summary,
    message: summary.created || summary.capital
      ? `Raised ${summary.created} return payout(s) and ${summary.capital} capital return(s).`
      : 'Nothing was due. Everything is already up to date.',
  });
});

module.exports = {
  myPositions,
  syncFunding,
  exitQuote,
  runAccrualNow,
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

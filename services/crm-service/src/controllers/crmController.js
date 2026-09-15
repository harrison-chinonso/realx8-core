const asyncHandler = require('../utils/asyncHandler');
const { buildCrudController, buildCompanyScope, withCompanyAudit } = require('../utils/crudFactory');
const { Op, QueryTypes } = require('sequelize');
const { Pipeline, Stage, Source, Label, LeadStage, Lead, Deal, Task, TaskStage, Objection, Activity, sequelize } = require('../models');
const { createDispatcher } = require('../../../../shared/src/notificationDispatcher');
const { appUrl } = require('../../../../shared/src/appOrigin');
// Recipients come from configuration, not from these call sites.
const notify = createDispatcher(sequelize);

const normalize = (value) => String(value || '').trim().toLowerCase();
const CLOSED_WON_VALUES = ['closed won', 'closed_won', 'won', 'closed-won'];
const PIPELINE_STAGES = ['New Lead', 'Contacted', 'Follow-Up', 'Inspection', 'Negotiation', 'Closed Won'];
const STATUS_STAGE_MAP = {
  new: 'New Lead',
  contacted: 'Contacted',
  follow_up: 'Follow-Up',
  inspection_scheduled: 'Inspection',
  negotiation: 'Negotiation',
  closed_won: 'Closed Won',
  closed_lost: 'Closed Lost',
  qualified: 'Follow-Up',
};
const FOLLOW_UP_SCRIPTS = {
  new: (lead) => `Hi ${lead.name}, I saw you expressed interest in ${lead.property_profile || 'our properties'}. I'd love to schedule a quick call to understand your requirements better. When would be a good time?`,
  contacted: (lead) => `Hi ${lead.name}, following up on our last conversation. Have you had a chance to review the options I shared? I have some new listings that might be perfect for your ${lead.budget_category || 'budget'}.`,
  follow_up: (lead) => `Hi ${lead.name}, I wanted to check in and see if you're still looking. I've identified ${lead.property_profile || 'properties'} that match your profile exactly — would you be available for a viewing this week?`,
  inspection_scheduled: (lead) => `Hi ${lead.name}, looking forward to our inspection! If you have any specific requirements or questions before we meet, please don't hesitate to reach out.`,
  negotiation: (lead) => `Hi ${lead.name}, I'm working hard to get you the best deal. I'll have the updated terms ready by tomorrow. What's your final position on the price?`,
  closed_lost: (lead) => `Hi ${lead.name}, I understand this wasn't the right time. I'd love to stay in touch — we have new properties coming in regularly that might be perfect when you're ready.`,
};
const OPTIMAL_CONTACT_HOURS = {
  call: { weekday: '10:00-11:00 AM or 3:00-4:00 PM', weekend: '11:00 AM-1:00 PM' },
  email: { weekday: '8:00-9:00 AM or 1:00-2:00 PM', weekend: '10:00 AM' },
  meeting: { weekday: '10:00 AM-12:00 PM or 2:00-4:00 PM', weekend: '11:00 AM-1:00 PM' },
};

const companyScope = (req) => buildCompanyScope(req);

/**
 * Work assigned to someone must carry that person's company.
 *
 * withCompanyAudit can only derive a company from the *requester*, so anything
 * created by a platform admin — who has no company of their own — was stored
 * with company_id NULL. Every company-scoped read then skips the row: it stays
 * visible in the platform view while the company's own admin sees an empty
 * Agent Performance leaderboard.
 *
 * Falling back to the assignee's company files the row under exactly one
 * tenant. Widening the reads to also match NULL would have fixed the symptom,
 * but it would show every company the same orphaned rows.
 *
 * users belongs to user-service, so this reads it directly rather than
 * declaring a model for a table this service must never reshape.
 */
const companyOfUser = async (userId) => {
  if (!userId) return null;
  const [row] = await sequelize.query(
    'SELECT company_id FROM users WHERE id = :id AND deleted_at IS NULL LIMIT 1',
    { replacements: { id: userId }, type: QueryTypes.SELECT },
  );
  return row?.company_id ?? null;
};

/** withCompanyAudit, with the assignee as a fallback source of company. */
const withAssigneeCompany = async (req, payload) => {
  const base = withCompanyAudit(req, payload);
  if (base.company_id == null) {
    const inherited = await companyOfUser(base.assigned_to);
    if (inherited != null) base.company_id = Number(inherited);
  }
  return base;
};
const isClosedWonLead = (lead) => CLOSED_WON_VALUES.includes(normalize(lead?.stage?.name || lead?.status));

function getScoreBreakdown(data, activityContext = {}) {
  const breakdown = {
    thermal: 0,
    budget: 0,
    purchase_window: 0,
    intent_driver: 0,
    property_profile: 0,
    email: 0,
    activity_engagement: 0,
    recency: 0,
    stage_velocity: 0,
  };

  const thermal = normalize(data.lead_thermal);
  if (thermal === 'hot') breakdown.thermal = 35;
  else if (thermal === 'warm') breakdown.thermal = 20;
  else breakdown.thermal = 5;

  const budget = normalize(data.budget_category || '');
  if (budget.includes('50m+') || budget.includes('50m ')) breakdown.budget = 20;
  else if (budget.includes('20m') || budget.includes('20–50')) breakdown.budget = 15;
  else if (budget.includes('10m')) breakdown.budget = 12;
  else if (budget.includes('5m')) breakdown.budget = 8;
  else if (budget) breakdown.budget = 4;

  const window = normalize(data.purchase_window || '');
  if (window.includes('immediate')) breakdown.purchase_window = 20;
  else if (window.includes('1') || window.includes('1–3')) breakdown.purchase_window = 15;
  else if (window.includes('3') || window.includes('3–6')) breakdown.purchase_window = 10;
  else if (window) breakdown.purchase_window = 5;

  if (data.intent_driver) breakdown.intent_driver = 10;
  if (data.property_profile) breakdown.property_profile = 10;
  if (data.email) breakdown.email = 5;

  const { activityCount = 0, daysSinceContact = null, stageVelocity = null } = activityContext;

  if (activityCount >= 5) breakdown.activity_engagement = 8;
  else if (activityCount >= 3) breakdown.activity_engagement = 5;
  else if (activityCount >= 1) breakdown.activity_engagement = 2;

  if (daysSinceContact !== null) {
    if (daysSinceContact <= 1) breakdown.recency = 7;
    else if (daysSinceContact <= 3) breakdown.recency = 5;
    else if (daysSinceContact <= 7) breakdown.recency = 3;
    else if (daysSinceContact > 30) breakdown.recency = -5;
  }

  if (stageVelocity !== null) {
    if (stageVelocity <= 3) breakdown.stage_velocity = 5;
    else if (stageVelocity <= 7) breakdown.stage_velocity = 3;
    else if (stageVelocity > 21) breakdown.stage_velocity = -3;
  }

  const total = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  return { breakdown, total: Math.max(0, Math.min(100, total)) };
}

function computeLeadScore(data, activityContext = {}) {
  return getScoreBreakdown(data, activityContext).total;
}

const getDateValue = (activity) => {
  const value = activity?.activity_date || activity?.createdAt;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const getLeadActivityContext = async (leadId, lead = null) => {
  if (!leadId) return { activityCount: 0, daysSinceContact: null, stageVelocity: null, responseRate: 0 };

  const activities = await Activity.findAll({
    where: { lead_id: leadId },
    order: [['activity_date', 'DESC'], ['id', 'DESC']],
  });

  const lastActivity = activities[0] || null;
  const lastActivityDate = getDateValue(lastActivity);
  const activityCount = activities.length;
  const daysSinceContact = lastActivityDate
    ? Math.floor((Date.now() - lastActivityDate.getTime()) / 86400000)
    : null;

  const leadRecord = lead || await Lead.findByPk(leadId);
  const leadCreatedAt = leadRecord?.createdAt ? new Date(leadRecord.createdAt) : null;
  const stageVelocity = leadCreatedAt && lastActivityDate
    ? Math.floor((lastActivityDate.getTime() - leadCreatedAt.getTime()) / 86400000)
    : null;

  return { activityCount, daysSinceContact, stageVelocity, responseRate: 0 };
};

const getPipelineStageName = (lead) => {
  const stageName = String(lead?.stage?.name || '').trim();
  if (PIPELINE_STAGES.some((item) => normalize(item) === normalize(stageName))) return stageName;
  if (isClosedWonLead(lead)) return 'Closed Won';
  return STATUS_STAGE_MAP[normalize(lead?.status)] || 'New Lead';
};

/**
 * Reference data a company shares with the platform.
 *
 * ── Why this is a DIFFERENT scope from everything else here ────────────────
 *
 * Pipelines, stages, sources and labels are seeded once with company_id NULL —
 * they are the platform's defaults, meant for every tenant. The ordinary
 * company scope matches `company_id = 7` and a NULL is not 7, so a company
 * admin saw an empty Pipelines screen, an empty Sources list and no labels,
 * while the rows sat in the database the whole time.
 *
 * ── Why not simply give every company its own copy ─────────────────────────
 *
 * Considered, and rejected. Copying five pipelines and forty-three stages per
 * company means the platform can never improve a default — a fixed typo or a
 * new stage would reach only companies created afterwards, and the rest would
 * be frozen on whatever was current the day they signed up. Sharing the
 * defaults and letting a company add its own keeps both possible.
 *
 * ── Why the same reasoning does NOT apply to leads and deals ───────────────
 *
 * It is the opposite case, and the comment on withAssigneeCompany says so: a
 * lead with a NULL company is an ORPHAN, and widening the read would show every
 * company the same stray records. Reference data is shared on purpose;
 * transactional data with no owner is a bug. The two must not use one scope.
 */
const sharedReferenceScope = (req) => {
  const base = companyScope(req);
  // A platform admin already sees everything; leave their query alone.
  if (base.company_id === undefined) return base;

  const { company_id: companyId, ...rest } = base;
  return {
    ...rest,
    [Op.or]: [
      { company_id: companyId },
      // The platform's own defaults, which belong to everybody.
      { company_id: null },
    ],
  };
};

const pipelineCrud = buildCrudController(Pipeline, {
  include: ['stages'], searchFields: ['name'],
  defaultWhere: sharedReferenceScope, scopeWhere: sharedReferenceScope,
  beforeCreate: (req) => withCompanyAudit(req),
});
const stageCrud = buildCrudController(Stage, {
  include: ['pipeline'], searchFields: ['name'],
  defaultWhere: sharedReferenceScope, scopeWhere: sharedReferenceScope,
  beforeCreate: (req) => withCompanyAudit(req),
});
const sourceCrud = buildCrudController(Source, {
  searchFields: ['name'],
  defaultWhere: sharedReferenceScope, scopeWhere: sharedReferenceScope,
  beforeCreate: (req) => withCompanyAudit(req),
});
const labelCrud = buildCrudController(Label, {
  searchFields: ['name'],
  defaultWhere: sharedReferenceScope, scopeWhere: sharedReferenceScope,
  beforeCreate: (req) => withCompanyAudit(req),
});
const leadStageCrud = buildCrudController(LeadStage, {
  searchFields: ['name'],
  defaultWhere: sharedReferenceScope, scopeWhere: sharedReferenceScope,
  beforeCreate: (req) => withCompanyAudit(req),
});
const leadCrud = buildCrudController(Lead, {
  include: ['source', 'pipeline', 'stage', 'label', 'deals', 'tasks', 'objections'],
  searchFields: ['name', 'email', 'phone', 'status', 'budget_category', 'property_profile', 'intent_driver', 'purchase_window', 'lead_thermal'],
  defaultWhere: companyScope,
  scopeWhere: companyScope,
  beforeCreate: async (req) => {
    const base = await withAssigneeCompany(req);
    return { ...base, ai_score: computeLeadScore(base) };
  },
  /**
   * Two events, because they answer different questions. lead_assigned goes to
   * whoever now has to act on it; lead_created goes to whoever watches the
   * pipeline. A lead created already assigned fires both, and the dispatcher
   * deduplicates when they are the same person.
   */
  afterCreate: async (lead, req) => {
    const describe = `${lead.name || 'A lead'}${lead.email ? ` (${lead.email})` : ''}`;
    notify.dispatch({
      eventKey: 'lead_created',
      companyId: lead.company_id ?? null,
      context: { lead },
      title: () => 'New lead',
      body: () => `${describe} has been added to the pipeline.`,
      data: { lead_id: lead.id },
      actionLabel: 'View lead',
      actionUrl: appUrl(`crm/leads/${lead.id}`, req),
    }).catch(() => {});

    if (lead.assigned_to) {
      notify.dispatch({
        eventKey: 'lead_assigned',
        subjectUserId: lead.assigned_to,
        companyId: lead.company_id ?? null,
        context: { lead },
        title: () => 'Lead assigned to you',
        body: (role) => (role === 'subject'
          ? `${describe} has been assigned to you.`
          : `${describe} has been assigned.`),
        data: { lead_id: lead.id },
        actionLabel: 'View lead',
        actionUrl: appUrl(`crm/leads/${lead.id}`, req),
      }).catch(() => {});
    }
    return lead;
  },
  beforeUpdate: async (req, entity) => {
    const payload = { ...req.body };
    const activityContext = await getLeadActivityContext(entity.id, entity);
    payload.ai_score = computeLeadScore({ ...entity.toJSON(), ...payload }, activityContext);
    return payload;
  },
});
const dealCrud = buildCrudController(Deal, {
  include: ['pipeline', 'stage', 'lead', 'tasks'], searchFields: ['name', 'status'],
  defaultWhere: companyScope, scopeWhere: companyScope,
  beforeCreate: (req) => withAssigneeCompany(req),
  afterCreate: async (deal, req) => {
    notify.dispatch({
      eventKey: 'deal_created',
      subjectUserId: deal.assigned_to ?? null,
      companyId: deal.company_id ?? null,
      context: { deal },
      title: () => 'New deal',
      body: (role) => (role === 'subject'
        ? `The deal "${deal.name}" has been assigned to you.`
        : `The deal "${deal.name}" has been created.`),
      data: { deal_id: deal.id },
      actionLabel: 'View deal',
      actionUrl: appUrl(`crm/deals/${deal.id}`, req),
    }).catch(() => {});
    return deal;
  },
  /**
   * Only when the STAGE actually moved. afterUpdate fires on every edit, so
   * without the comparison, renaming a deal would tell everyone it had
   * progressed.
   */
  afterUpdate: async (deal, req) => {
    const previous = deal.previous('stage_id');
    if (previous === undefined || Number(previous) === Number(deal.stage_id)) return deal;
    notify.dispatch({
      eventKey: 'deal_stage_changed',
      subjectUserId: deal.assigned_to ?? null,
      companyId: deal.company_id ?? null,
      context: { deal },
      title: () => `Deal moved — ${deal.name}`,
      body: () => `"${deal.name}" has moved to a new stage.`,
      data: { deal_id: deal.id, stage_id: deal.stage_id },
      actionLabel: 'View deal',
      actionUrl: appUrl(`crm/deals/${deal.id}`, req),
    }).catch(() => {});
    return deal;
  },
});
const taskCrud = buildCrudController(Task, {
  include: ['deal', 'lead'], searchFields: ['title', 'status', 'priority'],
  defaultWhere: companyScope, scopeWhere: companyScope,
  beforeCreate: (req) => withAssigneeCompany(req),
  afterCreate: async (task, req) => {
    if (!task.assigned_to) return task;
    notify.dispatch({
      eventKey: 'task_assigned',
      subjectUserId: task.assigned_to,
      companyId: task.company_id ?? null,
      context: { task },
      title: () => 'Task assigned to you',
      body: (role) => (role === 'subject'
        ? `"${task.title}" has been assigned to you`
          + `${task.due_date ? `, due ${new Date(task.due_date).toDateString()}` : ''}.`
        : `"${task.title}" has been assigned.`),
      data: { task_id: task.id },
      actionLabel: 'View task',
      actionUrl: appUrl('crm/tasks', req),
    }).catch(() => {});
    return task;
  },
  // Only on the transition INTO completed, not on every later edit of an
  // already-completed task.
  afterUpdate: async (task, req) => {
    if (task.status !== 'completed' || task.previous('status') === 'completed') return task;
    notify.dispatch({
      eventKey: 'task_completed',
      subjectUserId: task.assigned_to ?? null,
      companyId: task.company_id ?? null,
      context: { task },
      title: () => 'Task completed',
      body: (role, ctx) => `"${task.title}" was completed`
        + `${ctx.subject?.name ? ` by ${ctx.subject.name}` : ''}.`,
      data: { task_id: task.id },
      actionLabel: 'View task',
      actionUrl: appUrl('crm/tasks', req),
    }).catch(() => {});
    return task;
  },
});
const taskStageCrud = buildCrudController(TaskStage, {
  searchFields: ['name'],
  defaultWhere: companyScope, scopeWhere: companyScope,
  beforeCreate: (req) => withCompanyAudit(req),
});
const activityCrud = buildCrudController(Activity, {
  include: ['lead', 'deal'],
  searchFields: ['type', 'description'],
  defaultWhere: companyScope,
  scopeWhere: companyScope,
  whereBuilder: (req) => ({
    ...(req.query.lead_id ? { lead_id: req.query.lead_id } : {}),
    ...(req.query.deal_id ? { deal_id: req.query.deal_id } : {}),
  }),
  beforeCreate: async (req) => withCompanyAudit(req, {
    ...req.body,
    activity_date: req.body.activity_date || new Date().toISOString().slice(0, 10),
  }),
  afterCreate: async (activity) => {
    if (activity.lead_id) {
      const lead = await Lead.findOne({
        where: {
          id: activity.lead_id,
          ...(activity.company_id ? { company_id: activity.company_id } : {}),
        },
      });
      if (lead) {
        const allActivities = await Activity.findAll({ where: { lead_id: lead.id } });
        const activityContext = { activityCount: allActivities.length, daysSinceContact: 0, stageVelocity: null, responseRate: 0 };
        const newScore = computeLeadScore(lead.toJSON(), activityContext);
        await lead.update({ ai_score: newScore });
      }
    }
    return activity;
  },
});
const objectionCrud = buildCrudController(Objection, {
  include: ['lead'],
  searchFields: ['type', 'description', 'resolution_strategy', 'logged_by_name'],
  order: [['objection_date', 'DESC'], ['id', 'DESC']],
  defaultWhere: companyScope,
  scopeWhere: companyScope,
  whereBuilder: (req) => (req.query.lead_id ? { lead_id: req.query.lead_id } : {}),
  beforeCreate: async (req) => withCompanyAudit(req, {
    ...req.body,
    objection_date: req.body.objection_date || new Date().toISOString().slice(0, 10),
    logged_by: req.user?.id || req.body.logged_by || null,
    logged_by_name: req.user?.name || req.body.logged_by_name || 'System',
  }),
  /**
   * Was silent. An objection is a signal about why deals are stalling, and it
   * was only visible to whoever opened the list — so it reaches whoever holds
   * crm.objections.view by default.
   */
  afterCreate: async (objection, req) => {
    notify.dispatch({
      eventKey: 'objection_raised',
      companyId: objection.company_id ?? null,
      context: { objection },
      title: () => 'Objection logged',
      body: () => `${objection.logged_by_name || 'A realtor'} logged a `
        + `${objection.type || 'new'} objection`
        + `${objection.description ? `: "${String(objection.description).slice(0, 140)}"` : '.'}`,
      data: { objection_id: objection.id, lead_id: objection.lead_id },
      actionLabel: 'View objections',
      actionUrl: appUrl('crm/objections', req),
    }).catch(() => {});
    return objection;
  },
});

const getDealTasks = asyncHandler(async (req, res) => {
  const tasks = await Task.findAll({ where: { deal_id: req.params.id, ...companyScope(req) }, order: [['due_date', 'ASC']] });
  res.json({ data: tasks });
});

const getLeadActivities = asyncHandler(async (req, res) => {
  const lead = await Lead.findOne({
    where: { id: req.params.id, ...companyScope(req) },
    include: ['deals', 'tasks', 'stage', 'source', 'label', 'objections'],
  });
  if (!lead) {
    return res.status(404).json({ message: 'Lead not found' });
  }
  const activities = await Activity.findAll({
    where: { lead_id: req.params.id, ...companyScope(req) },
    include: ['deal'],
    order: [['activity_date', 'DESC'], ['id', 'DESC']],
  });

  res.json({
    data: {
      lead,
      deals: lead.deals,
      tasks: lead.tasks,
      objections: lead.objections,
      activities,
      summary: `Lead ${lead.name} currently in ${lead.stage?.name || 'unassigned'} stage`,
    },
  });
});

const autoAssignLead = asyncHandler(async (req, res) => {
  const { Op, fn, col } = require('sequelize');
  const scope = companyScope(req);
  const lead = await Lead.findOne({ where: { id: req.params.id, ...scope } });
  if (!lead) return res.status(404).json({ message: 'Lead not found' });

  const company_id = scope.company_id;

  const realtorStats = await Lead.findAll({
    where: { ...(company_id ? { company_id } : {}), assigned_to: { [Op.not]: null } },
    attributes: ['assigned_to', [fn('COUNT', col('id')), 'total_leads']],
    group: ['assigned_to'],
    raw: true,
  });

  const openLeadCounts = await Lead.findAll({
    where: {
      ...(company_id ? { company_id } : {}),
      assigned_to: { [Op.not]: null },
      status: { [Op.notIn]: ['closed_won', 'closed_lost'] },
    },
    attributes: ['assigned_to', [fn('COUNT', col('id')), 'open_count']],
    group: ['assigned_to'],
    raw: true,
  });

  const closedWonByRealtor = await Lead.findAll({
    where: {
      ...(company_id ? { company_id } : {}),
      assigned_to: { [Op.not]: null },
      status: 'closed_won',
      ...(lead.property_profile ? { property_profile: lead.property_profile } : {}),
    },
    attributes: ['assigned_to', [fn('COUNT', col('id')), 'domain_wins']],
    group: ['assigned_to'],
    raw: true,
  });

  const openMap = Object.fromEntries(openLeadCounts.map((row) => [row.assigned_to, Number(row.open_count)]));
  const domainMap = Object.fromEntries(closedWonByRealtor.map((row) => [row.assigned_to, Number(row.domain_wins)]));
  const allRealtorIds = [...new Set(realtorStats.map((row) => row.assigned_to).filter(Boolean))];

  if (!allRealtorIds.length) {
    return res.status(422).json({ message: 'No realtors available for auto-assignment. Assign at least one lead manually first.' });
  }

  const maxOpen = Math.max(...allRealtorIds.map((id) => openMap[id] || 0), 1);
  const scored = allRealtorIds.map((realtorId) => {
    const openPenalty = (openMap[realtorId] || 0) / maxOpen;
    const domainBonus = Math.min((domainMap[realtorId] || 0) * 0.2, 1);
    const score = domainBonus - openPenalty * 0.5;
    return { realtorId, score, openLeads: openMap[realtorId] || 0 };
  });

  scored.sort((a, b) => b.score - a.score || a.openLeads - b.openLeads);
  const bestRealtor = scored[0];

  await lead.update({ assigned_to: bestRealtor.realtorId });

  res.json({
    message: 'Lead auto-assigned successfully',
    data: {
      lead_id: lead.id,
      assigned_to: bestRealtor.realtorId,
      open_leads: bestRealtor.openLeads,
      score: bestRealtor.score.toFixed(3),
    },
  });
});

const getLeadScoreDetails = asyncHandler(async (req, res) => {
  const scope = companyScope(req);
  const lead = await Lead.findOne({ where: { id: req.params.id, ...scope } });
  if (!lead) return res.status(404).json({ message: 'Lead not found' });

  const activityContext = await getLeadActivityContext(lead.id, lead);
  const { breakdown, total } = getScoreBreakdown(lead.toJSON(), activityContext);

  if (total !== lead.ai_score) {
    await lead.update({ ai_score: total });
  }

  res.json({
    data: {
      lead_id: lead.id,
      ai_score: total,
      breakdown: {
        thermal: { value: lead.lead_thermal, contribution: breakdown.thermal },
        budget: { value: lead.budget_category, contribution: breakdown.budget },
        purchase_window: { value: lead.purchase_window, contribution: breakdown.purchase_window },
        intent_driver: { value: lead.intent_driver ? 'provided' : 'missing', contribution: breakdown.intent_driver },
        property_profile: { value: lead.property_profile ? 'provided' : 'missing', contribution: breakdown.property_profile },
        email: { value: lead.email ? 'provided' : 'missing', contribution: breakdown.email },
        activity_engagement: {
          count: activityContext.activityCount,
          contribution: breakdown.activity_engagement,
        },
        recency: {
          days_since_contact: activityContext.daysSinceContact,
          contribution: breakdown.recency,
        },
        stage_velocity: {
          days: activityContext.stageVelocity,
          contribution: breakdown.stage_velocity,
        },
      },
    },
  });
});

const getFollowUpSuggestion = asyncHandler(async (req, res) => {
  const scope = companyScope(req);
  const lead = await Lead.findOne({
    where: { id: req.params.id, ...scope },
    include: ['stage'],
  });
  if (!lead) return res.status(404).json({ message: 'Lead not found' });

  const activities = await Activity.findAll({
    where: { lead_id: lead.id, ...scope },
    order: [['activity_date', 'DESC'], ['id', 'DESC']],
  });

  const lastActivity = activities[0];
  const lastActivityDate = getDateValue(lastActivity);
  const daysSinceContact = lastActivityDate
    ? Math.floor((Date.now() - lastActivityDate.getTime()) / 86400000)
    : null;

  const status = lead.status || 'new';
  const thermal = normalize(lead.lead_thermal);

  let urgency = 'normal';
  let followUpIn = '3 days';
  let method = 'call';

  if (thermal === 'hot') {
    urgency = 'high';
    followUpIn = daysSinceContact > 1 ? 'Today' : 'Tomorrow';
    method = 'call';
  } else if (thermal === 'warm') {
    urgency = 'medium';
    followUpIn = daysSinceContact > 3 ? 'Today' : '2 days';
    method = daysSinceContact > 7 ? 'call' : 'email';
  } else {
    urgency = 'low';
    followUpIn = '1 week';
    method = 'email';
  }

  if (status === 'negotiation') { urgency = 'high'; followUpIn = 'Today'; method = 'call'; }
  if (status === 'inspection_scheduled') { urgency = 'high'; followUpIn = '1 day before inspection'; method = 'call'; }
  if (status === 'closed_lost' && daysSinceContact > 30) { urgency = 'low'; followUpIn = '2 weeks'; method = 'email'; }

  const scriptBuilder = FOLLOW_UP_SCRIPTS[status] || FOLLOW_UP_SCRIPTS.new;
  const script = scriptBuilder(lead);
  const contactHours = OPTIMAL_CONTACT_HOURS[method] || OPTIMAL_CONTACT_HOURS.call;
  const today = new Date();
  const isWeekend = today.getDay() === 0 || today.getDay() === 6;

  res.json({
    data: {
      lead_id: lead.id,
      lead_name: lead.name,
      current_status: status,
      thermal: lead.lead_thermal,
      days_since_contact: daysSinceContact,
      suggestion: {
        urgency,
        follow_up_in: followUpIn,
        preferred_method: method,
        optimal_time: isWeekend ? contactHours.weekend : contactHours.weekday,
        script,
        reason: thermal === 'hot'
          ? 'Hot lead — immediate follow-up maximizes conversion probability'
          : thermal === 'warm'
            ? 'Warm lead — consistent nurturing prevents cooling'
            : 'Cold lead — periodic touches maintain brand awareness',
      },
    },
  });
});

/**
 * Agent performance / realtor leaderboard.
 *
 * This used to be built purely from CRM leads, counting a sale only when a lead
 * reached closed_won. Nothing in the purchase or payment flow ever touches a
 * lead, so a realtor could sell a property, be paid in full, and still show
 * zero. It is now driven by money actually received — the same basis the
 * dashboard uses — with the lead and activity signals kept as secondary colour.
 *
 * It is also roster-driven: every realtor in the company is listed, so the page
 * is never blank just because no leads happen to be assigned.
 *
 * invoices / invoice_payments / users belong to other services. They share this
 * database, so they are read with raw SQL rather than by declaring models for
 * tables this service must never reshape.
 *
 * Company scoping deliberately keys off the *client's* company rather than the
 * payment's: some historic payment rows carry a null company_id, and scoping on
 * those would silently drop real revenue.
 */
const getAgentPerformance = asyncHandler(async (req, res) => {
  const { Op } = require('sequelize');
  const scope = companyScope(req);
  const companyId = scope.company_id ?? null;

  const parseDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const from = parseDate(req.query.from || req.query.start_date);
  const to = parseDate(req.query.to || req.query.end_date);

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 86400000);

  const roster = await sequelize.query(
    `SELECT id, name, realtor_code
       FROM users
      WHERE type = 'realtor' AND deleted_at IS NULL
        ${companyId ? 'AND company_id = :companyId' : ''}
      ORDER BY id DESC`,
    { replacements: companyId ? { companyId } : {}, type: QueryTypes.SELECT },
  );

  const salesRows = await sequelize.query(
    `SELECT c.realtor_id                AS realtor_id,
            COUNT(DISTINCT i.id)        AS sold,
            COALESCE(SUM(p.amount), 0)  AS revenue
       FROM invoice_payments p
       JOIN invoices i ON i.id = p.invoice_id
       JOIN users    c ON c.id = i.client_id
      WHERE p.status = 'completed'
        AND c.realtor_id IS NOT NULL
        ${companyId ? 'AND c.company_id = :companyId' : ''}
        ${from ? 'AND p.created_at >= :from' : ''}
        ${to ? 'AND p.created_at <= :to' : ''}
      GROUP BY c.realtor_id`,
    {
      replacements: {
        ...(companyId ? { companyId } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      },
      type: QueryTypes.SELECT,
    },
  );
  const salesByRealtor = salesRows.reduce((acc, row) => {
    acc[row.realtor_id] = { sold: Number(row.sold || 0), revenue: Number(row.revenue || 0) };
    return acc;
  }, {});

  // Windowed like sales: a period view reporting lifetime referrals next to
  // period sales reads as a contradiction ("0 sold, 1 referral").
  const referralRows = await sequelize.query(
    `SELECT realtor_id, COUNT(*) AS referrals
       FROM users
      WHERE realtor_id IS NOT NULL AND deleted_at IS NULL
        ${companyId ? 'AND company_id = :companyId' : ''}
        ${from ? 'AND created_at >= :from' : ''}
        ${to ? 'AND created_at <= :to' : ''}
      GROUP BY realtor_id`,
    {
      replacements: {
        ...(companyId ? { companyId } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      },
      type: QueryTypes.SELECT,
    },
  );
  const referralsByRealtor = referralRows.reduce((acc, row) => {
    acc[row.realtor_id] = Number(row.referrals || 0);
    return acc;
  }, {});

  const leadWindow = {};
  if (from && to) leadWindow.createdAt = { [Op.between]: [from, to] };
  else if (from) leadWindow.createdAt = { [Op.gte]: from };
  else if (to) leadWindow.createdAt = { [Op.lte]: to };

  const allLeads = await Lead.findAll({
    // Windowed with everything else, so Conv % is not period sales over
    // lifetime leads.
    where: { ...scope, ...leadWindow, assigned_to: { [Op.not]: null } },
    attributes: ['assigned_to', 'status', 'ai_score', 'createdAt', 'lead_thermal'],
  });

  const [recentActivities, priorActivities] = await Promise.all([
    Activity.findAll({
      where: { ...scope, created_by: { [Op.not]: null }, createdAt: { [Op.gte]: thirtyDaysAgo } },
      attributes: ['created_by'],
    }),
    Activity.findAll({
      where: { ...scope, created_by: { [Op.not]: null }, createdAt: { [Op.between]: [sixtyDaysAgo, thirtyDaysAgo] } },
      attributes: ['created_by'],
    }),
  ]);

  const countBy = (rows, key) => rows.reduce((acc, row) => {
    acc[row[key]] = (acc[row[key]] || 0) + 1;
    return acc;
  }, {});
  const recentActivityMap = countBy(recentActivities, 'created_by');
  const priorActivityMap = countBy(priorActivities, 'created_by');

  const blank = (id, name) => ({
    realtor_id: id,
    name: name || `Realtor #${id}`,
    total: 0, closed_won: 0, closed_lost: 0, active: 0, hot_leads: 0, avg_score: 0, scores: [],
  });

  const realtorMap = {};
  roster.forEach((r) => { realtorMap[r.id] = blank(r.id, r.name); });

  // A lead can be assigned to staff who are not realtors. They still belong on
  // the board, but under their real name rather than a "Realtor #5" label that
  // misrepresents an admin as a realtor.
  const strayIds = [...new Set(allLeads.map((l) => l.assigned_to))].filter((id) => id && !realtorMap[id]);
  const strayNames = strayIds.length
    ? (await sequelize.query(
        'SELECT id, name FROM users WHERE id IN (:ids) AND deleted_at IS NULL',
        { replacements: { ids: strayIds }, type: QueryTypes.SELECT },
      )).reduce((acc, row) => { acc[row.id] = row.name; return acc; }, {})
    : {};

  for (const lead of allLeads) {
    const rid = lead.assigned_to;
    if (!realtorMap[rid]) realtorMap[rid] = blank(rid, strayNames[rid]);
    const realtor = realtorMap[rid];
    realtor.total += 1;
    if (lead.status === 'closed_won') realtor.closed_won += 1;
    else if (lead.status === 'closed_lost') realtor.closed_lost += 1;
    else realtor.active += 1;
    if (normalize(lead.lead_thermal) === 'hot') realtor.hot_leads += 1;
    realtor.scores.push(Number(lead.ai_score || 0));
  }

  const agents = Object.values(realtorMap).map((realtor) => {
    realtor.avg_score = realtor.scores.length
      ? Math.round(realtor.scores.reduce((sum, value) => sum + value, 0) / realtor.scores.length)
      : 0;
    delete realtor.scores;

    const sales = salesByRealtor[realtor.realtor_id] || { sold: 0, revenue: 0 };
    const referrals = referralsByRealtor[realtor.realtor_id] || 0;

    // Conversion is sales against assigned leads. With no leads there is no
    // ratio to report — a realtor selling to walk-in referrals is not a 0%
    // performer, so it stays null rather than being reported as failure.
    const closeRateValue = realtor.total ? (sales.sold / realtor.total) * 100 : null;

    const recentAct = recentActivityMap[realtor.realtor_id] || 0;
    const priorAct = priorActivityMap[realtor.realtor_id] || 0;
    const activityTrend = priorAct === 0
      ? (recentAct > 0 ? 'improving' : 'inactive')
      : recentAct > priorAct
        ? 'improving'
        : recentAct < priorAct * 0.7
          ? 'declining'
          : 'stable';

    let risk = 'healthy';
    let riskReason = null;
    if (sales.sold > 0 && (closeRateValue === null || closeRateValue >= 30)) {
      risk = 'top_performer';
      riskReason = 'Closing sales and bringing money in';
    } else if (activityTrend === 'declining' && (closeRateValue ?? 0) < 20) {
      risk = 'at_risk'; riskReason = 'Declining activity and low close rate';
    } else if (activityTrend === 'inactive' && realtor.active > 3) {
      risk = 'at_risk'; riskReason = 'No recent activities but has open leads';
    } else if ((closeRateValue ?? 100) < 10 && realtor.total >= 5) {
      risk = 'low_performer'; riskReason = 'Close rate below 10% with 5+ assigned leads';
    }

    return {
      ...realtor,
      sold: sales.sold,
      revenue: sales.revenue,
      referrals,
      close_rate: closeRateValue === null ? null : `${closeRateValue.toFixed(1)}%`,
      recent_activities: recentAct,
      prior_activities: priorAct,
      activity_trend: activityTrend,
      risk,
      risk_reason: riskReason,
    };
  });

  // Money first — this is a sales leaderboard.
  agents.sort((a, b) => b.revenue - a.revenue || b.sold - a.sold || b.total - a.total);

  res.json({
    data: agents,
    summary: {
      total_agents: agents.length,
      top_performers: agents.filter((agent) => agent.risk === 'top_performer').length,
      at_risk: agents.filter((agent) => agent.risk === 'at_risk').length,
      low_performers: agents.filter((agent) => agent.risk === 'low_performer').length,
      total_sold: agents.reduce((sum, agent) => sum + agent.sold, 0),
      total_revenue: agents.reduce((sum, agent) => sum + agent.revenue, 0),
    },
  });
});

const getSalesAnalytics = asyncHandler(async (req, res) => {
  const scope = companyScope(req);
  const [leads, objections, deals] = await Promise.all([
    Lead.findAll({ where: scope, include: ['stage'] }),
    Objection.findAll({ where: scope }),
    Deal.findAll({ where: scope }),
  ]);

  const totalLeads = leads.length;
  const thermalCounts = leads.reduce((acc, lead) => {
    const key = normalize(lead.lead_thermal) || 'cold';
    if (['hot', 'warm', 'cold'].includes(key)) acc[key] += 1;
    return acc;
  }, { hot: 0, warm: 0, cold: 0 });

  const closedWon = leads.filter(isClosedWonLead).length;
  const conversionRate = totalLeads ? `${((closedWon / totalLeads) * 100).toFixed(1)}%` : '0.0%';
  const avgDealValue = deals.length
    ? Number((deals.reduce((sum, deal) => sum + Number(deal.amount || 0), 0) / deals.length).toFixed(2))
    : 0;

  const objectionFrequencyMap = objections.reduce((acc, objection) => {
    const key = objection.type || 'Other';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const pipelineStageMap = PIPELINE_STAGES.reduce((acc, stage) => ({ ...acc, [stage]: 0 }), {});
  leads.forEach((lead) => {
    const stageName = getPipelineStageName(lead);
    pipelineStageMap[stageName] = (pipelineStageMap[stageName] || 0) + 1;
  });

  const budgetDistributionMap = leads.reduce((acc, lead) => {
    const key = lead.budget_category || 'Unspecified';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const realtorMap = leads.reduce((acc, lead) => {
    const key = lead.assigned_to ? `Realtor ${lead.assigned_to}` : 'Unassigned';
    if (!acc[key]) acc[key] = { realtor: key, closed: 0, total: 0 };
    acc[key].total += 1;
    if (isClosedWonLead(lead)) acc[key].closed += 1;
    return acc;
  }, {});

  res.json({
    total_leads: totalLeads,
    hot_leads: thermalCounts.hot,
    warm_leads: thermalCounts.warm,
    cold_leads: thermalCounts.cold,
    closed_won: closedWon,
    conversion_rate: conversionRate,
    avg_deal_value: avgDealValue,
    objection_frequency: Object.entries(objectionFrequencyMap)
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    pipeline_stages: PIPELINE_STAGES.map((stage) => ({ stage, count: pipelineStageMap[stage] || 0 })),
    budget_distribution: Object.entries(budgetDistributionMap)
      .map(([range, count]) => ({ range, count }))
      .sort((a, b) => b.count - a.count),
    realtor_conversion: Object.values(realtorMap)
      .map((item) => ({
        ...item,
        rate: item.total ? `${((item.closed / item.total) * 100).toFixed(1)}%` : '0.0%',
      }))
      .sort((a, b) => b.closed - a.closed || b.total - a.total),
  });
});

// ── Chatbot lead intake ───────────────────────────────────────────────────────
// Called by the frontend ChatbotWidget after collecting name/email/phone.
// Does 4 things automatically:
//   1. Find-or-create the "AI Chatbot" source for this company
//   2. Create the lead with source tag, ai_score, and intent context
//   3. Attempt auto-assignment to the least-loaded realtor
//   4. Announce it as a configured event, so the assigned realtor hears about
//      it and the company can copy whoever else watches the pipeline

const createChatbotLead = asyncHandler(async (req, res) => {
  const { name, email, phone, intent_driver, description } = req.body;
  if (!name) return res.status(400).json({ message: 'name is required' });

  const scope = companyScope(req);

  // 1. Find-or-create the "AI Chatbot" source
  const [source] = await Source.findOrCreate({
    where: { name: 'AI Chatbot', ...scope },
    defaults: { name: 'AI Chatbot', ...scope },
  });

  // 2. Create the lead
  const base = {
    name,
    email: email || null,
    phone: phone || null,
    source_id: source.id,
    status: 'new',
    intent_driver: intent_driver || null,
    description: description || null,
    lead_thermal: 'Warm', // chatbot leads are self-qualified — treat as Warm
    ...scope,
    created_by: req.user?.id || null,
  };

  const lead = await Lead.create({
    ...base,
    ai_score: computeLeadScore(base),
  });

  // 3. Auto-assign: find least-loaded realtor (same logic as autoAssignLead)
  let assignedTo = null;
  try {
    const { Op, fn, col } = require('sequelize');
    const company_id = scope.company_id;

    const openLeadCounts = await Lead.findAll({
      where: {
        ...(company_id ? { company_id } : {}),
        assigned_to: { [Op.not]: null },
        status: { [Op.notIn]: ['closed_won', 'closed_lost'] },
      },
      attributes: ['assigned_to', [fn('COUNT', col('id')), 'open_count']],
      group: ['assigned_to'],
      raw: true,
    });

    const allRealtorIds = [...new Set(openLeadCounts.map((r) => r.assigned_to).filter(Boolean))];
    if (allRealtorIds.length) {
      const openMap = Object.fromEntries(openLeadCounts.map((r) => [r.assigned_to, Number(r.open_count)]));
      const best = allRealtorIds.reduce((a, b) => (openMap[a] || 0) <= (openMap[b] || 0) ? a : b);
      await lead.update({ assigned_to: best });
      assignedTo = best;
    }
  } catch (_) { /* non-fatal — lead still created, just unassigned */ }

  /**
   * 4. Announce it.
   *
   * This used to POST to `/notifications/internal` on notification-service — a
   * route that does not exist and never has. The request was not awaited and
   * the error handler was empty, so every chatbot lead since this was written
   * has notified nobody, silently.
   *
   * It now fires the same two events a lead created through the normal CRUD
   * path does, so a chatbot lead is not a second-class citizen with its own
   * notification rules.
   */
  const describe = `New chatbot lead: ${name}${email ? ` (${email})` : ''}`
    + `${intent_driver ? ` — interested in ${intent_driver}` : ''}`;

  notify.dispatch({
    eventKey: 'lead_created',
    companyId: scope.company_id ?? null,
    context: { lead },
    title: () => 'New chatbot lead',
    body: () => describe,
    data: { lead_id: lead.id, source: 'chatbot' },
    actionLabel: 'View lead',
    actionUrl: appUrl(`crm/leads/${lead.id}`, req),
  }).catch(() => {});

  if (assignedTo) {
    notify.dispatch({
      eventKey: 'lead_assigned',
      subjectUserId: assignedTo,
      companyId: scope.company_id ?? null,
      context: { lead },
      title: () => 'Lead assigned to you',
      body: (role) => (role === 'subject'
        ? `${describe}\n\nIt has been auto-assigned to you.`
        : describe),
      data: { lead_id: lead.id, source: 'chatbot' },
      actionLabel: 'View lead',
      actionUrl: appUrl(`crm/leads/${lead.id}`, req),
    }).catch(() => {});
  }

  res.status(201).json({
    data: lead,
    assigned_to: assignedTo,
    source: source.name,
  });
});

module.exports = {
  pipelineCrud,
  stageCrud,
  sourceCrud,
  labelCrud,
  leadStageCrud,
  leadCrud,
  dealCrud,
  taskCrud,
  taskStageCrud,
  activityCrud,
  objectionCrud,
  getDealTasks,
  getLeadActivities,
  autoAssignLead,
  getLeadScoreDetails,
  getFollowUpSuggestion,
  getAgentPerformance,
  getSalesAnalytics,
  createChatbotLead,
};

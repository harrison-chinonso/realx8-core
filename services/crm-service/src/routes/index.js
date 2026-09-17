const router = require('express').Router();
const { body } = require('express-validator');
const { verifyToken, requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validation');
const c = require('../controllers/crmController');

/**
 * Every CRM route is permission-gated. It is worth saying why that sentence
 * needed writing.
 *
 * ── What was wrong ─────────────────────────────────────────────────────────
 *
 * This file had `verifyToken` and nothing else. Company scoping in the
 * controllers kept one tenant out of another's data, and that was mistaken for
 * authorisation — but scoping answers "whose rows", not "may you". Any account
 * with a valid token could read, create, edit and delete every lead, deal and
 * task in its own company.
 *
 * Measured, not inferred: a CLIENT account holding five permissions — none of
 * them crm.* — called GET /leads and received the company's lead list with
 * names, email addresses and phone numbers. The menu hides CRM from a client
 * completely, which is exactly the trap: the navigation looked like a security
 * boundary and was only ever a convenience.
 *
 * ── The permissions used here are the catalogue's own ──────────────────────
 *
 * Nothing new was invented. permissionCatalog.js already defines crm.leads.*,
 * crm.deals.*, crm.tasks.*, crm.objections.*, crm.pipelines.manage and
 * crm.analytics.view, and already grants them to the roles that should have
 * them. They simply were not being asked for.
 *
 * ── The one judgement call ─────────────────────────────────────────────────
 *
 * Pipelines, stages, sources and labels are configuration, but they are also
 * what the leads board is drawn FROM: without them a realtor who may view
 * leads gets a board with no columns. So reading them takes the permission of
 * the screen that needs them (crm.leads.view / crm.tasks.view) and CHANGING
 * them takes crm.pipelines.manage. Gating the reads on manage would have shut
 * realtors out of a screen they are meant to use.
 *
 * ── What this changes for realtors ─────────────────────────────────────────
 *
 * A realtor holds crm.leads.view and crm.leads.create but NOT crm.leads.manage
 * — deliberate, and now actually enforced. Editing and deleting a lead becomes
 * a 403 for them where it silently worked before. The buttons are hidden to
 * match, because a visible control that always fails is its own bug.
 */

router.use(verifyToken);

// ── Analytics ─────────────────────────────────────────────────────────────
router.get('/crm/analytics', requirePermission('crm.analytics.view'), c.getSalesAnalytics);
router.get('/analytics/agent-performance', requirePermission('crm.analytics.view'), c.getAgentPerformance);

// ── Pipeline configuration ────────────────────────────────────────────────
// Read with the board, change with the configuration permission — see above.
router.get('/pipelines', requirePermission('crm.leads.view'), c.pipelineCrud.list);
router.post('/pipelines', requirePermission('crm.pipelines.manage'), [body('name').notEmpty()], validate, c.pipelineCrud.create);
router.get('/pipelines/:id', requirePermission('crm.leads.view'), c.pipelineCrud.getOne);
router.put('/pipelines/:id', requirePermission('crm.pipelines.manage'), c.pipelineCrud.update);
router.delete('/pipelines/:id', requirePermission('crm.pipelines.manage'), c.pipelineCrud.remove);

router.get('/stages', requirePermission('crm.leads.view'), c.stageCrud.list);
router.post('/stages', requirePermission('crm.pipelines.manage'), [body('name').notEmpty(), body('pipeline_id').isInt()], validate, c.stageCrud.create);
router.get('/stages/:id', requirePermission('crm.leads.view'), c.stageCrud.getOne);
router.put('/stages/:id', requirePermission('crm.pipelines.manage'), c.stageCrud.update);
router.delete('/stages/:id', requirePermission('crm.pipelines.manage'), c.stageCrud.remove);

router.get('/sources', requirePermission('crm.leads.view'), c.sourceCrud.list);
router.post('/sources', requirePermission('crm.pipelines.manage'), [body('name').notEmpty()], validate, c.sourceCrud.create);
router.get('/sources/:id', requirePermission('crm.leads.view'), c.sourceCrud.getOne);
router.put('/sources/:id', requirePermission('crm.pipelines.manage'), c.sourceCrud.update);
router.delete('/sources/:id', requirePermission('crm.pipelines.manage'), c.sourceCrud.remove);

router.get('/labels', requirePermission('crm.leads.view'), c.labelCrud.list);
router.post('/labels', requirePermission('crm.pipelines.manage'), [body('name').notEmpty()], validate, c.labelCrud.create);
router.get('/labels/:id', requirePermission('crm.leads.view'), c.labelCrud.getOne);
router.put('/labels/:id', requirePermission('crm.pipelines.manage'), c.labelCrud.update);
router.delete('/labels/:id', requirePermission('crm.pipelines.manage'), c.labelCrud.remove);

router.get('/lead-stages', requirePermission('crm.leads.view'), c.leadStageCrud.list);
router.post('/lead-stages', requirePermission('crm.pipelines.manage'), [body('name').notEmpty()], validate, c.leadStageCrud.create);
router.delete('/lead-stages/:id', requirePermission('crm.pipelines.manage'), c.leadStageCrud.remove);

router.get('/task-stages', requirePermission('crm.tasks.view'), c.taskStageCrud.list);
router.post('/task-stages', requirePermission('crm.tasks.manage'), [body('name').notEmpty()], validate, c.taskStageCrud.create);

// ── Leads ─────────────────────────────────────────────────────────────────
router.get('/leads', requirePermission('crm.leads.view'), c.leadCrud.list);
/*
 * Capturing a lead is creating one, whoever asked for it. It sits under
 * verifyToken like everything else, so this was never an anonymous intake
 * endpoint — and nothing in the UI calls it today.
 */
router.post('/leads/from-chatbot', requirePermission('crm.leads.create'), [body('name').notEmpty()], validate, c.createChatbotLead);
router.post('/leads', requirePermission('crm.leads.create'), [body('name').notEmpty()], validate, c.leadCrud.create);
router.get('/leads/:id/score-details', requirePermission('crm.leads.view'), c.getLeadScoreDetails);
router.get('/leads/:id/follow-up-suggestion', requirePermission('crm.leads.view'), c.getFollowUpSuggestion);
// Reassigning somebody else's lead is managing the pipeline, not working it.
router.post('/leads/:id/auto-assign', requirePermission('crm.leads.manage'), c.autoAssignLead);
router.get('/leads/:id/activities', requirePermission('crm.leads.view'), c.getLeadActivities);
router.get('/leads/:id', requirePermission('crm.leads.view'), c.leadCrud.getOne);
router.put('/leads/:id', requirePermission('crm.leads.manage'), c.leadCrud.update);
router.delete('/leads/:id', requirePermission('crm.leads.manage'), c.leadCrud.remove);

// ── Objections ────────────────────────────────────────────────────────────
router.get('/objections', requirePermission('crm.objections.view'), c.objectionCrud.list);
router.post('/objections', requirePermission('crm.objections.manage'), [body('lead_id').isInt(), body('type').notEmpty(), body('description').notEmpty()], validate, c.objectionCrud.create);
router.delete('/objections/:id', requirePermission('crm.objections.manage'), c.objectionCrud.remove);

// ── Deals ─────────────────────────────────────────────────────────────────
router.get('/deals', requirePermission('crm.deals.view'), c.dealCrud.list);
router.post('/deals', requirePermission('crm.deals.manage'), [body('name').notEmpty()], validate, c.dealCrud.create);
router.get('/deals/:id', requirePermission('crm.deals.view'), c.dealCrud.getOne);
router.put('/deals/:id', requirePermission('crm.deals.manage'), c.dealCrud.update);
router.delete('/deals/:id', requirePermission('crm.deals.manage'), c.dealCrud.remove);
router.get('/deals/:id/tasks', requirePermission('crm.deals.view'), c.getDealTasks);

// ── Tasks ─────────────────────────────────────────────────────────────────
router.get('/tasks', requirePermission('crm.tasks.view'), c.taskCrud.list);
router.post('/tasks', requirePermission('crm.tasks.manage'), [body('title').notEmpty()], validate, c.taskCrud.create);
router.get('/tasks/:id', requirePermission('crm.tasks.view'), c.taskCrud.getOne);
router.put('/tasks/:id', requirePermission('crm.tasks.manage'), c.taskCrud.update);
router.delete('/tasks/:id', requirePermission('crm.tasks.manage'), c.taskCrud.remove);

// ── Activity log ──────────────────────────────────────────────────────────
// Logging a call or a note against a lead is working the lead, which is what
// crm.leads.create means here — a realtor holds it and is expected to.
router.get('/activities', requirePermission('crm.leads.view'), c.activityCrud.list);
router.post('/activities', requirePermission('crm.leads.create'), [body('type').notEmpty()], validate, c.activityCrud.create);

module.exports = router;

const router = require('express').Router();
const { body } = require('express-validator');
const { verifyToken } = require('../middleware/auth');
const { validate } = require('../middleware/validation');
const c = require('../controllers/crmController');

router.use(verifyToken);
router.get('/crm/analytics', c.getSalesAnalytics);
router.get('/analytics/agent-performance', c.getAgentPerformance);

router.get('/pipelines', c.pipelineCrud.list);
router.post('/pipelines', [body('name').notEmpty()], validate, c.pipelineCrud.create);
router.get('/pipelines/:id', c.pipelineCrud.getOne);
router.put('/pipelines/:id', c.pipelineCrud.update);
router.delete('/pipelines/:id', c.pipelineCrud.remove);

router.get('/stages', c.stageCrud.list);
router.post('/stages', [body('name').notEmpty(), body('pipeline_id').isInt()], validate, c.stageCrud.create);
router.get('/stages/:id', c.stageCrud.getOne);
router.put('/stages/:id', c.stageCrud.update);
router.delete('/stages/:id', c.stageCrud.remove);

router.get('/sources', c.sourceCrud.list);
router.post('/sources', [body('name').notEmpty()], validate, c.sourceCrud.create);
router.get('/sources/:id', c.sourceCrud.getOne);
router.put('/sources/:id', c.sourceCrud.update);
router.delete('/sources/:id', c.sourceCrud.remove);

router.get('/labels', c.labelCrud.list);
router.post('/labels', [body('name').notEmpty()], validate, c.labelCrud.create);
router.get('/labels/:id', c.labelCrud.getOne);
router.put('/labels/:id', c.labelCrud.update);
router.delete('/labels/:id', c.labelCrud.remove);

router.get('/leads', c.leadCrud.list);
router.post('/leads/from-chatbot', [body('name').notEmpty()], validate, c.createChatbotLead);
router.post('/leads', [body('name').notEmpty()], validate, c.leadCrud.create);
router.get('/leads/:id/score-details', c.getLeadScoreDetails);
router.get('/leads/:id/follow-up-suggestion', c.getFollowUpSuggestion);
router.post('/leads/:id/auto-assign', c.autoAssignLead);
router.get('/leads/:id/activities', c.getLeadActivities);
router.get('/leads/:id', c.leadCrud.getOne);
router.put('/leads/:id', c.leadCrud.update);
router.delete('/leads/:id', c.leadCrud.remove);

router.get('/objections', c.objectionCrud.list);
router.post('/objections', [body('lead_id').isInt(), body('type').notEmpty(), body('description').notEmpty()], validate, c.objectionCrud.create);
router.delete('/objections/:id', c.objectionCrud.remove);

router.get('/deals', c.dealCrud.list);
router.post('/deals', [body('name').notEmpty()], validate, c.dealCrud.create);
router.get('/deals/:id', c.dealCrud.getOne);
router.put('/deals/:id', c.dealCrud.update);
router.delete('/deals/:id', c.dealCrud.remove);
router.get('/deals/:id/tasks', c.getDealTasks);

router.get('/tasks', c.taskCrud.list);
router.post('/tasks', [body('title').notEmpty()], validate, c.taskCrud.create);
router.get('/tasks/:id', c.taskCrud.getOne);
router.put('/tasks/:id', c.taskCrud.update);
router.delete('/tasks/:id', c.taskCrud.remove);

router.get('/task-stages', c.taskStageCrud.list);
router.post('/task-stages', [body('name').notEmpty()], validate, c.taskStageCrud.create);

router.get('/lead-stages', c.leadStageCrud.list);
router.post('/lead-stages', [body('name').notEmpty()], validate, c.leadStageCrud.create);
router.delete('/lead-stages/:id', c.leadStageCrud.remove);

router.get('/activities', c.activityCrud.list);
router.post('/activities', [body('type').notEmpty()], validate, c.activityCrud.create);

module.exports = router;

const router = require('express').Router();
const { requirePermission } = require('../../../../shared/src/middleware/auth');
const controller = require('../controllers/auditController');

/**
 * The audit trail. Three routes, all of them reads.
 *
 * There is no POST, PUT, PATCH or DELETE here and there must never be. An entry
 * is written by the request it describes (shared/src/audit.js) and refused any
 * amendment by the database itself (migrations/createAuditLog.js); this router
 * simply has nothing to offer anyone who wants to change one.
 *
 * ── One permission, two scopes ──────────────────────────────────────────────
 *
 * `audit.view` is what a company administrator is granted, and it shows them
 * their own company's activity — the controller applies that scope, not this
 * file, because a route-level check cannot narrow a result set.
 *
 * A platform administrator passes requirePermission unconditionally (the
 * superior-admin bypass in shared/src/middleware/auth.js) and the same
 * controller gives them every company. So the difference between the two views
 * is one WHERE clause, in one place, rather than two endpoints that could drift.
 */
router.get('/audit-logs', requirePermission('audit.view'), controller.listAuditLogs);
// Literal path before the /:id route, or "filters" is read as an id.
router.get('/audit-logs/filters', requirePermission('audit.view'), controller.getAuditFilters);
router.get('/audit-logs/:id', requirePermission('audit.view'), controller.getAuditLog);

module.exports = router;

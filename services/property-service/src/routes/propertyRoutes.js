const router = require('express').Router();
const { body } = require('express-validator');
const { verifyToken, requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validation');
const multer = require('multer');
const controller = require('../controllers/propertyController');
const branches = require('../controllers/branchController');

// Spreadsheets are parsed in memory and never written to disk.
const uploadSheet = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

router.use(verifyToken);
/**
 * Branches — a company's offices.
 *
 * Reading is open to anyone who can see properties, because a branch name is
 * what a property listing renders; writing needs its own permission, because
 * creating and closing offices is an administrative act and closing one
 * unassigns every property it ran.
 */
router.get('/branches', requirePermission('properties.view'), branches.branchCrud.list);
router.get('/branches/:id', requirePermission('properties.view'), branches.branchCrud.getOne);
router.get('/branches/:id/properties', requirePermission('properties.view'), branches.listBranchProperties);
router.post('/branches', requirePermission('properties.branches.manage'), [body('name').notEmpty()], validate, branches.branchCrud.create);
router.put('/branches/:id', requirePermission('properties.branches.manage'), branches.branchCrud.update);
router.delete('/branches/:id', requirePermission('properties.branches.manage'), branches.branchCrud.remove);

/*
 * properties.view is held by clients and realtors too — browsing what is for
 * sale is the point of the product — so this is a low bar by design. It is
 * still a bar: before it, an account with no property permission at all read
 * the company's full portfolio, asking prices included.
 */
router.get('/properties', requirePermission('properties.view'), controller.propertyCrud.list);
router.post('/properties', requirePermission('properties.create'), [body('name').notEmpty()], validate, controller.propertyCrud.create);
// Registered before /properties/:id so these literal paths are not captured as an id.
router.get('/properties/export', requirePermission('properties.view'), controller.exportProperties);
router.get('/properties/bulk-template', requirePermission('properties.create'), controller.bulkTemplate);
router.post('/properties/bulk-import', requirePermission('properties.create'), uploadSheet.single('file'), controller.bulkImport);

// Buyer intent. Authenticated on purpose: the public page routes anonymous
// visitors through registration before this is ever called.
/*
 * properties.view, which every client and realtor holds — the bar is the same
 * as browsing, because asking to buy is what browsing is FOR. It still stops
 * an account with no property permission at all from creating purchase
 * intent, which is what no guard at all allowed.
 */
router.post('/purchase-requests', requirePermission('properties.view'), [body('token').notEmpty()], validate, controller.createPurchaseRequest);

// Read-only catalogue for realtors and clients. No create/update counterparts
// exist by design — these are the only listed-property routes.
router.get('/properties/listed', requirePermission('properties.view'), controller.listListedProperties);
router.get('/properties/listed/:id', requirePermission('properties.view'), controller.getListedProperty);

router.get('/properties/:id', requirePermission('properties.view'), controller.propertyCrud.getOne);
router.put('/properties/:id', requirePermission('properties.manage'), controller.propertyCrud.update);
router.delete('/properties/:id', requirePermission('properties.manage'), controller.propertyCrud.remove);
router.get('/properties/:id/units', requirePermission('properties.view'), controller.getUnits);
// Idempotent share link — realtors and clients may share a listed property.
router.post('/properties/:id/share-link', requirePermission('properties.view'), controller.getShareLink);
router.post('/properties/:id/checkout', requirePermission('properties.view'), [body('unit_id').notEmpty()], validate, controller.checkoutPurchase);
// Who has asked to buy this, and for how much — a seller's view, not a browser's.
router.get('/properties/:id/purchase-requests', requirePermission('properties.manage'), controller.listPurchaseRequests);
/**
 * Unit configurations live on property_units. The /property-units routes below
 * manage the measurement-unit CATALOG and are a different resource entirely.
 *
 * These three required nothing but a valid token, so any authenticated user —
 * a client included — could rewrite a property's unit prices and available
 * quantities. Gated on properties.units.manage, which the platform admin, super
 * admin, admin and product manager hold by default.
 */
router.post('/properties/:id/units', requirePermission('properties.units.manage'), controller.addPropertyUnit);
router.put('/properties/:id/units/:unitId', requirePermission('properties.units.manage'), controller.updatePropertyUnit);
router.delete('/properties/:id/units/:unitId', requirePermission('properties.units.manage'), controller.deletePropertyUnit);

/**
 * Which installment plans this property's units may be sold on.
 *
 * The read is deliberately ungated beyond a token: it is the same information a
 * buyer already sees in the plan picker at checkout, and the purchase screen
 * needs it. Changing an assignment goes through finance's
 * /installment-plans/:id/units, gated on the same permission.
 */
router.get('/properties/:id/installment-plans', requirePermission('properties.view'), controller.getPropertyInstallmentPlans);
router.get('/properties/:id/plots', requirePermission('properties.view'), controller.getPlots);
router.get('/properties/:id/amenities', requirePermission('properties.view'), controller.getAmenities);
router.post('/properties/:id/amenities', requirePermission('properties.manage'), [body('name').notEmpty()], validate, controller.addAmenity);

// Property approval workflow
router.post('/properties/:id/approve', requirePermission('properties.approve'), controller.approveProperty);
router.post('/properties/:id/reject', requirePermission('properties.approve'), controller.rejectProperty);
router.post('/properties/:id/request-revision', requirePermission('properties.approve'), controller.requestRevision);
// Submitting for approval is the author's move, not the approver's.
router.post('/properties/:id/submit', requirePermission('properties.create'), controller.submitProperty);

// Public share link
// A marketing link with no realtor attribution — the company's to publish.
router.post('/properties/:id/public-link', requirePermission('properties.manage'), [body('expires_at').optional({ nullable: true }).isISO8601()], validate, controller.createPublicLink);
router.delete('/properties/:id/public-link', requirePermission('properties.manage'), controller.revokePublicLink);

/**
 * Property documents.
 *
 * Reading is open to any authenticated caller, because the controller decides
 * what they may see: staff get everything, anyone else gets only the documents
 * marked shareable. Writing is not — uploading, sharing and deleting are all
 * properties.manage.
 *
 * These three previously required nothing beyond a valid token. Adding one was
 * open to any signed-in user including a client, and DELETE looked a document
 * up by id with no company scope at all, so anyone could delete any document in
 * any company by guessing an integer.
 */
router.get('/properties/:id/documents', requirePermission('properties.view'), controller.getDocuments);
router.post('/properties/:id/documents', requirePermission('properties.manage'), [
  body('name').notEmpty(),
  body('url').notEmpty(),
], validate, controller.addDocument);
router.patch('/property-documents/:id/shareable', requirePermission('properties.manage'), [
  body('is_shareable').isBoolean(),
], validate, controller.setDocumentShareable);
router.delete('/property-documents/:id', requirePermission('properties.manage'), controller.deleteDocument);

router.get('/inspections', requirePermission('properties.inspections.view'), controller.inspectionCrud.list);
// Literal path before any /inspections/:id routes.
router.get('/inspections/my-clients', requirePermission('properties.inspections.view'), controller.getMyClients);
// Picking a lead to book an inspection for, so it needs sight of leads too.
router.get('/inspections/leads', requirePermission('properties.inspections.manage', 'crm.leads.view'), controller.getSelectableLeads);
// The lead supplies the client details, so client_name/phone are no longer inputs.
router.post('/inspections', requirePermission('properties.inspections.manage'), [body('property_name').notEmpty(), body('lead_id').isInt(), body('realtor_name').notEmpty(), body('scheduled_at').notEmpty(), body('attendees').optional().isInt({ min: 1 })], validate, controller.inspectionCrud.create);
router.put('/inspections/:id', requirePermission('properties.inspections.manage'), controller.inspectionCrud.update);
router.post('/inspections/:id/approve', requirePermission('properties.inspections.manage'), controller.approveInspection);
router.post('/inspections/:id/reject', requirePermission('properties.inspections.manage'), controller.rejectInspection);
router.post('/inspections/:id/confirm', requirePermission('properties.inspections.manage'), controller.confirmInspection);
router.post('/inspections/:id/complete', requirePermission('properties.inspections.manage'), [body('client_satisfaction').optional().isInt({ min: 1, max: 5 })], validate, controller.completeInspection);
router.post('/inspections/:id/cancel', requirePermission('properties.inspections.manage'), controller.cancelInspection);

// Lookup data the property forms are drawn from.
router.get('/property-types', requirePermission('properties.view'), controller.typeCrud.list);
router.post('/property-types', requirePermission('properties.manage'), [body('name').notEmpty()], validate, controller.typeCrud.create);
router.get('/property-types/:id', requirePermission('properties.view'), controller.typeCrud.getOne);
router.put('/property-types/:id', requirePermission('properties.manage'), controller.typeCrud.update);
router.delete('/property-types/:id', requirePermission('properties.manage'), controller.typeCrud.remove);

// The measurement-unit catalogue (sqm, plots, ...). Reference data every
// authenticated user reads and only unit managers change — it was writable by
// anyone with a token for the same reason the routes above were.
router.get('/property-units', requirePermission('properties.view'), controller.unitCrud.list);
router.post('/property-units', requirePermission('properties.units.manage'), [body('name').notEmpty()], validate, controller.unitCrud.create);
router.get('/property-units/:id', requirePermission('properties.view'), controller.unitCrud.getOne);
router.put('/property-units/:id', requirePermission('properties.units.manage'), controller.unitCrud.update);
router.delete('/property-units/:id', requirePermission('properties.units.manage'), controller.unitCrud.remove);

module.exports = router;

/**
 * ── Promotions ──────────────────────────────────────────────────────────────
 *
 * Configuring campaigns is `promotions.manage`; going live is
 * `promotions.publish`. They are separate because they are separate decisions:
 * drafting a 40%-off campaign is work, publishing one is a commitment of the
 * company's money, and plenty of companies want the second to need somebody
 * more senior than the first.
 */
const promotionController = require('../controllers/promotionController');

router.get('/promotions', requirePermission('promotions.view'), promotionController.listPromotions);
router.post('/promotions', requirePermission('promotions.manage'), [body('name').notEmpty()], validate, promotionController.createPromotion);
router.get('/promotions/analytics', requirePermission('promotions.view'), promotionController.promotionAnalytics);
/**
 * Preview and validate take a configuration rather than an id, so a campaign
 * can be tested before it has been saved at all — which is when a mistake is
 * cheapest to fix.
 */
router.post('/promotions/preview', requirePermission('promotions.manage'), promotionController.previewPromotion);
router.post('/promotions/validate', requirePermission('promotions.manage'), promotionController.validateDraft);
router.get('/promotions/:id', requirePermission('promotions.view'), promotionController.getPromotion);
router.put('/promotions/:id', requirePermission('promotions.manage'), [body('name').notEmpty()], validate, promotionController.updatePromotion);
router.post('/promotions/:id/status', requirePermission('promotions.publish'), [body('status').notEmpty()], validate, promotionController.setStatus);
router.get('/promotions/:id/analytics', requirePermission('promotions.view'), promotionController.promotionAnalytics);

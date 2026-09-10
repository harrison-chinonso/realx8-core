const router = require('express').Router();
const { body } = require('express-validator');
const { verifyToken, requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validation');
const multer = require('multer');
const controller = require('../controllers/propertyController');

// Spreadsheets are parsed in memory and never written to disk.
const uploadSheet = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

router.use(verifyToken);
router.get('/properties', controller.propertyCrud.list);
router.post('/properties', [body('name').notEmpty()], validate, controller.propertyCrud.create);
// Registered before /properties/:id so these literal paths are not captured as an id.
router.get('/properties/export', controller.exportProperties);
router.get('/properties/bulk-template', controller.bulkTemplate);
router.post('/properties/bulk-import', uploadSheet.single('file'), controller.bulkImport);

// Buyer intent. Authenticated on purpose: the public page routes anonymous
// visitors through registration before this is ever called.
router.post('/purchase-requests', [body('token').notEmpty()], validate, controller.createPurchaseRequest);

// Read-only catalogue for realtors and clients. No create/update counterparts
// exist by design — these are the only listed-property routes.
router.get('/properties/listed', controller.listListedProperties);
router.get('/properties/listed/:id', controller.getListedProperty);

router.get('/properties/:id', controller.propertyCrud.getOne);
router.put('/properties/:id', controller.propertyCrud.update);
router.delete('/properties/:id', controller.propertyCrud.remove);
router.get('/properties/:id/units', controller.getUnits);
// Idempotent share link — realtors and clients may share a listed property.
router.post('/properties/:id/share-link', controller.getShareLink);
router.post('/properties/:id/checkout', [body('unit_id').notEmpty()], validate, controller.checkoutPurchase);
router.get('/properties/:id/purchase-requests', controller.listPurchaseRequests);
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
router.get('/properties/:id/installment-plans', controller.getPropertyInstallmentPlans);
router.get('/properties/:id/plots', controller.getPlots);
router.get('/properties/:id/amenities', controller.getAmenities);
router.post('/properties/:id/amenities', [body('name').notEmpty()], validate, controller.addAmenity);

// Property approval workflow
router.post('/properties/:id/approve', controller.approveProperty);
router.post('/properties/:id/reject', controller.rejectProperty);
router.post('/properties/:id/request-revision', controller.requestRevision);
router.post('/properties/:id/submit', controller.submitProperty);

// Public share link
router.post('/properties/:id/public-link', [body('expires_at').optional({ nullable: true }).isISO8601()], validate, controller.createPublicLink);
router.delete('/properties/:id/public-link', controller.revokePublicLink);

// Property documents
router.get('/properties/:id/documents', controller.getDocuments);
router.post('/properties/:id/documents', controller.addDocument);
router.delete('/property-documents/:id', controller.deleteDocument);

router.get('/inspections', controller.inspectionCrud.list);
// Literal path before any /inspections/:id routes.
router.get('/inspections/my-clients', controller.getMyClients);
router.get('/inspections/leads', controller.getSelectableLeads);
// The lead supplies the client details, so client_name/phone are no longer inputs.
router.post('/inspections', [body('property_name').notEmpty(), body('lead_id').isInt(), body('realtor_name').notEmpty(), body('scheduled_at').notEmpty(), body('attendees').optional().isInt({ min: 1 })], validate, controller.inspectionCrud.create);
router.put('/inspections/:id', controller.inspectionCrud.update);
router.post('/inspections/:id/approve', controller.approveInspection);
router.post('/inspections/:id/reject', controller.rejectInspection);
router.post('/inspections/:id/confirm', controller.confirmInspection);
router.post('/inspections/:id/complete', [body('client_satisfaction').optional().isInt({ min: 1, max: 5 })], validate, controller.completeInspection);
router.post('/inspections/:id/cancel', controller.cancelInspection);

router.get('/property-types', controller.typeCrud.list);
router.post('/property-types', [body('name').notEmpty()], validate, controller.typeCrud.create);
router.get('/property-types/:id', controller.typeCrud.getOne);
router.put('/property-types/:id', controller.typeCrud.update);
router.delete('/property-types/:id', controller.typeCrud.remove);

// The measurement-unit catalogue (sqm, plots, ...). Reference data every
// authenticated user reads and only unit managers change — it was writable by
// anyone with a token for the same reason the routes above were.
router.get('/property-units', controller.unitCrud.list);
router.post('/property-units', requirePermission('properties.units.manage'), [body('name').notEmpty()], validate, controller.unitCrud.create);
router.get('/property-units/:id', controller.unitCrud.getOne);
router.put('/property-units/:id', requirePermission('properties.units.manage'), controller.unitCrud.update);
router.delete('/property-units/:id', requirePermission('properties.units.manage'), controller.unitCrud.remove);

module.exports = router;

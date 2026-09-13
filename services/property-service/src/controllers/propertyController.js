const crypto = require('crypto');
const { Op, QueryTypes } = require('sequelize');
const { likeOperator } = require('../../../../shared/src/dialect');
const ExcelJS = require('exceljs');
const asyncHandler = require('../utils/asyncHandler');
const { buildCrudController, buildCompanyScope, withCompanyAudit } = require('../utils/crudFactory');
const { sequelize, Property, PropertyType, PropertyUnit, PropertyUnits, PropertyPlots, PropertyAmenity, PropertyDocument, Inspection, PurchaseRequest } = require('../models');
const { importColumns, exportColumns, cellValue, rowToProperty, STATUSES, MEASUREMENT_UNITS } = require('../utils/propertySheet');
const { resolveCompanyCodes, companyCodesByPropertyIds, listCompanyCodes } = require('../utils/companyLookup');
const { findRealtorIdByName, listRealtorClients, listSelectableLeads, getSelectableLead } = require('../utils/userLookup');
const { createInvoiceForPurchase } = require('../utils/invoiceGateway');
const { invoiceDueDays } = require('../../../../shared/src/invoiceDueDays');
const { heldQuantityByUnit, availabilityFor } = require('../../../../shared/src/inventoryGateway');
const { createPaymentPlan, priceForPurchase } = require('../../../../shared/src/paymentPlanGateway');
const { toMajor } = require('../../../../shared/src/money');
const { createDispatcher } = require('../../../../shared/src/notificationDispatcher');
const { appUrl } = require('../../../../shared/src/appOrigin');
// Every notification this service sends goes through here, so the recipients
// come from configuration rather than from the call sites.
const notify = createDispatcher(sequelize);

const companyScope = (req) => buildCompanyScope(req);

// Follows the ACTIVE profile, not the static users.type column, so a user who
// switches from their realtor profile to their client profile stops being
// scoped to realtor-only inspections.
const isRealtor = (req) => (req.user?.effectiveType || req.user?.type) === 'realtor';

/** Purchasing is strictly for client accounts — not realtors, not staff. */
const isClientBuyer = (req) => (req.user?.effectiveType || req.user?.type) === 'client';
const BUYER_ONLY = { message: 'Purchasing is available to client accounts only.' };

/**
 * Company scope plus, for realtors, a restriction to their own inspections.
 *
 * The realtor clause is wrapped in Op.and deliberately. crudFactory builds its
 * WHERE by spreading defaultWhere and the search filter into one object, and the
 * search filter uses Op.or — an Op.or here would be silently overwritten the
 * moment a realtor typed in the search box, exposing every inspection. Do not
 * "simplify" this to a top-level Op.or.
 */
const inspectionScope = (req) => {
  const scope = companyScope(req);

  // A client is not staff: they were falling through to the company-wide view
  // and could read every inspection in the company, including other people's
  // names and phone numbers. They see only inspections raised against a lead
  // carrying their own email — which today is usually none.
  const acting = req.user?.effectiveType || req.user?.type;
  if (acting === 'client') {
    const email = req.user?.email;
    if (!email) return { ...scope, id: null };
    return {
      ...scope,
      lead_id: {
        [Op.in]: sequelize.literal(
          `(SELECT id FROM leads WHERE email = ${sequelize.escape(email)})`,
        ),
      },
    };
  }

  if (!isRealtor(req)) return scope;

  return {
    ...scope,
    [Op.and]: [{
      [Op.or]: [
        { realtor_id: req.user.id },
        // Legacy rows created before realtor_id existed.
        { realtor_id: null, realtor_name: req.user.name || '\u0000' },
      ],
    }],
  };
};

/**
 * Next reference in a prefixed sequence, e.g. INV-0007.
 *
 * Derived from the HIGHEST number in use, not from the newest row. Reading only
 * the newest row reissued a number that already existed whenever the last row
 * was deleted, or whenever any reference did not end in digits — and these
 * columns are uniquely indexed, so the insert then failed.
 */
const buildSequence = async (Model, field, prefix) => {
  const rows = await Model.findAll({ attributes: [field], raw: true });
  const highest = rows.reduce((max, row) => {
    const value = String(row?.[field] ?? '');
    if (!value.startsWith(prefix)) return max;
    const suffix = Number(value.slice(prefix.length));
    return Number.isInteger(suffix) && suffix > max ? suffix : max;
  }, 0);
  return `${prefix}${String(highest + 1).padStart(4, '0')}`;
};

const propertyCrud = buildCrudController(Property, {
  include: [{ model: PropertyUnits, as: 'units' }, { model: PropertyPlots, as: 'plots' }, { model: PropertyAmenity, as: 'amenities' }, { model: PropertyUnit, as: 'lowestUnit' }],
  searchFields: ['name', 'city', 'state', 'country', 'status', 'type'],
  defaultWhere: companyScope, scopeWhere: companyScope,
  beforeCreate: (req) => withCompanyAudit(req),
  // A property is created together with its first unit configuration(s); price
  // now lives on the unit, so the property summary is derived from them.
  afterCreate: async (entity, req) => {
    const units = Array.isArray(req.body?.units) ? req.body.units : [];
    if (!units.length) return entity;
    for (const unit of units) {
      await PropertyUnits.create(buildUnitPayload(unit, entity.id));
    }
    await syncPropertySummary(entity.id);
    await entity.reload();
    return entity;
  },
});

const typeCrud = buildCrudController(PropertyType, {
  searchFields: ['name'],
  defaultWhere: companyScope, scopeWhere: companyScope,
  beforeCreate: (req) => withCompanyAudit(req),
});
const unitCrud = buildCrudController(PropertyUnit, { searchFields: ['name', 'symbol'] });
const inspectionCrud = buildCrudController(Inspection, {
  include: [{ model: Property, as: 'property' }],
  searchFields: ['ref_number', 'property_name', 'client_name', 'client_phone', 'realtor_name', 'status'],
  defaultWhere: inspectionScope, scopeWhere: inspectionScope,
  // Tell the realtor they have been assigned. Fire-and-forget: a failed
  // notification must not fail the inspection.
  afterCreate: async (inspection) => {
    notify.dispatch({
      eventKey: 'inspection_assigned',
      subjectUserId: inspection.realtor_id ?? null,
      companyId: inspection.company_id ?? null,
      context: { inspection },
      title: () => `Inspection assigned — ${inspection.ref_number}`,
      body: (role) => (role === 'subject'
        ? `You have been assigned an inspection of ${inspection.property_name} for ${inspection.client_name}`
          + ` on ${new Date(inspection.scheduled_at).toLocaleString()}. Reference ${inspection.ref_number}.`
        : `${inspection.realtor_name || 'A realtor'} has been assigned an inspection of `
          + `${inspection.property_name} on ${new Date(inspection.scheduled_at).toLocaleString()}.`),
      data: { inspection_id: inspection.id, property_id: inspection.property_id, ref_number: inspection.ref_number },
    }).catch(() => {});
    return inspection;
  },
  beforeCreate: async (req) => ({
    ...withCompanyAudit(req),
    // Throws 400/403 when the lead is missing or not the realtor's own.
    ...(await resolveInspectionLead(req)),
    ref_number: await buildSequence(Inspection, 'ref_number', 'INSP-'),
    property_id: req.body.property_id || null,
    property_name: req.body.property_name,
    realtor_name: req.body.realtor_name,
    // A realtor can only file inspections against themselves; for anyone else
    // resolve the typed name, falling back to null when it is ambiguous.
    realtor_id: isRealtor(req)
      ? req.user.id
      : (req.body.realtor_id || await findRealtorIdByName(req.body.realtor_name, req.user?.company_id)),
    attendees: Math.max(Number(req.body.attendees) || 1, 1),
    // A realtor's own booking goes to an admin for sign-off; staff bookings are
    // approved as they are made.
    approval_status: isRealtor(req) ? 'pending_approval' : 'approved',
    scheduled_at: req.body.scheduled_at,
    status: req.body.status || 'pending',
    notes: req.body.notes || null,
  }),
});

const getUnits = asyncHandler(async (req, res) => {
  const property = await Property.findOne({ where: { id: req.params.id, ...companyScope(req) } });
  if (!property) return res.status(404).json({ message: 'Property not found' });
  const units = await PropertyUnits.findAll({ where: { property_id: req.params.id } });
  // The purchase screen prices against this list, so it needs to know what is
  // actually left rather than the configured quantity (FRD 10.1).
  res.json({ data: await withAvailability(units) });
});

const getPlots = asyncHandler(async (req, res) => {
  const property = await Property.findOne({ where: { id: req.params.id, ...companyScope(req) } });
  if (!property) return res.status(404).json({ message: 'Property not found' });
  const plots = await PropertyPlots.findAll({ where: { property_id: req.params.id } });
  res.json({ data: plots });
});

const getAmenities = asyncHandler(async (req, res) => {
  const property = await Property.findOne({ where: { id: req.params.id, ...companyScope(req) } });
  if (!property) return res.status(404).json({ message: 'Property not found' });
  const amenities = await PropertyAmenity.findAll({ where: { property_id: req.params.id, company_id: property.company_id } } );
  res.json({ data: amenities });
});

const addAmenity = asyncHandler(async (req, res) => {
  const where = { id: req.params.id, ...companyScope(req) };
  const property = await Property.findOne({ where });
  if (!property) return res.status(404).json({ message: 'Property not found' });
  const amenity = await PropertyAmenity.create({
    property_id: property.id,
    ...req.body,
    company_id: property.company_id,
  });
  res.status(201).json({ data: amenity });
});

/**
 * Inspection status transitions, each announcing itself.
 *
 * These were silent, which meant an inspection could be confirmed, completed
 * or cancelled with nobody but the person clicking the button any the wiser —
 * and the assigned realtor is precisely who needs to know that a viewing they
 * are due to run has been called off.
 *
 * The subject is the assigned realtor; the wider group is whoever holds
 * properties.inspections.view.
 */
const INSPECTION_ANNOUNCEMENTS = {
  confirmed: {
    eventKey: 'inspection_confirmed',
    title: 'Inspection confirmed',
    subjectLine: (i) => `Your inspection ${i.ref_number} at ${i.property_name} for ${i.client_name} is confirmed.`,
    othersLine: (i) => `Inspection ${i.ref_number} at ${i.property_name} has been confirmed.`,
  },
  cancelled: {
    eventKey: 'inspection_cancelled',
    title: 'Inspection cancelled',
    subjectLine: (i) => `Your inspection ${i.ref_number} at ${i.property_name} for ${i.client_name} has been cancelled.`,
    othersLine: (i) => `Inspection ${i.ref_number} at ${i.property_name} has been cancelled.`,
  },
  completed: {
    eventKey: 'inspection_completed',
    title: 'Inspection completed',
    subjectLine: (i) => `Your inspection ${i.ref_number} at ${i.property_name} is recorded as completed.`,
    othersLine: (i) => `Inspection ${i.ref_number} at ${i.property_name} was completed`
      + `${i.client_satisfaction ? ` with a satisfaction rating of ${i.client_satisfaction}/5` : ''}.`,
  },
};

const updateInspectionStatus = (status, extra = () => ({})) => asyncHandler(async (req, res) => {
  const inspection = await Inspection.findOne({ where: { id: req.params.id, ...inspectionScope(req) } });
  if (!inspection) {
    return res.status(404).json({ message: 'Inspection not found' });
  }
  await inspection.update({ status, ...extra(req) });

  const announcement = INSPECTION_ANNOUNCEMENTS[status];
  if (announcement) {
    notify.dispatch({
      eventKey: announcement.eventKey,
      subjectUserId: inspection.realtor_id ?? null,
      companyId: inspection.company_id ?? null,
      context: { inspection },
      title: () => `${announcement.title} — ${inspection.ref_number}`,
      body: (role) => (role === 'subject'
        ? announcement.subjectLine(inspection)
        : announcement.othersLine(inspection)),
      data: { inspection_id: inspection.id, ref_number: inspection.ref_number, status },
      actionLabel: 'View inspection',
      actionUrl: appUrl('inspections', req),
    }).catch(() => {});
  }

  res.json({ data: inspection });
});

const confirmInspection = updateInspectionStatus('confirmed');
const cancelInspection = updateInspectionStatus('cancelled');
const completeInspection = updateInspectionStatus('completed', (req) => ({
  client_satisfaction: req.body.client_satisfaction || null,
  client_feedback: req.body.client_feedback || null,
  realtor_notes: req.body.realtor_notes || null,
}));


// ── Unit configurations ───────────────────────────────────────────────────────

const MEASUREMENT_UNIT_VALUES = ['sqm', 'sqft', 'hectares', 'acres', 'plots'];

/** Builds a validated PropertyUnits payload from request body fields. */
const buildUnitPayload = (body, propertyId) => {
  const size = body.size === '' || body.size === null || body.size === undefined ? null : Number(body.size);
  const price = body.price === '' || body.price === null || body.price === undefined ? 0 : Number(body.price);
  const quantity = body.quantity === '' || body.quantity === null || body.quantity === undefined ? 1 : Number(body.quantity);
  const unit = String(body.unit || 'sqm').toLowerCase();

  if (size !== null && (!Number.isFinite(size) || size < 0)) throw Object.assign(new Error('Property Size must be a positive number'), { status: 400 });
  if (!Number.isFinite(price) || price < 0) throw Object.assign(new Error('Price must be a positive number'), { status: 400 });
  if (!Number.isFinite(quantity) || quantity < 0 || !Number.isInteger(quantity)) throw Object.assign(new Error('Quantity must be a whole number'), { status: 400 });
  if (!MEASUREMENT_UNIT_VALUES.includes(unit)) throw Object.assign(new Error(`Measured In must be one of: ${MEASUREMENT_UNIT_VALUES.join(', ')}`), { status: 400 });

  return {
    property_id: propertyId,
    // Name is a display label; derive one when the caller does not supply it.
    name: String(body.name || '').trim() || (size !== null ? `${size} ${unit}` : `${quantity} ${unit}`),
    size: size === null ? null : String(size),
    unit,
    price,
    quantity,
    status: String(body.status || 'available').toLowerCase(),
  };
};

/**
 * Property-level price/unit fields mirror the unit configurations so existing
 * listing, export and card surfaces keep working:
 *   price  = the lowest unit price (a "from" price)
 *   unit_* = the first configuration
 * Called after any change to a property's units.
 */
const syncPropertySummary = async (propertyId, transaction = null) => {
  const units = await PropertyUnits.findAll({
    where: { property_id: propertyId },
    order: [['id', 'ASC']],
    transaction,
  });

  const property = await Property.findByPk(propertyId, { transaction });
  if (!property) return;

  if (!units.length) {
    await property.update({ price: 0, unit_quantity: 0, unit_measurement: null }, { transaction });
    return;
  }

  const prices = units.map((u) => Number(u.price) || 0).filter((p) => p > 0);
  const primary = units[0];

  await property.update({
    price: prices.length ? Math.min(...prices) : 0,
    unit_quantity: units.reduce((total, u) => total + (Number(u.quantity) || 0), 0),
    unit_measurement: primary.size === null ? null : Number(primary.size),
    unit_measurement_unit: primary.unit || 'sqm',
  }, { transaction });
};

const addPropertyUnit = asyncHandler(async (req, res) => {
  const property = await requireProperty(req);
  const unit = await PropertyUnits.create(buildUnitPayload(req.body, property.id));
  await syncPropertySummary(property.id);
  res.status(201).json({ data: unit });
});

const updatePropertyUnit = asyncHandler(async (req, res) => {
  const property = await requireProperty(req);
  const unit = await PropertyUnits.findOne({ where: { id: req.params.unitId, property_id: property.id } });
  if (!unit) return res.status(404).json({ message: 'Unit configuration not found' });

  await unit.update(buildUnitPayload({ ...unit.get({ plain: true }), ...req.body }, property.id));
  await syncPropertySummary(property.id);
  res.json({ data: unit });
});

const deletePropertyUnit = asyncHandler(async (req, res) => {
  const property = await requireProperty(req);
  const unit = await PropertyUnits.findOne({ where: { id: req.params.unitId, property_id: property.id } });
  if (!unit) return res.status(404).json({ message: 'Unit configuration not found' });

  await unit.destroy();
  await syncPropertySummary(property.id);
  res.json({ message: 'Unit configuration deleted' });
});


// ── Inspection scheduling and approval ────────────────────────────────────────

/** Clients a realtor may book an inspection for. Staff get the full client list elsewhere. */
const getMyClients = asyncHandler(async (req, res) => {
  if (!isRealtor(req)) return res.status(403).json({ message: 'Only realtors have an assigned client list.' });
  const clients = await listRealtorClients(req.user.id, req.user.company_id);
  res.json({ data: clients });
});

/** Leads the caller may attach to an inspection. */
const getSelectableLeads = asyncHandler(async (req, res) => {
  // A null realtorId means "every lead in the company", which is right for
  // staff picking one — but a client was falling into that branch and being
  // handed every lead's name, email and phone. They have no lead to pick.
  const acting = req.user?.effectiveType || req.user?.type;
  if (acting === 'client') return res.json({ data: [] });

  const leads = await listSelectableLeads({
    realtorId: isRealtor(req) ? req.user.id : null,
    companyId: req.user?.company_id ?? null,
  });
  res.json({ data: leads });
});

/**
 * Resolves the lead an inspection is for, enforcing that a realtor may only use
 * leads they created or were assigned. Verified server-side — the constrained
 * dropdown is convenience, not the control. Returns the snapshot fields.
 */
const resolveInspectionLead = async (req) => {
  // Inspections are arranged by a realtor or by staff. A client is neither, and
  // "not a realtor" used to mean "may use any lead in the company" — so a
  // client could book a viewing against somebody else's lead.
  const acting = req.user?.effectiveType || req.user?.type;
  if (acting === 'client') {
    throw Object.assign(
      new Error('Clients cannot schedule inspections directly. Ask your realtor, or raise a request through support.'),
      { status: 403 },
    );
  }

  const leadId = req.body.lead_id;
  if (!leadId) {
    throw Object.assign(new Error('Select a lead for this inspection.'), { status: 400 });
  }
  const lead = await getSelectableLead({
    leadId,
    realtorId: isRealtor(req) ? req.user.id : null,
    companyId: req.user?.company_id ?? null,
  });
  if (!lead) {
    throw Object.assign(
      new Error(isRealtor(req)
        ? 'You can only schedule inspections for leads you created or were assigned.'
        : 'That lead was not found.'),
      { status: 403 },
    );
  }
  return {
    lead_id: lead.id,
    client_name: lead.name,
    client_phone: lead.phone || req.body.client_phone || 'N/A',
  };
};

const setInspectionApproval = (approval_status) => asyncHandler(async (req, res) => {
  if (isRealtor(req)) {
    return res.status(403).json({ message: 'Only an administrator can review inspection requests.' });
  }
  const inspection = await Inspection.findOne({ where: { id: req.params.id, ...companyScope(req) } });
  if (!inspection) return res.status(404).json({ message: 'Inspection not found' });

  // Cancelled or completed inspections are settled — reviewing them would
  // resurrect a request the realtor already withdrew or fulfilled.
  if (['cancelled', 'completed'].includes(inspection.status)) {
    return res.status(409).json({ message: `This inspection is already ${inspection.status} and can no longer be reviewed.` });
  }

  if (inspection.approval_status !== 'pending_approval') {
    return res.status(409).json({ message: `This inspection has already been ${inspection.approval_status}.` });
  }

  // A decline must explain itself — the note is emailed to the realtor, so an
  // empty one leaves them with no idea what to fix. Optional when approving.
  const notes = String(req.body.notes ?? '').trim();
  if (approval_status === 'rejected' && !notes) {
    return res.status(400).json({ message: 'A reason is required when declining an inspection request.' });
  }

  await inspection.update({
    approval_status,
    approval_notes: notes || null,
    approved_by: req.user?.id ?? null,
    approved_at: new Date(),
  });

  // Was a direct notification to the realtor alone, with the recipient fixed
  // in code. Now a configured event, so a company can also copy whoever
  // oversees inspections without touching this.
  notify.dispatch({
    eventKey: approval_status === 'approved' ? 'inspection_approved' : 'inspection_rejected',
    subjectUserId: inspection.realtor_id ?? null,
    companyId: inspection.company_id ?? null,
    context: { inspection },
    title: () => (approval_status === 'approved'
      ? `Inspection approved — ${inspection.ref_number}`
      : `Inspection request declined — ${inspection.ref_number}`),
    body: (role) => [
      role === 'subject'
        ? `Your inspection ${inspection.ref_number} for ${inspection.client_name} at `
          + `${inspection.property_name} was ${approval_status === 'approved' ? 'approved' : 'declined'}.`
        : `Inspection ${inspection.ref_number} at ${inspection.property_name} was `
          + `${approval_status === 'approved' ? 'approved' : 'declined'}.`,
      notes ? `Note: ${notes}` : null,
    ].filter(Boolean).join('\n'),
    data: { inspection_id: inspection.id, ref_number: inspection.ref_number },
    actionLabel: 'View inspection',
    actionUrl: appUrl('inspections', req),
  }).catch(() => {});

  res.json({ data: inspection });
});

const approveInspection = setInspectionApproval('approved');
const rejectInspection = setInspectionApproval('rejected');

// ── Property approval workflow ────────────────────────────────────────────────

const requireProperty = async (req) => {
  const property = await Property.findOne({ where: { id: req.params.id, ...companyScope(req) } });
  if (!property) throw Object.assign(new Error('Property not found'), { status: 404 });
  return property;
};

/**
 * The property approval workflow.
 *
 * All four of these were silent: a property could sit in pending_review with
 * nobody told it needed reviewing, and a submitter could be rejected without
 * hearing about it. Each now dispatches a configured event — the reviewer group
 * is whoever holds properties.approve, so a company that delegates approval to
 * a product manager does not have to change anything here.
 */
const submitProperty = asyncHandler(async (req, res) => {
  const property = await requireProperty(req);
  await property.update({ approval_status: 'pending_review' });

  notify.dispatch({
    eventKey: 'property_submitted',
    subjectUserId: property.created_by ?? req.user?.id ?? null,
    companyId: property.company_id ?? null,
    context: { property },
    title: () => `Property awaiting review — ${property.name}`,
    body: (role) => (role === 'subject'
      ? `You submitted "${property.name}" for approval. You will be told once it has been reviewed.`
      : `"${property.name}" has been submitted for approval and is waiting on a review.`),
    data: { property_id: property.id },
    actionLabel: 'Review property',
    actionUrl: appUrl(`properties/${property.id}`, req),
  }).catch(() => {});

  res.json({ data: property });
});

/** Shared body for the three review outcomes. */
const announceReview = (property, req, { eventKey, title, subjectLine, othersLine, notes }) => {
  notify.dispatch({
    eventKey,
    subjectUserId: property.created_by ?? null,
    companyId: property.company_id ?? null,
    context: { property },
    title: () => title,
    body: (role) => [
      role === 'subject' ? subjectLine : othersLine,
      notes ? `Note: ${notes}` : null,
    ].filter(Boolean).join('\n'),
    data: { property_id: property.id, notes: notes || null },
    actionLabel: 'View property',
    actionUrl: appUrl(`properties/${property.id}`, req),
  }).catch(() => {});
};

const approveProperty = asyncHandler(async (req, res) => {
  const property = await requireProperty(req);
  await property.update({
    approval_status: 'approved',
    status: 'available',
    approved_by: req.user?.id,
    approved_at: new Date(),
    approval_notes: req.body.notes || null,
  });

  announceReview(property, req, {
    eventKey: 'property_approved',
    title: `Property approved — ${property.name}`,
    subjectLine: `"${property.name}" has been approved and is now listed.`,
    othersLine: `"${property.name}" has been approved and is now listed for sale.`,
    notes: String(req.body.notes || '').trim(),
  });

  res.json({ data: property });
});

const rejectProperty = asyncHandler(async (req, res) => {
  const property = await requireProperty(req);
  await property.update({
    approval_status: 'rejected',
    approval_notes: req.body.notes || null,
  });

  announceReview(property, req, {
    eventKey: 'property_rejected',
    title: `Property rejected — ${property.name}`,
    subjectLine: `"${property.name}" was not approved.`,
    othersLine: `"${property.name}" was rejected.`,
    notes: String(req.body.notes || '').trim(),
  });

  res.json({ data: property });
});

const requestRevision = asyncHandler(async (req, res) => {
  const property = await requireProperty(req);
  await property.update({
    approval_status: 'revision_requested',
    approval_notes: req.body.notes || null,
  });

  announceReview(property, req, {
    eventKey: 'property_revision_requested',
    title: `Changes requested — ${property.name}`,
    subjectLine: `"${property.name}" needs changes before it can be approved.`,
    othersLine: `Changes were requested on "${property.name}".`,
    notes: String(req.body.notes || '').trim(),
  });

  res.json({ data: property });
});

// ── Property documents ────────────────────────────────────────────────────────

/**
 * True for anyone who is not staff — a buyer or a realtor browsing the listing.
 *
 * Written as "not staff" rather than "is a client" so a role added later is
 * excluded by default. The failure direction matters here: the mistake to avoid
 * is showing internal paperwork to someone who should not have it.
 */
const isOutsideStaff = (req) => isClientBuyer(req) || isRealtor(req);

const getDocuments = asyncHandler(async (req, res) => {
  const outsider = isOutsideStaff(req);

  const docs = await PropertyDocument.findAll({
    // A buyer sees only what has been explicitly marked shareable; staff see
    // the lot. Applied in the QUERY, so an unshared document is never loaded,
    // let alone serialised and filtered afterwards.
    where: { property_id: req.params.id, ...(outsider ? { is_shareable: true } : {}) },
    order: [['id', 'DESC']],
  });

  /**
   * Shared means view, not download.
   *
   * `can_download` is what the UI keys its affordances off, so the rule lives
   * here rather than being re-derived per screen.
   *
   * Worth being plain about the limit: withholding a download BUTTON is not the
   * same as preventing a download. The URL is a fetchable file, and anyone who
   * opens it can save it. Genuinely enforcing view-only needs short-lived
   * signed URLs or a server-rendered viewer that never hands over the original
   * — neither of which this does. What this prevents is a buyer casually
   * collecting originals, not a determined one.
   */
  res.json({
    data: docs.map((doc) => ({
      ...doc.get({ plain: true }),
      can_download: !outsider,
    })),
  });
});

const addDocument = asyncHandler(async (req, res) => {
  const property = await requireProperty(req);
  const doc = await PropertyDocument.create({
    property_id: property.id,
    name: req.body.name,
    url: req.body.url,
    type: req.body.type || 'other',
    size: req.body.size || null,
    public_id: req.body.public_id || null,
    // Opt-in, and only staff can set it — the route is already staff-gated.
    is_shareable: req.body.is_shareable === true || req.body.is_shareable === 'true',
    created_by: req.user?.id,
    company_id: property.company_id,
  });
  res.status(201).json({ data: doc });
});

/**
 * A document by id, bounded to the caller's company.
 *
 * findByPk alone reached across tenants: the id is a plain integer, so deleting
 * another company's title deed was a matter of guessing one. A platform admin
 * has an empty scope and still reaches everything.
 */
const findScopedDocument = (req) => PropertyDocument.findOne({
  where: { id: req.params.id, ...buildCompanyScope(req) },
});

/**
 * Turns sharing on or off for one document.
 *
 * Its own endpoint rather than a general update: this is the only field on a
 * document that changes who can see it, so it is worth being able to read the
 * audit of it as a distinct action.
 */
const setDocumentShareable = asyncHandler(async (req, res) => {
  const doc = await findScopedDocument(req);
  if (!doc) return res.status(404).json({ message: 'Document not found' });
  const shareable = req.body.is_shareable === true || req.body.is_shareable === 'true';
  await doc.update({ is_shareable: shareable });
  res.json({
    data: doc,
    message: shareable
      ? 'Shared. Prospective buyers can now view this document.'
      : 'No longer shared. Only staff can see this document.',
  });
});

const deleteDocument = asyncHandler(async (req, res) => {
  const doc = await findScopedDocument(req);
  if (!doc) return res.status(404).json({ message: 'Document not found' });
  await doc.destroy();
  res.json({ message: 'Document deleted' });
});


// ── Public share link ─────────────────────────────────────────────────────────

// Fields safe to expose to an unauthenticated visitor. Everything omitted here
// (commission, downline_commission, approval_*, created_by, company_id) is
// internal and must never reach the public endpoint.
// No property-level `price`: price lives on each unit configuration, and
// sending both invited them to disagree. Buyers read units[].price.
const PUBLIC_PROPERTY_FIELDS = [
  'id', 'name', 'description', 'type', 'address', 'city', 'state', 'country',
  'latitude', 'longitude', 'status', 'images',
  'unit_id', 'unit_quantity', 'unit_measurement', 'unit_measurement_unit',
  'created_at', 'updated_at',
];

const toPublicPayload = (property, companyCode = null) => {
  const plain = property.get({ plain: true });
  const payload = {};
  for (const field of PUBLIC_PROPERTY_FIELDS) {
    if (plain[field] !== undefined) payload[field] = plain[field];
  }
  // The company's share code. It exists to be handed out for self-registration,
  // and is the authoritative binding for accounts created from this page.
  payload.company_code = companyCode;
  // lowestUnit and plots are deliberately absent: "lowest unit" was retired
  // from property creation, and plots are an admin-side concept with their own
  // screen. Neither was ever rendered for a buyer.
  payload.units = (plain.units || []).map(({ id, name, size, unit, price, status, quantity }) => ({ id, name, size, unit, price, status, quantity }));
  payload.amenities = (plain.amenities || []).map(({ id, name, description }) => ({ id, name, description }));
  return payload;
};


/**
 * Get-or-create THE public link for a property. A property has at most one
 * link, and issuing is idempotent: an existing token is returned untouched so
 * links already shared keep working. Links never expire — any legacy expiry is
 * cleared here so the rule holds uniformly.
 */
const ensurePublicLink = async (property) => {
  if (!property.public_token || !property.public_enabled || property.public_expires_at) {
    await property.update({
      public_token: property.public_token || crypto.randomBytes(24).toString('hex'),
      public_enabled: true,
      public_expires_at: null,
    });
  }
  const codes = await companyCodesByPropertyIds([property.company_id]);
  return { public_token: property.public_token, company_code: codes.get(Number(property.company_id)) || null };
};

const createPublicLink = asyncHandler(async (req, res) => {
  const property = await requireProperty(req);
  const link = await ensurePublicLink(property);
  res.json({ data: { ...link, public_enabled: true, public_expires_at: null } });
});

const revokePublicLink = asyncHandler(async (req, res) => {
  const property = await requireProperty(req);
  await property.update({ public_token: null, public_enabled: false, public_expires_at: null });
  res.json({ message: 'Public link revoked' });
});

const getPublicProperty = asyncHandler(async (req, res) => {
  const token = String(req.params.token || '');
  if (!token) return res.status(404).json({ message: 'Property not found' });

  const property = await Property.findOne({
    where: { public_token: token, public_enabled: true },
    // Only what the public payload serialises — the plots and lowestUnit joins
    // were feeding fields nobody rendered.
    include: [
      { model: PropertyUnits, as: 'units' },
      { model: PropertyAmenity, as: 'amenities' },
    ],
  });

  // Same 404 for "no such token" and "wrong token" so the endpoint cannot be probed.
  if (!property) return res.status(404).json({ message: 'This link is not valid.' });

  // Links issued now never expire; this still honours any legacy expiry.
  if (property.public_expires_at && new Date(property.public_expires_at).getTime() <= Date.now()) {
    return res.status(410).json({ message: 'This link has expired.' });
  }

  const codes = await companyCodesByPropertyIds([property.company_id]);
  res.json({ data: toPublicPayload(property, codes.get(Number(property.company_id)) || null) });
});



// ── Sharing and purchase requests ─────────────────────────────────────────────

/**
 * Get-or-create a public token for an approved, available property.
 *
 * Unlike the admin's public-link endpoint this NEVER rotates the token: realtors
 * and clients share these links onward, and rotating would silently break every
 * link already sent. It also refuses non-listed properties so a share cannot
 * expose a draft or unapproved property.
 */
const getShareLink = asyncHandler(async (req, res) => {
  const scope = listedScope(req);
  if (!scope) return res.status(404).json({ message: 'Property not found' });

  const property = await Property.findOne({ where: { id: req.params.id, ...scope, ...LISTED_WHERE } });
  if (!property) return res.status(404).json({ message: 'Property not found' });

  const link = await ensurePublicLink(property);

  // A realtor's link carries their own code, so a client registering from it is
  // attributed to them as well as to the company.
  if (isRealtor(req)) {
    const [row] = await sequelize.query(
      "SELECT realtor_code FROM users WHERE id = :id AND type = 'realtor' LIMIT 1",
      { replacements: { id: req.user.id }, type: QueryTypes.SELECT },
    );
    link.realtor_code = row?.realtor_code || null;
  }

  res.json({ data: link });
});

/**
 * Records a buyer's intent against a property (and optionally a specific unit
 * configuration). Requires an account — the public page routes anonymous users
 * through registration first.
 */
const createPurchaseRequest = asyncHandler(async (req, res) => {
  const token = String(req.body.token || '');
  if (!token) return res.status(400).json({ message: 'A property share token is required.' });
  const property = await Property.findOne({
    where: { public_token: token, public_enabled: true, ...LISTED_WHERE },
  });
  if (!property) return res.status(404).json({ message: 'This property is no longer available.' });

  if (property.public_expires_at && new Date(property.public_expires_at).getTime() <= Date.now()) {
    return res.status(410).json({ message: 'This link has expired.' });
  }

  if (!isClientBuyer(req)) return res.status(403).json(BUYER_ONLY);

  let unit = null;
  if (req.body.unit_id) {
    unit = await PropertyUnits.findOne({ where: { id: req.body.unit_id, property_id: property.id } });
    if (!unit) return res.status(400).json({ message: 'That unit configuration is not available.' });
  }

  // `Number(0) || 1` would silently coerce 0 to 1, so distinguish "omitted"
  // from "explicitly zero" before validating.
  const rawQuantity = req.body.quantity;
  const omitted = rawQuantity === undefined || rawQuantity === null || rawQuantity === '';
  const quantity = omitted ? 1 : Number(rawQuantity);
  if (!Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ message: 'Quantity must be a whole number of at least 1.' });
  }

  const request = await PurchaseRequest.create({
    property_id: property.id,
    unit_id: unit?.id ?? null,
    user_id: req.user.id,
    buyer_name: req.user.name || null,
    buyer_email: req.user.email || null,
    buyer_phone: req.body.phone || null,
    quantity,
    notes: req.body.notes || null,
    unit_label: unit?.name ?? null,
    unit_price: unit?.price ?? null,
    company_id: property.company_id,
  });

  res.status(201).json({ data: { id: request.id, status: request.status } });
});

/**
 * Which installment plans each of a property's units may be sold on.
 *
 * One call for the whole property, so the configuration screen can render a
 * matrix of units against plans rather than asking per unit. Returns both what
 * IS assigned and what is available to assign, because "no plans" and "no plans
 * configured for this company yet" need different answers on screen.
 *
 * installment_plans and installment_plan_units belong to finance-service. Read
 * directly for the reason invoiceGateway.js states in reverse: defining models
 * for another service's tables here would let this service's
 * sync({ alter: true }) reshape them.
 */
const getPropertyInstallmentPlans = asyncHandler(async (req, res) => {
  const property = await requireProperty(req);

  const units = await PropertyUnits.findAll({
    where: { property_id: property.id },
    order: [['id', 'ASC']],
  });

  // Every plan the owning company could offer. Inactive ones are included but
  // flagged: a unit may already be assigned one, and hiding it would make the
  // assignment look as though it had vanished.
  const available = await sequelize.query(
    `SELECT id, name, duration_months, surcharge_type, surcharge_value, rounding_rule,
            grace_period_days, default_fee_type, default_fee_value, default_fee_recurrence,
            is_active
       FROM installment_plans
      WHERE ${property.company_id ? 'company_id = :companyId' : 'company_id IS NULL'}
      ORDER BY duration_months ASC, id ASC`,
    { replacements: { companyId: property.company_id ?? null }, type: QueryTypes.SELECT },
  );

  const assignments = units.length
    ? await sequelize.query(
      `SELECT property_unit_id, installment_plan_id
         FROM installment_plan_units
        WHERE property_unit_id IN (:unitIds)`,
      { replacements: { unitIds: units.map((unit) => unit.id) }, type: QueryTypes.SELECT },
    )
    : [];

  const byUnit = assignments.reduce((map, row) => {
    const list = map.get(Number(row.property_unit_id)) || [];
    list.push(Number(row.installment_plan_id));
    return map.set(Number(row.property_unit_id), list);
  }, new Map());

  res.json({
    data: {
      property: { id: property.id, name: property.name },
      available_plans: available.map((plan) => ({
        ...plan,
        surcharge_value: Number(plan.surcharge_value) || 0,
        default_fee_value: Number(plan.default_fee_value) || 0,
        is_active: Boolean(plan.is_active),
      })),
      units: units.map((unit) => ({
        id: unit.id,
        name: unit.name,
        price: Number(unit.price) || 0,
        quantity: unit.quantity,
        // A unit with an empty array can only be bought outright.
        installment_plan_ids: byUnit.get(Number(unit.id)) || [],
      })),
    },
  });
});

/** Purchase requests for one property — company-scoped, for staff. */
const listPurchaseRequests = asyncHandler(async (req, res) => {
  const property = await requireProperty(req);
  const requests = await PurchaseRequest.findAll({
    where: { property_id: property.id },
    order: [['id', 'DESC']],
  });
  res.json({ data: requests });
});


/**
 * Remaining quantity per unit configuration = configured quantity minus the
 * inventory actually HELD against it.
 *
 * This reverses what availability used to mean, and it is FRD 10.1: an unpaid
 * invoice does not reduce available quantity. It used to — availability was
 * derived from every non-cancelled purchase request, so merely creating an
 * invoice took units off the market and a buyer who never paid could sit on
 * ten plots indefinitely. FRD 10.1's worked example is exactly that case: 20
 * half plots, a client raises an invoice for 10, and availability must stay
 * at 20 because they have secured nothing.
 *
 * Quantity is now reduced only when an approved payment places a hold, per the
 * company's hold policy (FRD 10.2) — see shared/src/inventoryGateway.js.
 *
 * NOTE for callers: `quantity_available` therefore reads HIGHER than it did
 * before for any unit with unpaid invoices against it. That is the intended
 * change, not a regression.
 */
const availabilityByUnit = async (unitIds, transaction = null) => (
  heldQuantityByUnit(sequelize, unitIds, { transaction })
);

const withAvailability = async (units) => {
  const plainUnits = units.map((unit) => (unit.get ? unit.get({ plain: true }) : unit));
  const held = await availabilityByUnit(plainUnits.map((unit) => unit.id));
  return plainUnits.map((unit) => {
    const total = Number(unit.quantity) || 0;
    return {
      ...unit,
      quantity_available: Math.max(total - (held.get(Number(unit.id)) || 0), 0),
      // Surfaced alongside it so a staff view can tell "nothing sold" from
      // "everything sold" rather than inferring it from the difference.
      quantity_held: held.get(Number(unit.id)) || 0,
    };
  });
};

/**
 * Purchase checkout: validates the unit and quantity against live availability,
 * prices it server-side, then records the request and its invoice in ONE
 * transaction so neither can exist without the other.
 */

/**
 * Announces a purchase.
 *
 * Was a direct message to the buyer's realtor and nobody else, with the
 * recipient decided here. Now a configured event, so a company can also copy
 * whoever tracks sales — and the buyer themselves, which the old version had no
 * way to do.
 */
const announcePurchase = ({ req, property, unit, quantity, amount, invoiceRef, buyerId }) => notify.dispatch({
  eventKey: 'purchase_request_created',
  subjectUserId: buyerId,
  companyId: property.company_id ?? null,
  context: { property, unit },
  title: (role) => (role === 'subject'
    ? `Purchase started — ${property.name}`
    : 'A purchase has been started'),
  body: (role, ctx) => {
    const line = `${quantity} x ${unit.name} on ${property.name}, invoice ${invoiceRef} `
      + `for ${Number(amount).toLocaleString()}.`;
    if (role === 'subject') return `You have started a purchase of ${line}`;
    const who = ctx.subject?.name || 'A client';
    return role === 'realtor'
      ? `Your client ${who} has started a purchase of ${line}`
      : `${who} has started a purchase of ${line}`;
  },
  data: { property_id: property.id, invoice_ref: invoiceRef, amount },
  actionLabel: 'View property',
  actionUrl: appUrl(`properties/listed/${property.id}`, req),
});

const checkoutPurchase = asyncHandler(async (req, res) => {
  const scope = listedScope(req);
  if (!scope) return res.status(404).json({ message: 'Property not found' });

  const property = await Property.findOne({ where: { id: req.params.id, ...scope, ...LISTED_WHERE } });
  if (!property) return res.status(404).json({ message: 'Property not found' });

  // Hiding the button is not enforcement. Strictly client-only — staff and
  // realtors alike are blocked. Checked against the ACTIVE profile, so a realtor
  // who switches to their client profile may buy.
  if (!isClientBuyer(req)) return res.status(403).json(BUYER_ONLY);

  // `payment_type` is the FRD 2 term; `payment_mode` is what the existing
  // clients send. Both accepted so the older callers keep working.
  const paymentType = String(req.body.payment_type || req.body.payment_mode || 'outright').toLowerCase();
  if (!['outright', 'installment'].includes(paymentType)) {
    return res.status(400).json({ message: 'Payment type must be outright or installment.' });
  }

  // Guard before querying: a missing unit_id would otherwise throw in Sequelize
  // rather than returning a clean validation error.
  if (!req.body.unit_id) return res.status(400).json({ message: 'Select a unit configuration to purchase.' });
  const unit = await PropertyUnits.findOne({ where: { id: req.body.unit_id, property_id: property.id } });
  if (!unit) return res.status(400).json({ message: 'That unit configuration is not available.' });

  const rawQuantity = req.body.quantity;
  const quantity = rawQuantity === undefined || rawQuantity === null || rawQuantity === '' ? 1 : Number(rawQuantity);
  if (!Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ message: 'Quantity must be a whole number of at least 1.' });
  }

  /**
   * There used to be a check here that rejected the purchase outright if the
   * buyer had ANY unpaid invoice on this property, and it has been removed.
   *
   * Two reasons, both from the FRD. It contradicted FRD 10.3 directly, whose
   * worked example requires Client A to go on holding an open unpaid invoice
   * while Client B pays. And it made installments unbuyable in principle: an
   * installment invoice is unpaid by definition for the length of its plan, so
   * the first one a client raised would have blocked every subsequent purchase
   * on that property for six months.
   *
   * What replaced it is FRD 10.1 — an unpaid invoice holds no inventory — so
   * multiple open invoices are no longer a way to sit on stock, which is what
   * the check was really guarding against.
   */

  const transaction = await sequelize.transaction();
  try {
    /**
     * Availability is checked but NOT reserved (FRD 10.1).
     *
     * The check is here so a buyer is not walked through a purchase of
     * something that has already sold out, but creating this invoice takes
     * nothing off the market — that happens when an approved payment places a
     * hold (FRD 10.2). Two buyers CAN both raise an invoice for the last 10
     * units, and FRD 10.3 is how that resolves: whoever pays first holds them,
     * and the other is notified rather than pre-emptively blocked.
     */
    const state = await availabilityFor(sequelize, unit.id, { transaction });
    if (!state) {
      await transaction.rollback();
      return res.status(400).json({ message: 'That unit configuration is not available.' });
    }
    if (quantity > state.available) {
      await transaction.rollback();
      return res.status(409).json({
        message: state.available === 0
          ? `"${unit.name}" is fully subscribed.`
          : `Only ${state.available} unit${state.available === 1 ? '' : 's'} of "${unit.name}" remain.`,
        quantity_available: state.available,
      });
    }

    // Payment terms are the selling company's to set. Falls back to the
    // platform value, then to the long-standing 30/14 defaults.
    const dueDays = await invoiceDueDays(sequelize, property.company_id, paymentType);
    const dueDate = new Date(Date.now() + dueDays * 24 * 60 * 60 * 1000);

    /**
     * The authoritative price (FRD 4).
     *
     * Computed from the unit's own price and the plan's own terms, inside the
     * transaction. Nothing the client sent about money is read — there is no
     * client-supplied total to override, which is a stronger guarantee than
     * recomputing one and comparing. This also rejects a plan that is inactive
     * or not assigned to this unit (FRD 3.2), so a buyer cannot post the id of
     * a cheaper plan configured for a different unit.
     */
    const { priced } = await priceForPurchase(sequelize, {
      propertyUnitId: unit.id,
      unitPrice: unit.price,
      quantity,
      paymentType,
      installmentPlanId: req.body.installment_plan_id ?? null,
    }, transaction);

    const invoice = await createInvoiceForPurchase(sequelize, transaction, {
      clientId: req.user.id,
      propertyId: property.id,
      // The older DECIMAL column, from the integer calculation.
      amount: toMajor(priced.totalMinor),
      companyId: property.company_id,
      createdBy: req.user.id,
      dueDays,
    });

    /**
     * The payment plan and its schedules, in the SAME transaction as the
     * invoice.
     *
     * An invoice whose schedules failed to write would show a client a total
     * with nothing to pay against, and — because every balance in the journey
     * is derived from the schedules — would read as fully paid.
     */
    const { paymentPlanId, schedules } = await createPaymentPlan(sequelize, transaction, {
      invoiceId: invoice.id,
      propertyUnitId: unit.id,
      quantity,
      paymentType,
      installmentPlanId: req.body.installment_plan_id ?? null,
      unitPrice: unit.price,
      companyId: property.company_id,
      createdBy: req.user.id,
      invoiceDate: new Date(),
      outrightDueDate: dueDate,
    });

    const request = await PurchaseRequest.create({
      property_id: property.id,
      unit_id: unit.id,
      user_id: req.user.id,
      buyer_name: req.user.name || null,
      buyer_email: req.user.email || null,
      buyer_phone: req.body.phone || null,
      quantity,
      payment_mode: paymentType,
      amount: toMajor(priced.totalMinor),
      invoice_id: invoice.id,
      invoice_ref: invoice.invoice_id,
      notes: req.body.notes || null,
      unit_label: unit.name,
      unit_price: unit.price,
      company_id: property.company_id,
    }, { transaction });

    await transaction.commit();

    announcePurchase({
      req,
      property,
      unit,
      quantity,
      amount: toMajor(priced.totalMinor),
      invoiceRef: invoice.invoice_id,
      buyerId: req.user.id,
    }).catch(() => {});

    /**
     * The response carries everything the payment page needs.
     *
     * FRD 5's defect is that after creating an invoice the client was returned
     * to the home screen and had to find the invoice again to pay it. Both
     * branches of the new flow create an identical invoice and differ only in
     * where the client lands, so the decision is the caller's — and returning
     * the invoice id and its schedule set here is what lets "Proceed to
     * Payment" go straight to the payment page with nothing further to fetch.
     */
    res.status(201).json({
      data: {
        purchase_request_id: request.id,
        invoice_id: invoice.id,
        invoice_ref: invoice.invoice_id,
        payment_plan_id: paymentPlanId,
        payment_type: priced.paymentType,
        amount: toMajor(priced.totalMinor),
        // Broken out so the confirmation can state the plan charge explicitly
        // (FRD 4.1) rather than only the total.
        pricing: {
          base: toMajor(priced.baseMinor),
          surcharge: toMajor(priced.surchargeMinor),
          total: toMajor(priced.totalMinor),
          duration_months: priced.durationMonths,
          monthly: toMajor(priced.perMonthMinor),
          final_month: toMajor(priced.finalMonthMinor),
        },
        schedules: schedules.map((schedule) => ({
          sequence: schedule.sequence,
          due_date: schedule.due_date.toISOString().slice(0, 10),
          amount: toMajor(schedule.principal_minor),
        })),
        // Where the UI should send the client for the "Proceed to Payment"
        // branch. Kept server-side so the two repos cannot disagree on it.
        payment_url: `finance/invoices/${invoice.id}`,
      },
    });
  } catch (error) {
    // Guard: rolling back an already-finished transaction throws and would mask
    // the real error.
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }
});

// ── Excel export / bulk import ────────────────────────────────────────────────

const MAX_IMPORT_ROWS = 500;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const styleHeader = (sheet) => {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  header.alignment = { vertical: 'middle' };
  header.height = 20;
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
};

/** Restrict a column to a dropdown of allowed values for the whole usable range. */
const addDropdown = (sheet, columnKey, values, columns) => {
  const index = columns.findIndex((column) => column.key === columnKey);
  if (index === -1) return;
  const letter = sheet.getColumn(index + 1).letter;
  for (let row = 2; row <= 200; row += 1) {
    sheet.getCell(`${letter}${row}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [`"${values.join(',')}"`],
    };
  }
};

const sendWorkbook = async (res, workbook, filename) => {
  res.setHeader('Content-Type', XLSX_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // The browser needs this exposed or it cannot read the header cross-origin.
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  await workbook.xlsx.write(res);
  res.end();
};

const exportProperties = asyncHandler(async (req, res) => {
  const isSuperiorAdmin = req.user?.isSuperiorAdmin === true;
  const columns = exportColumns(isSuperiorAdmin);

  const properties = await Property.findAll({
    where: companyScope(req),
    order: [['id', 'DESC']],
  });

  // Superior admins see which company each property belongs to, by code.
  const codeById = isSuperiorAdmin
    ? await companyCodesByPropertyIds(properties.map((p) => p.company_id))
    : new Map();

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Properties');
  sheet.columns = columns.map(({ header, key, width }) => ({ header, key, width }));
  styleHeader(sheet);

  properties.forEach((property) => {
    const plain = property.get({ plain: true });
    const row = {};
    columns.forEach(({ key }) => {
      if (key === 'company_code') {
        row[key] = codeById.get(Number(plain.company_id)) || '';
        return;
      }
      const value = plain[key] ?? plain[key === 'created_at' ? 'createdAt' : key];
      if (key === 'price') {
        // Keep it a real number so Excel can sum it; formatting is applied below.
        row[key] = value === null || value === undefined ? 0 : Number(value);
        return;
      }
      row[key] = value instanceof Date ? value.toISOString() : value ?? '';
    });
    sheet.addRow(row);
  });

  // Thousands-separated and tagged with the currency code, matching the app.
  const priceIndex = columns.findIndex((column) => column.key === 'price');
  if (priceIndex !== -1) {
    // Prefer the currency sign; fall back to the ISO code. Quotes and semicolons
    // are stripped so the value cannot break out of the number-format string.
    const code = String(req.query.currency || 'USD').replace(/[^A-Za-z]/g, '').toUpperCase() || 'USD';
    const sign = String(req.query.currency_symbol || '').replace(/["'`;\\]/g, '').slice(0, 4) || code;
    sheet.getColumn(priceIndex + 1).numFmt = `"${sign}" #,##0.00`;
  }

  await sendWorkbook(res, workbook, `properties-${new Date().toISOString().slice(0, 10)}.xlsx`);
});

const bulkTemplate = asyncHandler(async (req, res) => {
  const isSuperiorAdmin = req.user?.isSuperiorAdmin === true;
  const columns = importColumns(isSuperiorAdmin);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Properties');
  sheet.columns = columns.map(({ header, key, width }) => ({ header, key, width }));
  styleHeader(sheet);

  // One filled example row so the expected format is unambiguous.
  const example = {};
  columns.forEach(({ key, example: value }) => { example[key] = value ?? ''; });
  sheet.addRow(example);

  addDropdown(sheet, 'status', STATUSES, columns);
  addDropdown(sheet, 'unit_measurement_unit', MEASUREMENT_UNITS, columns);

  // Second sheet documents the rules rather than cluttering the header row.
  const guide = workbook.addWorksheet('Instructions');
  guide.columns = [{ header: 'Column', key: 'column', width: 22 }, { header: 'Notes', key: 'notes', width: 78 }];
  styleHeader(guide);
  const notes = [
    ['Name', 'Required. The property name.'],
    ['Type', 'Free text, e.g. Land, Duplex, Apartment.'],
    ['Latitude', 'Optional. Decimal degrees between -90 and 90.'],
    ['Longitude', 'Optional. Decimal degrees between -180 and 180.'],
    ['Price', 'Optional. Numbers only — no currency symbols or thousands separators.'],
    ['Status', `One of: ${STATUSES.join(', ')}. Defaults to draft.`],
    ['Unit Name', 'Optional label for the unit configuration this row creates, e.g. "Standard Plot".'],
    ['Property Size', 'Optional. Size of ONE unit, numbers only.'],
    ['Measured In', `One of: ${MEASUREMENT_UNITS.join(', ')}. Defaults to sqm.`],
    ['Quantity', 'Optional. Whole number of units making up the property.'],
  ];
  if (isSuperiorAdmin) {
    notes.push(['Company Code', "Required. The company's 5-character code — see the Companies sheet."]);
  }
  notes.push(['—', 'Delete the example row before uploading.']);
  notes.push(['—', `A single upload may contain at most ${MAX_IMPORT_ROWS} properties.`]);
  notes.push(['—', 'If any row is invalid nothing is imported — fix the reported rows and re-upload.']);
  notes.forEach(([column, note]) => guide.addRow({ column, notes: note }));

  // Superior admins need the codes to hand while filling the sheet.
  if (isSuperiorAdmin) {
    const companies = await listCompanyCodes();
    const reference = workbook.addWorksheet('Companies');
    reference.columns = [
      { header: 'Company Code', key: 'referral_code', width: 16 },
      { header: 'Company Name', key: 'name', width: 36 },
      { header: 'Status', key: 'status', width: 14 },
    ];
    styleHeader(reference);
    companies.forEach((company) => reference.addRow(company));
  }

  await sendWorkbook(res, workbook, 'property-bulk-upload-template.xlsx');
});

const bulkImport = asyncHandler(async (req, res) => {
  if (!req.file?.buffer?.length) {
    return res.status(400).json({ message: 'No spreadsheet was uploaded.' });
  }

  const isSuperiorAdmin = req.user?.isSuperiorAdmin === true;
  const columns = importColumns(isSuperiorAdmin);

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(req.file.buffer);
  } catch {
    return res.status(400).json({ message: 'That file could not be read as an Excel (.xlsx) workbook.' });
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) return res.status(400).json({ message: 'The workbook has no sheets.' });

  // Map the sheet's header row onto our column keys so column order does not matter.
  const headerRow = sheet.getRow(1);
  const keyByColumn = new Map();
  headerRow.eachCell((cell, colNumber) => {
    const header = String(cellValue(cell) ?? '').trim().toLowerCase();
    const column = columns.find((c) => c.header.toLowerCase() === header);
    if (column) keyByColumn.set(colNumber, column.key);
  });

  const missing = columns
    .filter((column) => column.required && ![...keyByColumn.values()].includes(column.key))
    .map((column) => column.header);
  if (missing.length) {
    return res.status(400).json({
      message: `The sheet is missing required column(s): ${missing.join(', ')}. Download a fresh template.`,
    });
  }

  const payloads = [];
  const errors = [];

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const values = {};
    keyByColumn.forEach((key, colNumber) => { values[key] = cellValue(row.getCell(colNumber)); });

    // Skip rows that are entirely blank — trailing empties are common in Excel.
    const isBlank = Object.values(values).every((v) => v === null || v === undefined || String(v).trim() === '');
    if (isBlank) continue;

    if (payloads.length >= MAX_IMPORT_ROWS) {
      return res.status(400).json({
        message: `This upload exceeds the ${MAX_IMPORT_ROWS} property limit. Split the sheet and upload again.`,
      });
    }

    const { payload, errors: rowErrors } = rowToProperty(values, {
      isSuperiorAdmin,
      companyId: req.user?.company_id ?? null,
    });

    if (rowErrors.length) errors.push({ row: rowNumber, errors: rowErrors });
    else payloads.push({ row: rowNumber, payload: { ...payload, created_by: req.user?.id ?? null, approval_status: 'pending_review' } });
  }

  // Resolve every company code in one query, then attribute unknown codes to their rows.
  if (isSuperiorAdmin && payloads.length) {
    const codeMap = await resolveCompanyCodes(payloads.map((entry) => entry.payload.company_code));
    for (let i = payloads.length - 1; i >= 0; i -= 1) {
      const entry = payloads[i];
      const code = entry.payload.company_code;
      const company = codeMap.get(code);
      if (!company) {
        errors.push({ row: entry.row, errors: [`No company found with code "${code}"`] });
        payloads.splice(i, 1);
      } else {
        entry.payload.company_id = company.id;
        delete entry.payload.company_code;
      }
    }
    errors.sort((a, b) => a.row - b.row);
  }

  if (!payloads.length && !errors.length) {
    return res.status(400).json({ message: 'The sheet has no data rows.' });
  }

  // All-or-nothing: a partial import would silently duplicate rows on re-upload,
  // since properties have no natural unique key to reconcile against.
  if (errors.length) {
    return res.status(422).json({
      message: `${errors.length} row(s) could not be imported. Nothing was saved — fix them and upload again.`,
      created: 0,
      errors,
    });
  }

  const transaction = await sequelize.transaction();
  try {
    const created = await Property.bulkCreate(
      payloads.map(({ payload }) => { const { unit_name, ...rest } = payload; return rest; }),
      { transaction, validate: true },
    );

    // Each imported row also becomes that property's single unit configuration,
    // since price and size now live on the unit rather than the property.
    await PropertyUnits.bulkCreate(created.map((property, index) => {
      const source = payloads[index].payload;
      return buildUnitPayload({
        name: source.unit_name,
        size: source.unit_measurement,
        unit: source.unit_measurement_unit,
        price: source.price,
        quantity: source.unit_quantity,
        status: source.status === 'available' ? 'available' : source.status,
      }, property.id);
    }), { transaction, validate: true });

    await transaction.commit();
    res.status(201).json({ message: `Imported ${created.length} propert${created.length === 1 ? 'y' : 'ies'}.`, created: created.length, errors: [] });
  } catch (error) {
    await transaction.rollback();
    res.status(400).json({ message: error?.errors?.[0]?.message || error.message || 'Import failed.', created: 0, errors: [] });
  }
});


// ── Listed properties (read-only catalogue for realtors and clients) ──────────

/**
 * Company scope for the read-only catalogue.
 *
 * buildCompanyScope returns {} for a user with no company_id, which on a
 * catalogue endpoint would mean "every company's properties". Clients can
 * legitimately have a null company_id, so this fails closed instead.
 * Returns null when the caller may see nothing at all.
 */
const listedScope = (req) => {
  if (req.user?.isSuperiorAdmin) return buildCompanyScope(req);
  const companyId = req.user?.company_id;
  if (!companyId) return null;
  return { company_id: companyId };
};

// Only approved, still-available stock is browsable.
const LISTED_WHERE = { approval_status: 'approved', status: 'available' };

const listListedProperties = asyncHandler(async (req, res) => {
  const scope = listedScope(req);
  if (!scope) {
    return res.json({ data: [], pagination: { page: 1, limit: 12, total: 0, totalPages: 1 } });
  }

  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 12), 1), 50);
  const search = String(req.query.search || '').trim();

  const where = { ...scope, ...LISTED_WHERE };
  if (search) {
    // likeOperator, not Op.like — Postgres LIKE is case-sensitive and MySQL's
    // is not, so a buyer searching "lekki" found "Lekki Court" in development
    // and nothing in production.
    const like = likeOperator(Property.sequelize);
    where[Op.or] = ['name', 'city', 'state', 'country', 'type']
      .map((field) => ({ [field]: { [like]: `%${search}%` } }));
  }

  const result = await Property.findAndCountAll({
    where,
    include: [{ model: PropertyUnits, as: 'units' }],
    // distinct: without it, findAndCountAll counts JOINED rows — a property
    // with two unit configurations counted twice, so `total` exceeded the real
    // number of properties and the UI offered pages that came back empty.
    distinct: true,
    limit,
    offset: (page - 1) * limit,
    order: [['id', 'DESC']],
  });

  res.json({
    // Explicit arrow: .map passes (item, index), which would land the index in companyCode.
    data: result.rows.map((row) => toPublicPayload(row)),
    pagination: { page, limit, total: result.count, totalPages: Math.ceil(result.count / limit) || 1 },
  });
});

const getListedProperty = asyncHandler(async (req, res) => {
  const scope = listedScope(req);
  if (!scope) return res.status(404).json({ message: 'Property not found' });

  const property = await Property.findOne({
    where: { id: req.params.id, ...scope, ...LISTED_WHERE },
    // Only what the public payload serialises — the plots and lowestUnit joins
    // were feeding fields nobody rendered.
    include: [
      { model: PropertyUnits, as: 'units' },
      { model: PropertyAmenity, as: 'amenities' },
    ],
  });

  if (!property) return res.status(404).json({ message: 'Property not found' });
  const payload = toPublicPayload(property);
  payload.units = await withAvailability(property.units || []);
  res.json({ data: payload });
});

module.exports = {
  propertyCrud,
  typeCrud,
  unitCrud,
  inspectionCrud,
  getUnits,
  getPlots,
  getAmenities,
  addAmenity,
  confirmInspection,
  getMyClients,
  getSelectableLeads,
  approveInspection,
  rejectInspection,
  cancelInspection,
  completeInspection,
  submitProperty,
  approveProperty,
  rejectProperty,
  requestRevision,
  getDocuments,
  addDocument,
  setDocumentShareable,
  deleteDocument,
  createPublicLink,
  revokePublicLink,
  getPublicProperty,
  addPropertyUnit,
  updatePropertyUnit,
  deletePropertyUnit,
  exportProperties,
  bulkTemplate,
  bulkImport,
  listListedProperties,
  getShareLink,
  createPurchaseRequest,
  listPurchaseRequests,
  checkoutPurchase,
  getPropertyInstallmentPlans,
  getListedProperty,
};

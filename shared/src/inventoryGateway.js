const { QueryTypes } = require('sequelize');

/**
 * Inventory availability and holds (FRD 10).
 *
 * Shared raw SQL for the same reason paymentPlanGateway.js is: the two services
 * on either side of a hold cannot each own it.
 *
 *   property-service  owns property_units and property_unit_holds, and reads
 *                     availability for every unit listing.
 *   finance-service   decides when a hold is triggered, because that depends on
 *                     approved payments — and must do it inside the approval
 *                     transaction (FRD 7.3).
 *
 * The rule these functions implement, and the reversal at the heart of FRD 10:
 * an unpaid invoice holds NOTHING. Availability is the configured quantity less
 * the holds actually placed, and a hold is placed only once an approved payment
 * meets the company's policy.
 */

/**
 * Units held on a unit right now.
 *
 * Counts unreleased holds only. A released hold — a cancelled invoice — puts
 * its units straight back on the market.
 */
const heldQuantity = async (sequelize, propertyUnitId, { transaction = null, lock = false } = {}) => {
  const rows = await sequelize.query(
    `SELECT COALESCE(SUM(quantity), 0) AS held
       FROM property_unit_holds
      WHERE property_unit_id = :unitId AND released_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    { replacements: { unitId: propertyUnitId }, type: QueryTypes.SELECT, transaction },
  );
  return Number(rows[0]?.held) || 0;
};

/**
 * Held quantity for many units at once, as a Map.
 *
 * The unit list endpoints render every unit of a property, and one query per
 * unit turns a 12-unit property into 12 round trips.
 */
const heldQuantityByUnit = async (sequelize, propertyUnitIds, { transaction = null } = {}) => {
  const ids = (propertyUnitIds || []).map(Number).filter(Number.isInteger);
  if (!ids.length) return new Map();

  const rows = await sequelize.query(
    `SELECT property_unit_id, COALESCE(SUM(quantity), 0) AS held
       FROM property_unit_holds
      WHERE property_unit_id IN (:ids) AND released_at IS NULL
      GROUP BY property_unit_id`,
    { replacements: { ids }, type: QueryTypes.SELECT, transaction },
  );
  return new Map(rows.map((row) => [Number(row.property_unit_id), Number(row.held) || 0]));
};

/**
 * Availability for one unit, optionally under a lock.
 *
 * `lock: true` takes a row lock on the unit and its holds, which is what makes
 * the oversell check at approval time (FRD 10.4) safe against two admins
 * approving payments for the last units at once.
 */
const availabilityFor = async (sequelize, propertyUnitId, { transaction = null, lock = false } = {}) => {
  const units = await sequelize.query(
    `SELECT id, property_id, name, price, quantity
       FROM property_units WHERE id = :unitId LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    { replacements: { unitId: propertyUnitId }, type: QueryTypes.SELECT, transaction },
  );
  const unit = units[0];
  if (!unit) return null;

  const held = await heldQuantity(sequelize, propertyUnitId, { transaction, lock });
  const total = Number(unit.quantity) || 0;
  return {
    unit,
    total,
    held,
    // Clamped at zero: a unit whose configured quantity an admin later REDUCED
    // below what is already held would otherwise report a negative figure to
    // the UI, and negative availability is not a state FRD 10.4 allows to be
    // displayed any more than to be created.
    available: Math.max(total - held, 0),
  };
};

/**
 * Places the hold for an invoice (FRD 10.2), re-checking availability under the
 * lock the caller must already hold (FRD 10.4).
 *
 * Covers the ENTIRE invoiced quantity, not a pro-rata share of what has been
 * paid. Returns { held: false, reason } rather than throwing when the hold
 * cannot be placed, so the caller can surface the conflict to the admin and
 * abort the approval deliberately.
 *
 * Idempotent: an invoice that already holds its units returns
 * { held: true, existing: true } and places nothing further, which is what
 * makes a second approved payment on the same invoice safe.
 */
const placeHold = async (sequelize, transaction, {
  invoiceId, propertyUnitId, propertyId, clientId, quantity,
  triggerPolicy, triggeredByPaymentId = null, cumulativePaidMinor = 0, companyId = null,
}) => {
  const existing = await sequelize.query(
    'SELECT id, quantity FROM property_unit_holds WHERE invoice_id = :invoiceId LIMIT 1 FOR UPDATE',
    { replacements: { invoiceId }, type: QueryTypes.SELECT, transaction },
  );
  if (existing.length && existing[0].id) {
    // Re-holding after a release would need a new decision about availability,
    // so a released hold is not silently revived here.
    const active = await sequelize.query(
      'SELECT id FROM property_unit_holds WHERE invoice_id = :invoiceId AND released_at IS NULL LIMIT 1',
      { replacements: { invoiceId }, type: QueryTypes.SELECT, transaction },
    );
    if (active.length) return { held: true, existing: true, holdId: active[0].id };
  }

  const state = await availabilityFor(sequelize, propertyUnitId, { transaction, lock: true });
  if (!state) return { held: false, reason: 'unit_missing', available: 0 };

  const wanted = Math.trunc(Number(quantity)) || 0;
  if (wanted < 1) return { held: false, reason: 'invalid_quantity', available: state.available };

  // FRD 10.4: availability must never go negative. Blocking the approval and
  // surfacing the conflict is the specified behaviour — the alternative, a
  // partial hold, would tell a client who paid in full that they secured less
  // than they bought.
  if (wanted > state.available) {
    return { held: false, reason: 'insufficient_availability', available: state.available, wanted };
  }

  await sequelize.query(
    `INSERT INTO property_unit_holds
       (property_unit_id, property_id, invoice_id, client_id, quantity,
        trigger_policy, triggered_by_payment_id, cumulative_paid_minor,
        company_id, created_at, updated_at)
     VALUES
       (:propertyUnitId, :propertyId, :invoiceId, :clientId, :quantity,
        :triggerPolicy, :paymentId, :cumulativePaid,
        :companyId, NOW(), NOW())`,
    {
      replacements: {
        propertyUnitId,
        propertyId: propertyId ?? state.unit.property_id,
        invoiceId,
        clientId: clientId ?? null,
        quantity: wanted,
        triggerPolicy,
        paymentId: triggeredByPaymentId,
        cumulativePaid: cumulativePaidMinor,
        companyId,
      },
      type: QueryTypes.INSERT,
      transaction,
    },
  );

  return {
    held: true,
    existing: false,
    quantity: wanted,
    availableAfter: state.available - wanted,
  };
};

/** Releases an invoice's hold — cancellation, expiry, or a quantity edit. */
const releaseHold = async (sequelize, { invoiceId, reason = null, transaction = null }) => {
  const [, affected] = await sequelize.query(
    `UPDATE property_unit_holds
        SET released_at = NOW(), release_reason = :reason, updated_at = NOW()
      WHERE invoice_id = :invoiceId AND released_at IS NULL`,
    { replacements: { invoiceId, reason }, type: QueryTypes.UPDATE, transaction },
  );
  return affected ?? 0;
};

/**
 * Open invoices on a unit that can no longer be fulfilled in full (FRD 10.3).
 *
 * Called after a hold is placed, to find whose invoice the newly reduced
 * availability has undercut. These invoices are NOT cancelled — FRD 10.3 is
 * explicit that they stay open pending client or admin action, and the point of
 * the notification is to let the client and their realtor decide.
 *
 * `excludeInvoiceId` is the invoice that just paid: it holds its units and is
 * not in contention with itself.
 */
const findContendedInvoices = async (sequelize, {
  propertyUnitId, available, excludeInvoiceId = null, transaction = null,
}) => sequelize.query(
  `SELECT i.id, i.invoice_id, i.client_id, i.company_id, i.status,
          ipp.quantity, ipp.total_minor,
          pu.name AS unit_name, p.name AS property_name, p.id AS property_id,
          u.name AS client_name, u.email AS client_email
     FROM invoice_payment_plans ipp
     JOIN invoices i ON i.id = ipp.invoice_id
     JOIN property_units pu ON pu.id = ipp.property_unit_id
     JOIN properties p ON p.id = pu.property_id
     LEFT JOIN users u ON u.id = i.client_id
    WHERE ipp.property_unit_id = :unitId
      -- Only invoices that hold nothing yet. An invoice with its own hold has
      -- already secured its units and is not affected by what is left.
      AND NOT EXISTS (
        SELECT 1 FROM property_unit_holds h
         WHERE h.invoice_id = i.id AND h.released_at IS NULL
      )
      AND i.status IN ('sent', 'payment_under_review', 'partially_paid')
      ${excludeInvoiceId ? 'AND i.id <> :excludeInvoiceId' : ''}
      -- The invoice asks for more than is now left. An invoice for 3 units with
      -- 5 remaining is still fulfillable and its owner does not need telling.
      AND ipp.quantity > :available`,
  {
    replacements: { unitId: propertyUnitId, available, excludeInvoiceId },
    type: QueryTypes.SELECT,
    transaction,
  },
);

module.exports = {
  heldQuantity,
  heldQuantityByUnit,
  availabilityFor,
  placeHold,
  releaseHold,
  findContendedInvoices,
};

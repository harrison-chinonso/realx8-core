const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { buildCompanyScope } = require('../utils/crudFactory');
const { sequelize, Invoice, ScheduleFeeApplication } = require('../models');
const { asMinor, toMajor } = require('../../../../shared/src/money');
const { readPaymentPlan, regeneratePaymentPlan } = require('../../../../shared/src/paymentPlanGateway');
const { releaseHold, availabilityFor } = require('../../../../shared/src/inventoryGateway');
const { createPurchaseNotifier } = require('../../../../shared/src/purchaseNotifications');
const { appUrl } = require('../../../../shared/src/appOrigin');

const purchaseNotifier = createPurchaseNotifier(sequelize);
const companyScope = (req) => buildCompanyScope(req);

/**
 * Admin actions on an invoice's payment plan: editing quantity (FRD 6.1),
 * cancelling, waiving an applied default fee (FRD 15.5), and the queue of
 * overpayments waiting to be dealt with (FRD 8.2).
 */

/**
 * Has any money been approved against this invoice?
 *
 * The question every destructive action here turns on. Asked of the
 * ALLOCATIONS rather than of the invoice status, because status is derived and
 * a stale one would let a regeneration delete schedules that transactions point
 * at — which is how the ledger becomes unreconcilable.
 */
const hasApprovedPayments = async (invoiceId, transaction = null) => {
  const rows = await sequelize.query(
    `SELECT COUNT(*) AS n FROM payment_allocations WHERE invoice_id = :invoiceId`,
    { replacements: { invoiceId }, type: QueryTypes.SELECT, transaction },
  );
  if (Number(rows[0]?.n) > 0) return true;
  // Legacy invoices have payments but no allocations.
  const payments = await sequelize.query(
    `SELECT COUNT(*) AS n FROM invoice_payments
      WHERE invoice_id = :invoiceId AND status = 'completed'`,
    { replacements: { invoiceId }, type: QueryTypes.SELECT, transaction },
  );
  return Number(payments[0]?.n) > 0;
};

/** The schedule table for one invoice, with both status dimensions (FRD 9.2). */
const getInvoiceSchedules = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findOne({ where: { id: req.params.id, ...companyScope(req) } });
  if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

  const loaded = await readPaymentPlan(sequelize, invoice.id);
  if (!loaded) return res.json({ data: { payment_plan: null, schedules: [] } });

  const fees = await ScheduleFeeApplication.findAll({
    where: { invoice_id: invoice.id },
    order: [['payment_schedule_id', 'ASC'], ['period_index', 'ASC']],
  });
  const feesBySchedule = fees.reduce((map, fee) => {
    const list = map.get(fee.payment_schedule_id) || [];
    list.push(fee);
    return map.set(fee.payment_schedule_id, list);
  }, new Map());

  res.json({
    data: {
      payment_plan: {
        id: loaded.plan.id,
        payment_type: loaded.plan.payment_type,
        plan_name: loaded.plan.snapshot_plan_name,
        status: loaded.plan.status,
        quantity: loaded.plan.quantity,
        total: toMajor(asMinor(loaded.plan.total_minor)),
        credit_balance: toMajor(asMinor(loaded.plan.credit_balance_minor)),
      },
      schedules: loaded.schedules.map((schedule) => ({
        id: schedule.id,
        sequence: schedule.sequence,
        due_date: schedule.due_date,
        principal: toMajor(asMinor(schedule.principal_minor)),
        principal_outstanding: toMajor(asMinor(schedule.principal_outstanding_minor)),
        fee_accrued: toMajor(asMinor(schedule.fee_accrued_minor)),
        fee_outstanding: toMajor(asMinor(schedule.fee_outstanding_minor)),
        payable: toMajor(asMinor(schedule.principal_outstanding_minor) + asMinor(schedule.fee_outstanding_minor)),
        timing_status: schedule.timing_status,
        settlement_status: schedule.settlement_status,
        settled_at: schedule.settled_at,
        // Each fee application, so an overdue schedule can show WHY it owes
        // more than it was for (FRD 12.3) and which charges were waived.
        fees: (feesBySchedule.get(schedule.id) || []).map((fee) => ({
          period_index: fee.period_index,
          amount: toMajor(asMinor(fee.amount_minor)),
          applied_at: fee.applied_at,
          waived_at: fee.waived_at,
          waive_reason: fee.waive_reason,
        })),
      })),
    },
  });
});

/**
 * Line-level allocation history for one invoice (FRD 8.4).
 *
 * Which transaction contributed how much to which schedule, split between fee
 * and principal. This is the endpoint a dispute is settled from.
 */
const getInvoiceAllocations = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findOne({ where: { id: req.params.id, ...companyScope(req) } });
  if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

  const rows = await sequelize.query(
    `SELECT pa.id, pa.invoice_payment_id, pa.payment_schedule_id,
            pa.principal_minor, pa.fee_minor, pa.created_at, pa.created_by,
            ps.sequence, ps.due_date,
            ip.amount AS payment_amount, ip.payment_method, ip.transaction_id AS reference,
            ip.created_at AS payment_date
       FROM payment_allocations pa
       JOIN payment_schedules ps ON ps.id = pa.payment_schedule_id
       JOIN invoice_payments ip ON ip.id = pa.invoice_payment_id
      WHERE pa.invoice_id = :invoiceId
      ORDER BY pa.id ASC`,
    { replacements: { invoiceId: invoice.id }, type: QueryTypes.SELECT },
  );

  res.json({
    data: rows.map((row) => ({
      id: row.id,
      payment_id: row.invoice_payment_id,
      payment_amount: Number(row.payment_amount) || 0,
      payment_method: row.payment_method,
      reference: row.reference,
      payment_date: row.payment_date,
      schedule_id: row.payment_schedule_id,
      sequence: row.sequence,
      due_date: row.due_date,
      principal: toMajor(asMinor(row.principal_minor)),
      fee: toMajor(asMinor(row.fee_minor)),
      allocated_at: row.created_at,
    })),
  });
});

/**
 * An admin edits an unpaid invoice's quantity (FRD 6.1).
 *
 * Every derived value recalculates — base, surcharge, total — and for an
 * installment invoice the FULL schedule set is regenerated. Repriced from the
 * plan's SNAPSHOT, so the quantity changes and the agreed terms do not, even if
 * the template has been edited since (FRD 3.3).
 *
 * Not permitted once an approved payment exists: FRD 6.1 says cancel and
 * reissue instead. The reason is not policy but arithmetic — regenerating would
 * delete schedules that allocation lines reference, and the money already taken
 * would no longer point at anything.
 *
 * This is also the primary resolution path for FRD 10.3 contention: reducing a
 * contended invoice to what is actually available.
 */
const editInvoiceQuantity = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findOne({ where: { id: req.params.id, ...companyScope(req) } });
  if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

  if (['cancelled', 'expired', 'paid'].includes(invoice.status)) {
    return res.status(409).json({ message: `This invoice is ${invoice.status} and cannot be edited.` });
  }

  const quantity = Number(req.body.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ message: 'Quantity must be a whole number of at least 1.' });
  }

  const transaction = await sequelize.transaction();
  try {
    if (await hasApprovedPayments(invoice.id, transaction)) {
      await transaction.rollback();
      return res.status(409).json({
        message: 'This invoice has approved payments against it, so its quantity cannot be changed. '
          + 'Cancel it and reissue instead — editing it would leave the payments already taken '
          + 'pointing at schedules that no longer exist.',
      });
    }

    const loaded = await readPaymentPlan(sequelize, invoice.id, { transaction, lock: true });
    if (!loaded) {
      await transaction.rollback();
      return res.status(409).json({
        message: 'This invoice has no payment plan, so there is no quantity to edit.',
      });
    }

    /**
     * The new quantity must actually be available.
     *
     * The invoice itself holds nothing (FRD 10.1) so its own quantity is not
     * subtracted, which is what lets an admin resolve a contention by reducing
     * a 10-unit invoice to the 5 that remain.
     */
    if (loaded.plan.property_unit_id) {
      const state = await availabilityFor(sequelize, loaded.plan.property_unit_id, { transaction, lock: true });
      if (state && quantity > state.available) {
        await transaction.rollback();
        return res.status(409).json({
          message: state.available === 0
            ? 'There are no units of this configuration available.'
            : `Only ${state.available} unit${state.available === 1 ? '' : 's'} of this configuration remain.`,
          quantity_available: state.available,
        });
      }
    }

    const { priced } = await regeneratePaymentPlan(sequelize, transaction, {
      paymentPlanId: loaded.plan.id,
      quantity,
      invoiceDate: invoice.created_at,
      outrightDueDate: invoice.due_date,
    });

    // The older DECIMAL column, kept in step for everything that reads it.
    await sequelize.query(
      'UPDATE invoices SET amount = :amount WHERE id = :id',
      { replacements: { amount: toMajor(priced.totalMinor), id: invoice.id }, type: QueryTypes.UPDATE, transaction },
    );

    // Keep the purchase request in step too — it carries the quantity and total
    // that the property side reports on.
    await sequelize.query(
      `UPDATE property_purchase_requests
          SET quantity = :quantity, amount = :amount, updated_at = NOW()
        WHERE invoice_id = :invoiceId`,
      {
        replacements: { quantity, amount: toMajor(priced.totalMinor), invoiceId: invoice.id },
        type: QueryTypes.UPDATE,
        transaction,
      },
    );

    await transaction.commit();

    purchaseNotifier.dispatch({
      eventKey: 'invoice_created',
      invoiceId: invoice.id,
      type: 'invoice_updated',
      title: (role, ctx) => `Invoice ${ctx.invoice_id} updated`,
      body: (role, ctx) => {
        const subject = purchaseNotifier.describeSubject(ctx);
        return [
          role === 'client'
            ? `Your invoice ${ctx.invoice_id} for ${subject} has been updated to ${quantity} unit${quantity === 1 ? '' : 's'}.`
            : `${ctx.client_name || 'A client'}'s invoice ${ctx.invoice_id} for ${subject} has been updated to ${quantity} unit${quantity === 1 ? '' : 's'}.`,
          `New total payable: ${purchaseNotifier.money(priced.totalMinor)}.`,
          priced.durationMonths
            ? `The payment schedule has been regenerated — ${priced.durationMonths} installments of about ${purchaseNotifier.money(priced.perMonthMinor)}.`
            : null,
        ].filter(Boolean).join('\n');
      },
      data: { quantity, total: toMajor(priced.totalMinor) },
      actionLabel: 'View invoice',
      actionUrl: appUrl(`finance/invoices/${invoice.id}`, req),
    }).catch(() => {});

    return res.json({
      data: {
        invoice_id: invoice.id,
        quantity,
        pricing: {
          base: toMajor(priced.baseMinor),
          surcharge: toMajor(priced.surchargeMinor),
          total: toMajor(priced.totalMinor),
          monthly: toMajor(priced.perMonthMinor),
          final_month: toMajor(priced.finalMonthMinor),
        },
      },
    });
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }
});

/**
 * An admin cancels an invoice (FRD 6, 13).
 *
 * Releases any inventory hold, so the units go straight back on the market —
 * which is the other resolution path for FRD 10.3, and the reason a hold is
 * released rather than deleted: the record of what was held and why survives.
 *
 * An invoice with approved payments can still be cancelled — sometimes it must
 * be — but the payments are left exactly where they are. Reversing them is a
 * refund, which FRD 1 puts out of scope, so this does not pretend to do it.
 */
const cancelInvoice = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findOne({ where: { id: req.params.id, ...companyScope(req) } });
  if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
  if (['cancelled', 'expired'].includes(invoice.status)) {
    return res.status(409).json({ message: `This invoice is already ${invoice.status}.` });
  }

  const reason = String(req.body.reason || '').trim();
  const hadPayments = await hasApprovedPayments(invoice.id);

  const transaction = await sequelize.transaction();
  try {
    await sequelize.query(
      'UPDATE invoices SET status = \'cancelled\' WHERE id = :id',
      { replacements: { id: invoice.id }, type: QueryTypes.UPDATE, transaction },
    );
    await sequelize.query(
      `UPDATE invoice_payment_plans SET status = 'cancelled', updated_at = NOW()
        WHERE invoice_id = :invoiceId`,
      { replacements: { invoiceId: invoice.id }, type: QueryTypes.UPDATE, transaction },
    );
    await releaseHold(sequelize, {
      invoiceId: invoice.id,
      reason: reason || 'Invoice cancelled',
      transaction,
    });
    await sequelize.query(
      `UPDATE property_purchase_requests SET status = 'cancelled', updated_at = NOW()
        WHERE invoice_id = :invoiceId AND status <> 'completed'`,
      { replacements: { invoiceId: invoice.id }, type: QueryTypes.UPDATE, transaction },
    );
    await transaction.commit();
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }

  purchaseNotifier.dispatch({
    eventKey: 'invoice_cancelled',
    invoiceId: invoice.id,
    type: 'invoice_cancelled',
    title: (role, ctx) => `Invoice ${ctx.invoice_id} cancelled`,
    body: (role, ctx) => [
      role === 'client'
        ? `Your invoice ${ctx.invoice_id} for ${purchaseNotifier.describeSubject(ctx)} has been cancelled.`
        : `${ctx.client_name || 'A client'}'s invoice ${ctx.invoice_id} for ${purchaseNotifier.describeSubject(ctx)} has been cancelled.`,
      reason ? `Reason: ${reason}` : null,
      hadPayments
        ? 'Payments already recorded against it have not been reversed — contact the company about them.'
        : null,
    ].filter(Boolean).join('\n'),
    data: { reason: reason || null },
  }).catch(() => {});

  res.json({
    message: 'Invoice cancelled and any inventory hold released.',
    data: { id: invoice.id, status: 'cancelled', had_payments: hadPayments },
  });
});

/**
 * An admin waives an applied default fee (FRD 15.5) — with a mandatory reason
 * and an audit entry.
 *
 * The fee application row is kept and marked waived rather than deleted, so the
 * ledger still shows that the fee was charged and then forgiven. Only the
 * UNPAID part of a fee can be waived: once a client has actually paid it, there
 * is nothing to waive and giving it back is a refund.
 */
const waiveScheduleFee = asyncHandler(async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  if (!reason) {
    return res.status(400).json({ message: 'Give a reason for waiving the fee — it is recorded on the invoice.' });
  }

  const transaction = await sequelize.transaction();
  try {
    const schedules = await sequelize.query(
      `SELECT ps.*, i.company_id, i.invoice_id AS invoice_ref
         FROM payment_schedules ps
         JOIN invoices i ON i.id = ps.invoice_id
        WHERE ps.id = :id LIMIT 1 FOR UPDATE`,
      { replacements: { id: req.params.scheduleId }, type: QueryTypes.SELECT, transaction },
    );
    const schedule = schedules[0];
    if (!schedule) {
      await transaction.rollback();
      return res.status(404).json({ message: 'Payment schedule not found' });
    }

    const scope = companyScope(req);
    if (scope.company_id != null && Number(schedule.company_id) !== Number(scope.company_id)) {
      await transaction.rollback();
      return res.status(404).json({ message: 'Payment schedule not found' });
    }

    const outstandingFee = asMinor(schedule.fee_outstanding_minor);
    if (outstandingFee <= 0) {
      await transaction.rollback();
      return res.status(409).json({
        message: 'There is no outstanding default fee on this schedule to waive.',
      });
    }

    // Waive the unwaived applications, newest first, up to what is still owed.
    // Newest first because the oldest applications are the ones a part payment
    // will already have settled (FRD 8.2 clears fees before principal).
    const applications = await sequelize.query(
      `SELECT id, amount_minor FROM schedule_fee_applications
        WHERE payment_schedule_id = :id AND waived_at IS NULL
        ORDER BY period_index DESC FOR UPDATE`,
      { replacements: { id: schedule.id }, type: QueryTypes.SELECT, transaction },
    );

    let toWaive = outstandingFee;
    const waived = [];
    for (const application of applications) {
      if (toWaive <= 0) break;
      const amount = Math.min(asMinor(application.amount_minor), toWaive);
      await sequelize.query(
        `UPDATE schedule_fee_applications
            SET waived_at = NOW(), waived_by = :userId, waive_reason = :reason
          WHERE id = :id`,
        {
          replacements: { id: application.id, userId: req.user?.id ?? null, reason },
          type: QueryTypes.UPDATE,
          transaction,
        },
      );
      toWaive -= amount;
      waived.push({ id: application.id, amount_minor: amount });
    }

    const waivedMinor = outstandingFee - Math.max(toWaive, 0);
    const nextFeeOutstanding = outstandingFee - waivedMinor;
    const settled = nextFeeOutstanding === 0 && asMinor(schedule.principal_outstanding_minor) === 0;

    await sequelize.query(
      `UPDATE payment_schedules
          SET fee_outstanding_minor = :feeOutstanding,
              settlement_status = :settlementStatus,
              settled_at = CASE WHEN :settled = 1 AND settled_at IS NULL THEN NOW() ELSE settled_at END,
              updated_at = NOW()
        WHERE id = :id`,
      {
        replacements: {
          id: schedule.id,
          feeOutstanding: nextFeeOutstanding,
          settlementStatus: settled ? 'paid'
            : (asMinor(schedule.principal_outstanding_minor) < asMinor(schedule.principal_minor)
              ? 'partially_paid' : schedule.settlement_status),
          settled: settled ? 1 : 0,
        },
        type: QueryTypes.UPDATE,
        transaction,
      },
    );

    await transaction.commit();

    return res.json({
      data: {
        schedule_id: schedule.id,
        waived: toMajor(waivedMinor),
        fee_outstanding: toMajor(nextFeeOutstanding),
        settlement_status: settled ? 'paid' : undefined,
        applications_waived: waived.length,
        reason,
      },
    });
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }
});

/**
 * Payment plans holding a credit balance (FRD 8.2).
 *
 * The queue behind "surplus is flagged for admin attention" — money paid beyond
 * every schedule, which needs allocating elsewhere or refunding and would
 * otherwise sit unnoticed on a plan nobody opens.
 */
const listCreditBalances = asyncHandler(async (req, res) => {
  const scope = companyScope(req);
  const rows = await sequelize.query(
    `SELECT ipp.id, ipp.invoice_id, ipp.credit_balance_minor, ipp.credit_balance_flagged_at,
            i.invoice_id AS invoice_ref, i.client_id, i.status,
            u.name AS client_name, u.email AS client_email,
            p.name AS property_name, pu.name AS unit_name
       FROM invoice_payment_plans ipp
       JOIN invoices i ON i.id = ipp.invoice_id
       LEFT JOIN users u ON u.id = i.client_id
       LEFT JOIN property_units pu ON pu.id = ipp.property_unit_id
       LEFT JOIN properties p ON p.id = pu.property_id
      WHERE ipp.credit_balance_minor > 0
        ${scope.company_id != null ? 'AND ipp.company_id = :companyId' : ''}
      ORDER BY ipp.credit_balance_flagged_at ASC`,
    { replacements: { companyId: scope.company_id ?? null }, type: QueryTypes.SELECT },
  );

  res.json({
    data: rows.map((row) => ({
      payment_plan_id: row.id,
      invoice_id: row.invoice_id,
      invoice_ref: row.invoice_ref,
      client_id: row.client_id,
      client_name: row.client_name,
      property_name: row.property_name,
      unit_name: row.unit_name,
      invoice_status: row.status,
      credit_balance: toMajor(asMinor(row.credit_balance_minor)),
      flagged_at: row.credit_balance_flagged_at,
    })),
  });
});

module.exports = {
  getInvoiceSchedules,
  getInvoiceAllocations,
  editInvoiceQuantity,
  cancelInvoice,
  waiveScheduleFee,
  listCreditBalances,
  hasApprovedPayments,
};

const { QueryTypes } = require('sequelize');
const { lastInsertId } = require('../../../../shared/src/dialect');
const { sequelize } = require('../models');
const { asMinor, toMinor, toMajor } = require('../../../../shared/src/money');
const { allocate } = require('../../../../shared/src/paymentAllocation');
const { readPaymentPlan } = require('../../../../shared/src/paymentPlanGateway');
const { holdPolicyFor } = require('../../../../shared/src/holdPolicy');
const { placeHold, findContendedInvoices } = require('../../../../shared/src/inventoryGateway');
const { raiseOverpaymentRefund } = require('./overpaymentRefundService');
const { approvedCreditMinor } = require('../../../../shared/src/creditNotes');
const { postEvent } = require('../../../../shared/src/accounting/posting');
const promotions = require('../../../../shared/src/promotionStore');

/**
 * Applying an approved payment (FRD 7.3, 8, 10).
 *
 * ONE service, used by every entry point — a client's receipt approved by an
 * admin, an admin recording a payment on the client's behalf, marking an
 * invoice paid in full, and any future gateway callback (FRD 16). The reason
 * that matters is that allocation is the most error-prone part of the design:
 * a second implementation would agree with this one until the first schedule
 * carried a default fee, and then quietly disagree about what a client owes.
 *
 * Everything is one transaction (FRD 7.3): the payment row, the allocation
 * lines, the schedule updates, the fee settlement, the inventory decrement and
 * every status recalculation either all land or none do. A partially applied
 * approval corrupts the schedule ledger, and it cannot be repaired from the
 * outside because the evidence of what went in is the thing that is missing.
 *
 * Notifications are deliberately NOT sent from in here. They are returned for
 * the caller to dispatch after the commit, so a failing SMTP host cannot roll
 * back a payment that has already been approved.
 */

/** Everything already approved against this invoice, in minor units. */
const approvedPaidMinor = async (invoiceId, transaction) => {
  const rows = await sequelize.query(
    `SELECT COALESCE(SUM(amount), 0) AS paid FROM invoice_payments
      WHERE invoice_id = :invoiceId AND status = 'completed'`,
    { replacements: { invoiceId }, type: QueryTypes.SELECT, transaction },
  );
  return toMinor(rows[0]?.paid ?? 0);
};

/**
 * The invoice status implied by its schedules.
 *
 * Derived, never incremented: a status computed from the ledger cannot drift
 * out of step with it, which a status that is written on each event eventually
 * does. `partially_paid` is the state an installment invoice mid-plan is in and
 * that the old enum had no way to express — it looked identical to an invoice
 * nobody had paid a kobo towards.
 */
const invoiceStatusFor = (schedules) => {
  if (!schedules.length) return null;
  if (schedules.every((s) => s.settlement_status === 'paid')) return 'paid';
  const touched = schedules.some((s) => s.settlement_status !== 'unpaid');
  return touched ? 'partially_paid' : 'sent';
};

/**
 * The payment plan status implied by its schedules (FRD 11).
 *
 * IN_DEFAULT is recoverable, so it is recomputed on every payment rather than
 * latched — settling the overdue schedules returns the plan to ACTIVE by
 * itself.
 *
 * Note the `settlement_status !== 'paid'` clause: a schedule that went overdue
 * and was then settled keeps its overdue timing (FRD 9.2 keeps the two
 * dimensions independent), and treating that as continuing default would leave
 * a fully-settled plan stuck in IN_DEFAULT forever.
 */
const planStatusFor = (schedules) => {
  if (!schedules.length) return 'active';
  if (schedules.every((s) => s.settlement_status === 'paid')) return 'completed';
  const inDefault = schedules.some((s) => s.timing_status === 'overdue' && s.settlement_status !== 'paid');
  return inDefault ? 'in_default' : 'active';
};

/**
 * Decides and places the inventory hold for an invoice (FRD 10.2, 10.4).
 *
 * Called inside the approval transaction, which is what makes the oversell
 * re-check meaningful — checking availability and then placing the hold in two
 * transactions is precisely the race FRD 10.4 asks to be closed.
 *
 * Throws a 409 when the hold cannot be placed. That aborts the whole approval
 * on purpose: FRD 10.4 says to block it and surface the conflict rather than
 * take money for units that are no longer there.
 */
const evaluateHold = async (transaction, {
  invoice, plan, cumulativePaidMinor, paymentId,
}) => {
  if (!plan?.property_unit_id) return null;

  const policy = await holdPolicyFor(sequelize, invoice.company_id ?? null);
  if (!policy.isMet(cumulativePaidMinor, asMinor(plan.total_minor))) {
    // A threshold policy not yet met: the money is recorded and the client
    // holds nothing (FRD 10.2). FRD 15.7 leaves the refund path for a buyer who
    // stops below the threshold out of scope for this release.
    return { held: false, policy: policy.policy, reason: 'threshold_not_met' };
  }

  const result = await placeHold(sequelize, transaction, {
    invoiceId: invoice.id,
    propertyUnitId: plan.property_unit_id,
    propertyId: invoice.property_id,
    clientId: invoice.client_id,
    quantity: plan.quantity,
    triggerPolicy: policy.policy,
    triggeredByPaymentId: paymentId,
    cumulativePaidMinor,
    companyId: invoice.company_id ?? null,
  });

  if (!result.held && result.reason === 'insufficient_availability') {
    throw Object.assign(
      new Error(
        `Only ${result.available} unit${result.available === 1 ? '' : 's'} of this configuration `
        + `remain, and this invoice is for ${plan.quantity}. Approving it would oversell the unit. `
        + 'Reduce the invoice quantity to what is available, or cancel it, before approving this payment.',
      ),
      { status: 409, code: 'INSUFFICIENT_AVAILABILITY', available: result.available },
    );
  }
  if (!result.held) {
    throw Object.assign(
      new Error('The inventory hold for this invoice could not be placed, so the payment was not approved.'),
      { status: 409, code: result.reason },
    );
  }

  return { ...result, policy: policy.policy };
};

/**
 * Applies an approved payment of `amountMinor` to an invoice.
 *
 * `amountMinor` is the ADMIN-APPROVED figure, never what the client typed on
 * the receipt (FRD 5.3, 7.2). The caller is responsible for that distinction
 * because only the caller knows whether an admin corrected it.
 *
 * Note what is deliberately NOT done: the amount is not clamped to the
 * outstanding balance. FRD 8.2 requires a surplus beyond every schedule to
 * become a credit balance on the payment plan and be flagged for an admin —
 * clamping would silently discard money a client actually sent.
 *
 * Pass `transaction` to join an outer transaction; otherwise one is opened and
 * committed here.
 */
const applyApprovedPayment = async ({
  invoiceId, amountMinor, paymentMethod = 'bank_transfer', reference = null,
  note = null, approvedBy = null, valueDate = null, companyId = null,
}, outerTransaction = null) => {
  const amount = asMinor(amountMinor);
  if (amount <= 0) {
    throw Object.assign(new Error('Enter the amount being credited.'), { status: 400 });
  }

  const transaction = outerTransaction || await sequelize.transaction();
  const ownsTransaction = !outerTransaction;

  try {
    // Locked first, and before the plan, so concurrent approvals on the same
    // invoice queue in a consistent order and cannot deadlock against each
    // other by taking the two locks the other way round.
    const invoices = await sequelize.query(
      'SELECT * FROM invoices WHERE id = :id LIMIT 1 FOR UPDATE',
      { replacements: { id: invoiceId }, type: QueryTypes.SELECT, transaction },
    );
    const invoice = invoices[0];
    if (!invoice) throw Object.assign(new Error('Invoice not found'), { status: 404 });
    if (['cancelled', 'expired'].includes(invoice.status)) {
      throw Object.assign(new Error(`This invoice is ${invoice.status} and cannot take a payment.`), { status: 409 });
    }

    const paidBefore = await approvedPaidMinor(invoice.id, transaction);
    const resolvedCompanyId = companyId ?? invoice.company_id ?? null;

    /**
     * One bank reference, one payment.
     *
     * The reference comes off the customer's proof of payment, so the same one
     * appearing twice means the same transfer is being credited twice — the
     * classic double-credit, usually from an admin approving a receipt that a
     * colleague has already approved, or from a resubmitted proof.
     *
     * The unique index is what actually guarantees this: two approvals racing
     * would both pass the check below before either wrote. The check exists to
     * turn the common, non-concurrent case into a sentence an admin can act
     * on, naming the invoice the reference is already against, instead of a
     * duplicate-key error.
     *
     * Checked inside the transaction and after the invoice row lock, so it
     * cannot read a payment that a rolled-back approval never committed.
     */
    const normalisedReference = String(reference ?? '').trim() || null;
    if (normalisedReference) {
      const clash = await sequelize.query(
        `SELECT p.id, i.invoice_id AS document
           FROM invoice_payments p
           JOIN invoices i ON i.id = p.invoice_id
          WHERE p.transaction_id = :reference
            AND p.company_id ${resolvedCompanyId == null ? 'IS NULL' : '= :companyId'}
          LIMIT 1`,
        {
          replacements: {
            reference: normalisedReference,
            ...(resolvedCompanyId == null ? {} : { companyId: resolvedCompanyId }),
          },
          type: QueryTypes.SELECT,
          transaction,
        },
      );
      if (clash.length) {
        throw Object.assign(
          new Error(`Reference "${normalisedReference}" has already been recorded against invoice `
            + `${clash[0].document}. Each payment reference can only be used once — check whether `
            + 'this transfer has already been credited.'),
          { status: 409 },
        );
      }
    }

    // The approved payment itself — FRD's "Transaction": an approved payment,
    // allocated against schedules.
    await sequelize.query(
      `INSERT INTO invoice_payments
         (invoice_id, amount, payment_method, transaction_id, status, note, company_id, created_at)
       VALUES (:invoiceId, :amount, :method, :reference, 'completed', :note, :companyId, :valueDate)`,
      {
        replacements: {
          invoiceId: invoice.id,
          amount: toMajor(amount),
          method: paymentMethod,
          reference: normalisedReference,
          note,
          companyId: resolvedCompanyId,
          // The admin may correct the VALUE DATE as well as the amount
          // (FRD 7.2) — a transfer confirmed today may have left the client's
          // account last week, and the schedules it settles are dated.
          valueDate: valueDate ? new Date(valueDate) : new Date(),
        },
        type: QueryTypes.INSERT,
        transaction,
      },
    );
    const paymentId = await lastInsertId(sequelize, { transaction });

    await sequelize.query(
      // entry_type credit: money IN. Its counterpart is the debit written when
      // a commission on this sale is paid out.
      `INSERT INTO transactions
         (user_id, type, entry_type, amount, description, payment_method, status, reference, company_id, created_at)
       VALUES (:userId, 'invoice_payment', 'credit', :amount, :description, :method, 'completed', :reference, :companyId, NOW())`,
      {
        replacements: {
          userId: invoice.client_id,
          amount: toMajor(amount),
          description: `Payment for invoice ${invoice.invoice_id}`,
          method: paymentMethod,
          reference: normalisedReference,
          companyId: resolvedCompanyId,
        },
        type: QueryTypes.INSERT,
        transaction,
      },
    );

    /*
     * ACC-3.2: the same event, in the general ledger.
     *
     * Dr Bank / Cr Accounts receivable. Written BESIDE the cash-book row
     * above rather than instead of it — `transactions` keeps doing its job and
     * everything reading it is untouched, which is what makes the parallel run
     * possible: the two can be reconciled against each other for a month
     * before anything is retired.
     *
     * Inside the payment's own transaction, so the money and its journal stand
     * or fall together. Before either branch below, because both of them are
     * the same event as far as the ledger is concerned — a plan decides how
     * the money is ALLOCATED, not whether it arrived.
     */
    await postEvent(sequelize, {
      rule: 'invoice_payment',
      companyId: resolvedCompanyId,
      // The value date, not today: money banked on the 30th belongs in that
      // month even when it is approved on the 2nd.
      entryDate: valueDate || new Date(),
      source: 'invoice_payment',
      sourceId: String(paymentId),
      memo: `Payment for invoice ${invoice.invoice_id}`,
      createdBy: approvedBy,
      input: {
        amountMinor: amount,
        dimensions: {
          property_id: invoice.property_id ?? null,
          party_id: invoice.client_id ?? null,
          party_type: 'client',
        },
      },
    }, { transaction });

    const loaded = await readPaymentPlan(sequelize, invoice.id, { transaction, lock: true });

    /**
     * Invoices raised before the purchase journey existed have no payment plan
     * and no schedules.
     *
     * They still have to be payable, so the money is recorded and the balance
     * derived the way it always was — from the sum of payments against
     * invoices.amount. There is nothing to allocate against, so there are no
     * allocation lines and no hold; those are properties of the new model, not
     * retrofitted onto rows that never had it.
     */
    if (!loaded) {
      /*
       * What is actually owed, not what was invoiced (ACC-0.4).
       *
       * An approved credit note reduces the amount the buyer has to send. Left
       * out of this comparison, an invoice for ₦100,000 carrying a ₦20,000
       * credit note would take the buyer's ₦80,000 and stay `partially_paid`
       * for ever, chased by the reminder schedule for money nobody is owed.
       */
      // eslint-disable-next-line no-await-in-loop
      const credited = await approvedCreditMinor(sequelize, invoice.id, { transaction });
      const total = Math.max(toMinor(invoice.amount) - toMinor(invoice.discount || 0) - credited, 0);
      const paidAfter = paidBefore + amount;
      const status = paidAfter >= total ? 'paid' : 'partially_paid';
      await sequelize.query(
        'UPDATE invoices SET status = :status WHERE id = :id',
        { replacements: { status, id: invoice.id }, type: QueryTypes.UPDATE, transaction },
      );
      if (ownsTransaction) await transaction.commit();
      return {
        legacy: true,
        invoice: { ...invoice, status },
        paymentId,
        appliedMinor: amount,
        creditBalanceMinor: 0,
        totalMinor: total,
        paidMinor: paidAfter,
        balanceMinor: Math.max(total - paidAfter, 0),
        lines: [],
        hold: null,
        contended: [],
        paidInFull: status === 'paid',
      };
    }

    const { plan, schedules } = loaded;

    // The resolution itself. Pure, and the only place the FRD 8.2 ordering
    // rules are expressed.
    const result = allocate({ amountMinor: amount, schedules });

    for (const line of result.lines) {
      await sequelize.query(
        `INSERT INTO payment_allocations
           (invoice_payment_id, invoice_id, payment_schedule_id,
            principal_minor, fee_minor, created_by, company_id, created_at)
         VALUES (:paymentId, :invoiceId, :scheduleId, :principal, :fee, :createdBy, :companyId, NOW())`,
        {
          replacements: {
            paymentId,
            invoiceId: invoice.id,
            scheduleId: line.schedule_id,
            principal: line.principal_minor,
            fee: line.fee_minor,
            createdBy: approvedBy,
            companyId: resolvedCompanyId,
          },
          type: QueryTypes.INSERT,
          transaction,
        },
      );

      await sequelize.query(
        `UPDATE payment_schedules
            SET principal_outstanding_minor = :principalOutstanding,
                fee_outstanding_minor = :feeOutstanding,
                settlement_status = :settlementStatus,
                settled_at = CASE WHEN :settled = 1 AND settled_at IS NULL THEN NOW() ELSE settled_at END,
                updated_at = NOW()
          WHERE id = :id`,
        {
          replacements: {
            id: line.schedule_id,
            principalOutstanding: line.next.principal_outstanding_minor,
            feeOutstanding: line.next.fee_outstanding_minor,
            settlementStatus: line.next.settlement_status,
            settled: line.next.settlement_status === 'paid' ? 1 : 0,
          },
          type: QueryTypes.UPDATE,
          transaction,
        },
      );
    }

    // Re-read rather than patching the in-memory copies: the status
    // recalculations below must see exactly what was written, including the
    // schedules this payment did not touch.
    const after = await readPaymentPlan(sequelize, invoice.id, { transaction });
    const nextInvoiceStatus = invoiceStatusFor(after.schedules) || invoice.status;
    const nextPlanStatus = planStatusFor(after.schedules);

    let overpaymentRefund = null;
    if (result.creditBalanceMinor > 0) {
      // Flagged, not absorbed (FRD 8.2). The timestamp is what an admin queue
      // filters on, so clearing the flag later does not lose the money.
      await sequelize.query(
        `UPDATE invoice_payment_plans
            SET credit_balance_minor = credit_balance_minor + :credit,
                credit_balance_flagged_at = COALESCE(credit_balance_flagged_at, NOW()),
                updated_at = NOW()
          WHERE id = :id`,
        {
          replacements: { credit: result.creditBalanceMinor, id: plan.id },
          type: QueryTypes.UPDATE,
          transaction,
        },
      );

      /*
       * ACC-3.3: the surplus is a liability, posted where it arises.
       *
       * Dr Bank / Cr Customer credit balances. Not income and not a negative
       * receivable — the company is holding somebody else's money and owes
       * either the goods or the money back.
       */
      await postEvent(sequelize, {
        rule: 'overpayment',
        companyId: invoice.company_id ?? null,
        entryDate: valueDate || new Date(),
        source: 'overpayment',
        sourceId: String(paymentId),
        memo: `Overpayment held on ${invoice.invoice_id}`,
        createdBy: approvedBy,
        input: {
          surplusMinor: result.creditBalanceMinor,
          dimensions: {
            property_id: invoice.property_id ?? null,
            party_id: invoice.client_id ?? null,
            party_type: 'client',
          },
        },
      }, { transaction });

      /**
       * And raise the surplus as a refund, so there is an instrument to
       * approve rather than only a number on a queue. Inside this transaction
       * on purpose — see overpaymentRefundService.
       */
      overpaymentRefund = await raiseOverpaymentRefund(transaction, {
        sequelize,
        invoice,
        plan,
        surplusMinor: result.creditBalanceMinor,
        paymentId,
        companyId: resolvedCompanyId,
      });
    }

    await sequelize.query(
      'UPDATE invoice_payment_plans SET status = :status, updated_at = NOW() WHERE id = :id',
      { replacements: { status: nextPlanStatus, id: plan.id }, type: QueryTypes.UPDATE, transaction },
    );
    await sequelize.query(
      'UPDATE invoices SET status = :status WHERE id = :id',
      { replacements: { status: nextInvoiceStatus, id: invoice.id }, type: QueryTypes.UPDATE, transaction },
    );

    /**
     * Money has arrived, so the promotion this purchase used is no longer a
     * reservation — it is a redemption that counts.
     *
     * Confirmed on the FIRST payment rather than on full settlement: the buyer
     * has committed, the units are held, and a campaign should stop offering
     * its last allocation to somebody else from that moment. Waiting for the
     * final instalment would leave a six-month plan holding a place nobody can
     * see and nobody can release.
     */
    await promotions.settleRedemptions(sequelize, {
      invoiceId: invoice.id, status: 'CONFIRMED', transaction,
    }).catch(() => {});

    // Inventory last, so a blocked hold (FRD 10.4) rolls back a transaction
    // whose money side is already complete and consistent — there is no state
    // in which the payment survived and the hold did not.
    const hold = await evaluateHold(transaction, {
      invoice, plan, cumulativePaidMinor: paidBefore + amount, paymentId,
    });

    /**
     * Whose invoices this hold has just undercut (FRD 10.3).
     *
     * Read inside the transaction so the availability figure quoted to them is
     * the one that actually resulted. They are NOT cancelled — FRD 10.3 is
     * explicit that the invoice stays open pending client or admin action.
     */
    let contended = [];
    if (hold?.held && !hold.existing) {
      contended = await findContendedInvoices(sequelize, {
        propertyUnitId: plan.property_unit_id,
        available: hold.availableAfter,
        excludeInvoiceId: invoice.id,
        transaction,
      });
    }

    if (ownsTransaction) await transaction.commit();

    const totalMinor = asMinor(plan.total_minor);
    const outstandingMinor = after.schedules.reduce(
      (sum, s) => sum + asMinor(s.principal_outstanding_minor) + asMinor(s.fee_outstanding_minor),
      0,
    );

    return {
      legacy: false,
      invoice: { ...invoice, status: nextInvoiceStatus },
      plan: { ...plan, status: nextPlanStatus },
      schedules: after.schedules,
      paymentId,
      appliedMinor: result.appliedMinor,
      creditBalanceMinor: result.creditBalanceMinor,
      // The refund raised for the surplus, so the caller can tell the admin
      // one is now waiting on an approver rather than leaving them to
      // discover it.
      overpaymentRefund,
      totalMinor,
      paidMinor: paidBefore + amount,
      balanceMinor: outstandingMinor,
      lines: result.lines,
      hold,
      contended,
      paidInFull: nextInvoiceStatus === 'paid',
      planCompleted: nextPlanStatus === 'completed',
      availableAfter: hold?.availableAfter ?? null,
    };
  } catch (error) {
    if (ownsTransaction && !transaction.finished) await transaction.rollback();
    throw error;
  }
};

module.exports = {
  applyApprovedPayment,
  approvedPaidMinor,
  invoiceStatusFor,
  planStatusFor,
};

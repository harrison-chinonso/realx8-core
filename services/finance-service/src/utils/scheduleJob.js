const cron = require('node-cron');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const { asMinor } = require('../../../../shared/src/money');
const { planTerms, defaultFeeFor } = require('../../../../shared/src/installmentPricing');
const {
  scheduleForInvoice, offsetsDueToday, describeOffset,
} = require('../../../../shared/src/reminderSchedule');
const { createPurchaseNotifier } = require('../../../../shared/src/purchaseNotifications');
const { invoiceExpiryDays } = require('../../../../shared/src/holdPolicy');
const { releaseHold } = require('../../../../shared/src/inventoryGateway');
const promotions = require('../../../../shared/src/promotionStore');
const { planStatusFor } = require('../services/allocationService');

const purchaseNotifier = createPurchaseNotifier(sequelize);

/**
 * The daily schedule job (FRD 9.4).
 *
 * Evaluates every schedule on an active payment plan: moves timing statuses
 * along, applies newly triggered default fees the moment grace elapses with no
 * admin action (FRD 9.3), recalculates plan status (FRD 11), enqueues the
 * FRD 12 notifications, and expires unpaid invoices where a company has asked
 * for that (FRD 15.6).
 *
 * IDEMPOTENT, which FRD 9.4 requires and which is the whole design constraint
 * here. Three separate mechanisms, because there are three separate things that
 * must not happen twice:
 *
 *   a fee            UNIQUE(payment_schedule_id, period_index) on
 *                    schedule_fee_applications. A duplicate FAILS THE INSERT
 *                    rather than being caught by a prior check, so a job that
 *                    overlaps itself or runs on two hosts still cannot charge a
 *                    client twice.
 *   a reminder       reminder_first_sent_at / reminder_second_sent_at.
 *   a status notice  notified_timing_status, compared against the current one,
 *                    so the event fires on the transition and not every day
 *                    the schedule stays overdue.
 *
 * Running it twice in a row is therefore a no-op the second time, and that is
 * asserted directly in the verification script rather than assumed.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** FRD 9.3 — a MONTHLY default fee reapplies every 30 days while unsettled. */
const FEE_RECURRENCE_DAYS = 30;

/** Midnight UTC for a date, so day arithmetic is not skewed by a timestamp. */
const startOfDay = (value) => {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};

const daysBetween = (from, to) => Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS);

/**
 * The timing status a schedule should be in (FRD 9.2).
 *
 * DUE covers the due date onward until grace begins. Where a plan has NO grace
 * period the schedule goes straight from DUE to OVERDUE the day after it falls
 * due, which is correct — a zero-day grace window is not a one-day one.
 */
const timingStatusFor = (schedule, terms, today) => {
  const dueIn = daysBetween(today, schedule.due_date);
  if (dueIn > 0) return 'upcoming';

  const daysPastDue = -dueIn;
  if (daysPastDue === 0) return 'due';

  const grace = Math.max(Number(terms.gracePeriodDays) || 0, 0);
  if (daysPastDue <= grace) return 'in_grace';
  return 'overdue';
};

/**
 * How many fee periods have been triggered on an overdue schedule.
 *
 * Returns the highest period_index that is due, or -1 for none. Period 0 is the
 * day grace elapses; each further period is 30 days later, and only for a
 * MONTHLY recurrence.
 *
 * Catching up matters: a job that did not run for a week must apply every
 * period it missed, not only the current one, or a client's arrears quietly
 * depend on the scheduler's uptime.
 */
const highestFeePeriod = (schedule, terms, today) => {
  const grace = Math.max(Number(terms.gracePeriodDays) || 0, 0);
  const graceEnds = startOfDay(schedule.due_date) + (grace + 1) * DAY_MS;
  if (startOfDay(today) < graceEnds) return -1;
  if (terms.defaultFeeRecurrence !== 'monthly') return 0;
  return Math.floor((startOfDay(today) - graceEnds) / (FEE_RECURRENCE_DAYS * DAY_MS));
};

/**
 * Applies one fee period to a schedule, or does nothing if it is already
 * applied.
 *
 * The duplicate-key catch IS the idempotency guarantee, not a fallback for it:
 * the check-then-insert alternative has a window between the two in which a
 * second run inserts as well.
 */
const applyFeePeriod = async (transaction, { schedule, terms, periodIndex, amountMinor }) => {
  try {
    await sequelize.query(
      `INSERT INTO schedule_fee_applications
         (payment_schedule_id, invoice_id, period_index, amount_minor, applied_at, company_id, created_at)
       VALUES (:scheduleId, :invoiceId, :periodIndex, :amount, NOW(), :companyId, NOW())`,
      {
        replacements: {
          scheduleId: schedule.id,
          invoiceId: schedule.invoice_id,
          periodIndex,
          amount: amountMinor,
          companyId: schedule.company_id ?? null,
        },
        type: QueryTypes.INSERT,
        transaction,
      },
    );
  } catch (error) {
    // Already applied for this trigger. Exactly what the unique index is for.
    if (error?.name === 'SequelizeUniqueConstraintError' || error?.parent?.code === 'ER_DUP_ENTRY') {
      return false;
    }
    throw error;
  }

  await sequelize.query(
    `UPDATE payment_schedules
        SET fee_accrued_minor = fee_accrued_minor + :amount,
            fee_outstanding_minor = fee_outstanding_minor + :amount,
            updated_at = NOW()
      WHERE id = :id`,
    { replacements: { amount: amountMinor, id: schedule.id }, type: QueryTypes.UPDATE, transaction },
  );
  return true;
};

/**
 * The reminder schedule for one installment's invoice, resolved once per
 * (invoice, company) and reused for the rest of the sweep.
 *
 * A sweep touches every unsettled installment on the platform, and most of them
 * belong to a handful of companies on the company default. Resolving per row
 * would be two queries per installment for an answer that does not change
 * within a run — the cache is keyed on what actually distinguishes the answer,
 * which is the invoice's own override if it has one and the company otherwise.
 */
const reminderScheduleFor = async (row, cache) => {
  const key = row.reminder_schedule_id
    ? `invoice:${row.invoice_id}`
    : `company:${row.invoice_company_id ?? row.company_id ?? 'none'}`;
  if (cache.has(key)) return cache.get(key);

  const resolved = await scheduleForInvoice(sequelize, {
    invoiceId: row.reminder_schedule_id ? row.invoice_id : null,
    companyId: row.invoice_company_id ?? row.company_id ?? null,
  });
  cache.set(key, resolved);
  return resolved;
};

/** Which offsets have already gone out for this installment. */
const sentOffsetsFor = async (scheduleId, transaction) => {
  const rows = await sequelize.query(
    'SELECT offset_days FROM schedule_reminder_sends WHERE payment_schedule_id = :id',
    { replacements: { id: scheduleId }, type: QueryTypes.SELECT, transaction },
  );
  return rows.map((r) => Number(r.offset_days));
};

/**
 * Claim one reminder, or report that somebody else already has.
 *
 * The INSERT is the claim, and the unique index is what makes it one — exactly
 * as applyFeePeriod works. A check-then-send has a window between the two in
 * which a concurrent run sends as well, and a buyer who gets the same reminder
 * twice stops reading them.
 */
const recordReminderSend = async (transaction, { row, offsetDays, scheduleId }) => {
  try {
    await sequelize.query(
      `INSERT INTO schedule_reminder_sends
         (payment_schedule_id, invoice_id, offset_days, sent_at, reminder_schedule_id, company_id, created_at)
       VALUES (:scheduleId, :invoiceId, :offset, NOW(), :reminderScheduleId, :companyId, NOW())`,
      {
        replacements: {
          scheduleId: row.id,
          invoiceId: row.invoice_id,
          offset: offsetDays,
          reminderScheduleId: scheduleId ?? null,
          companyId: row.invoice_company_id ?? row.company_id ?? null,
        },
        type: QueryTypes.INSERT,
        transaction,
      },
    );
    return true;
  } catch (error) {
    if (error?.name === 'SequelizeUniqueConstraintError' || error?.parent?.code === 'ER_DUP_ENTRY') {
      return false;
    }
    throw error;
  }
};

/** Every unsettled schedule on a live plan, with the plan's frozen terms. */
const dueSchedules = async () => sequelize.query(
  `SELECT ps.*, 
          ipp.id AS plan_id, ipp.status AS plan_status, ipp.payment_type,
          ipp.snapshot_plan_name, ipp.snapshot_duration_months,
          ipp.snapshot_grace_period_days, ipp.snapshot_default_fee_type,
          ipp.snapshot_default_fee_value, ipp.snapshot_default_fee_recurrence,
          i.invoice_id AS invoice_ref, i.client_id, i.status AS invoice_status,
          i.company_id AS invoice_company_id, i.reminder_schedule_id
     FROM payment_schedules ps
     JOIN invoice_payment_plans ipp ON ipp.id = ps.invoice_payment_plan_id
     JOIN invoices i ON i.id = ps.invoice_id
    WHERE ps.settlement_status <> 'paid'
      AND ipp.status IN ('active', 'in_default')
      AND i.status NOT IN ('cancelled', 'expired', 'draft')
    ORDER BY ps.due_date ASC, ps.id ASC`,
  { type: QueryTypes.SELECT },
);

/**
 * One pass over the schedules.
 *
 * Notifications are collected and dispatched AFTER the database work, so an
 * unreachable SMTP host cannot leave a fee applied but its status unwritten.
 */
const evaluateSchedules = async (today = new Date()) => {
  const rows = await dueSchedules();
  const summary = {
    examined: rows.length, feesApplied: 0, transitions: 0, reminders: 0, plansUpdated: 0,
  };
  const events = [];
  const touchedPlans = new Set();
  // One resolution per company (or per overridden invoice) for the whole sweep.
  const scheduleCache = new Map();

  for (const row of rows) {
    const terms = planTerms(row);
    const nextTiming = timingStatusFor(row, terms, today);

    const transaction = await sequelize.transaction();
    try {
      // ── default fees (FRD 9.3) ───────────────────────────────────────────
      let feeApplied = 0;
      if (nextTiming === 'overdue' && terms.defaultFeeType !== 'none') {
        const highest = highestFeePeriod(row, terms, today);
        for (let period = 0; period <= highest; period += 1) {
          const amountMinor = defaultFeeFor(row, terms);
          if (amountMinor <= 0) break;
          // eslint-disable-next-line no-await-in-loop
          const applied = await applyFeePeriod(transaction, {
            schedule: row, terms, periodIndex: period, amountMinor,
          });
          if (applied) {
            feeApplied += amountMinor;
            summary.feesApplied += 1;
          }
        }
      }

      // ── timing status ────────────────────────────────────────────────────
      if (nextTiming !== row.timing_status) {
        await sequelize.query(
          'UPDATE payment_schedules SET timing_status = :status, updated_at = NOW() WHERE id = :id',
          { replacements: { status: nextTiming, id: row.id }, type: QueryTypes.UPDATE, transaction },
        );
        summary.transitions += 1;
      }

      /**
       * ── reminders, on whatever schedule applies to this invoice ──────────
       *
       * The offsets used to be two constants, which meant exactly two
       * reminders, both before the due date, for every company on the
       * platform. They now come from the invoice's schedule, the company's
       * default, or the platform's — resolved per invoice, cached per company
       * for the sweep.
       *
       * Nothing is sent for an installment that has been paid. That is the
       * rule the whole feature rests on: a reminder is a request for money,
       * and asking somebody for money they have already sent is the fastest
       * way to make them ignore every later message. The outstanding figure is
       * for THIS installment, so a buyer who is up to date this month hears
       * nothing even with later months still to run.
       */
      const dueIn = daysBetween(today, row.due_date);
      const schedule = await reminderScheduleFor(row, scheduleCache);
      const outstanding = asMinor(row.principal_outstanding_minor)
        + asMinor(row.fee_outstanding_minor) - asMinor(row.discount_minor);

      const alreadySent = await sentOffsetsFor(row.id, transaction);
      const { send, supersede } = offsetsDueToday({
        offsets: schedule.offsets,
        dueDate: row.due_date,
        outstandingMinor: outstanding,
        alreadySent,
        now: today,
      });

      /**
       * Offsets the window passed over are RECORDED, not sent.
       *
       * Without this they stay unsent and reached, so the next run picks the
       * next one down and emails the buyer again — a sweep run twice in a day
       * would send two reminders for one due date. Recording them closes the
       * missed window quietly, which is the whole intent of only sending the
       * latest.
       */
      for (const offsetDays of supersede) {
        // eslint-disable-next-line no-await-in-loop
        await recordReminderSend(transaction, { row, offsetDays, scheduleId: schedule.id });
      }

      for (const offsetDays of send) {
        // eslint-disable-next-line no-await-in-loop
        const recorded = await recordReminderSend(transaction, {
          row, offsetDays, scheduleId: schedule.id,
        });
        // The insert is the claim on this reminder; losing the race means
        // somebody else is sending it, so this run must not send it too.
        if (!recorded) continue;
        events.push({
          kind: 'reminder',
          eventKey: offsetDays <= 0 ? 'schedule_reminder_before' : 'schedule_reminder_late',
          row,
          dueIn,
          offsetDays,
          schedule,
        });
        summary.reminders += 1;
      }

      // ── transition notices, fired once per change ────────────────────────
      if (nextTiming !== row.notified_timing_status && ['due', 'in_grace', 'overdue'].includes(nextTiming)) {
        await sequelize.query(
          'UPDATE payment_schedules SET notified_timing_status = :status WHERE id = :id',
          { replacements: { status: nextTiming, id: row.id }, type: QueryTypes.UPDATE, transaction },
        );
        events.push({ kind: 'timing', eventKey: `schedule_${nextTiming}`, row, feeApplied });
      }

      await transaction.commit();
      touchedPlans.add(row.plan_id);
    } catch (error) {
      if (!transaction.finished) await transaction.rollback();
      // One bad schedule must not abandon the rest of the sweep.
      console.error(`[schedule-job] schedule ${row.id} failed:`, error.message);
    }
  }

  // ── plan status (FRD 11) ────────────────────────────────────────────────
  for (const planId of touchedPlans) {
    try {
      const schedules = await sequelize.query(
        'SELECT timing_status, settlement_status FROM payment_schedules WHERE invoice_payment_plan_id = :id',
        { replacements: { id: planId }, type: QueryTypes.SELECT },
      );
      const status = planStatusFor(schedules);
      const [, affected] = await sequelize.query(
        'UPDATE invoice_payment_plans SET status = :status, updated_at = NOW() WHERE id = :id AND status <> :status',
        { replacements: { status, id: planId }, type: QueryTypes.UPDATE },
      );
      if (affected) summary.plansUpdated += 1;
    } catch (error) {
      console.error(`[schedule-job] plan ${planId} status failed:`, error.message);
    }
  }

  return { summary, events };
};

/** Dispatches the collected notifications. Best effort, never throws. */
const dispatchEvents = async (events) => {
  for (const event of events) {
    const { row } = event;
    const payable = asMinor(row.principal_outstanding_minor) + asMinor(row.fee_outstanding_minor)
      + (event.feeApplied || 0);

    /**
     * A reminder says WHEN, not which number it is.
     *
     * The old titles came from the reminder's position in a fixed pair, so both
     * of them read "Payment due in N days" and neither could say anything about
     * a payment that was already late. With arbitrary offsets the position is
     * meaningless and the timing is the whole message.
     */
    const offset = Number(event.offsetDays) || 0;
    const titles = {
      schedule_reminder_before: () => (offset === 0
        ? `Payment due today — ${row.invoice_ref}`
        : `Payment due in ${Math.abs(offset)} day${Math.abs(offset) === 1 ? '' : 's'} — ${row.invoice_ref}`),
      schedule_reminder_late: () => `Payment ${offset} day${offset === 1 ? '' : 's'} overdue — ${row.invoice_ref}`,
      schedule_due: () => `Payment due today — ${row.invoice_ref}`,
      schedule_in_grace: () => `Payment overdue, still within grace — ${row.invoice_ref}`,
      schedule_overdue: () => `Payment overdue and a late fee applied — ${row.invoice_ref}`,
    };

    // eslint-disable-next-line no-await-in-loop
    await purchaseNotifier.dispatch({
      eventKey: event.eventKey,
      invoiceId: row.invoice_id,
      type: event.eventKey,
      title: titles[event.eventKey] || (() => `Payment update — ${row.invoice_ref}`),
      /**
       * FRD 12.3: property and unit, invoice reference, amount due, due date,
       * and where a fee has been applied, the fee amount and the resulting
       * total payable.
       */
      body: (role, ctx) => {
        const subject = purchaseNotifier.describeSubject(ctx);
        const who = role === 'client' ? 'Your' : `${ctx?.client_name || 'A client'}'s`;
        const dueOn = purchaseNotifier.onDate(row.due_date);
        const lines = [];

        if (event.eventKey === 'schedule_overdue') {
          lines.push(`${who} installment ${row.sequence} on ${subject} (invoice ${row.invoice_ref}) `
            + `was due on ${dueOn} and the grace period has now elapsed.`);
          if (event.feeApplied > 0) {
            lines.push(`A late fee of ${purchaseNotifier.money(event.feeApplied)} has been applied.`);
          }
          lines.push(`Total now payable on this installment: ${purchaseNotifier.money(payable)}.`);
        } else if (event.eventKey === 'schedule_in_grace') {
          lines.push(`${who} installment ${row.sequence} on ${subject} (invoice ${row.invoice_ref}) `
            + `was due on ${dueOn} and is now within its grace period.`);
          lines.push(`Amount due: ${purchaseNotifier.money(payable)}. No late fee has been applied yet — `
            + `paying within the grace period avoids one.`);
        } else if (event.eventKey === 'schedule_due') {
          lines.push(`${who} installment ${row.sequence} of ${purchaseNotifier.money(payable)} on ${subject} `
            + `(invoice ${row.invoice_ref}) is due today.`);
        } else if (event.kind === 'reminder') {
          /**
           * The same sentence whether it is early or late, because it is the
           * same fact: this much is owed, and it was or will be due on this
           * date. Only the framing moves.
           */
          if (offset > 0) {
            lines.push(`${who} installment ${row.sequence} of ${purchaseNotifier.money(payable)} on ${subject} `
              + `(invoice ${row.invoice_ref}) was due on ${dueOn} and has not been paid.`);
          } else if (offset === 0) {
            lines.push(`${who} installment ${row.sequence} of ${purchaseNotifier.money(payable)} on ${subject} `
              + `(invoice ${row.invoice_ref}) is due today.`);
          } else {
            lines.push(`${who} installment ${row.sequence} of ${purchaseNotifier.money(payable)} on ${subject} `
              + `(invoice ${row.invoice_ref}) is due on ${dueOn}.`);
          }
        } else {
          lines.push(`${who} installment ${row.sequence} of ${purchaseNotifier.money(payable)} on ${subject} `
            + `(invoice ${row.invoice_ref}) is due on ${dueOn}.`);
        }

        if (role === 'realtor') {
          lines.push('', 'You are copied so you can follow this up with your client directly.');
        }
        return lines.join('\n');
      },
      data: {
        schedule_id: row.id,
        sequence: row.sequence,
        due_date: row.due_date,
        amount_due: Number(payable) / 100,
        fee_applied: (event.feeApplied || 0) / 100,
        // So a company can see WHICH of its configured reminders this was.
        reminder_offset_days: event.kind === 'reminder' ? offset : undefined,
        reminder_timing: event.kind === 'reminder' ? describeOffset(offset) : undefined,
      },
    });
  }
};

/**
 * Expires unpaid invoices past a company's configured window (FRD 15.6).
 *
 * Off unless a company sets one, so nothing expires on a company that never
 * asked. Only invoices with NO approved payment are touched: a part-paid
 * invoice is a live arrangement, not an abandoned one.
 */
const expireStaleInvoices = async (today = new Date()) => {
  let expired = 0;
  try {
    const companies = await sequelize.query(
      `SELECT DISTINCT company_id FROM invoices
        WHERE status IN ('sent', 'payment_under_review') AND company_id IS NOT NULL`,
      { type: QueryTypes.SELECT },
    );

    for (const { company_id: companyId } of companies) {
      // eslint-disable-next-line no-await-in-loop
      const days = await invoiceExpiryDays(sequelize, companyId);
      if (!days) continue;

      const cutoff = new Date(startOfDay(today) - days * DAY_MS);
      // eslint-disable-next-line no-await-in-loop
      const stale = await sequelize.query(
        /*
         * Property sales only.
         *
         * Auto-expiry exists to stop an abandoned purchase holding inventory
         * for ever. A service-fee invoice (ACC-0.1) holds no inventory and has
         * nothing to release, so expiring one would achieve nothing and lose
         * something: the charge would lapse silently while the verification it
         * bills for stayed queued, with the realtor told neither.
         *
         * A fee that is never paid is a conversation, not a timeout.
         */
        `SELECT i.id, i.invoice_id FROM invoices i
          WHERE i.company_id = :companyId
            AND i.${sequelize.getDialect() === 'postgres' ? '"type"' : '`type`'} = 'property_sale'
            AND i.status IN ('sent', 'payment_under_review')
            AND i.created_at < :cutoff
            AND NOT EXISTS (
              SELECT 1 FROM invoice_payments ip
               WHERE ip.invoice_id = i.id AND ip.status = 'completed'
            )`,
        { replacements: { companyId, cutoff }, type: QueryTypes.SELECT },
      );

      for (const invoice of stale) {
        // eslint-disable-next-line no-await-in-loop
        const transaction = await sequelize.transaction();
        try {
          await sequelize.query(
            "UPDATE invoices SET status = 'expired' WHERE id = :id",
            { replacements: { id: invoice.id }, type: QueryTypes.UPDATE, transaction },
          );
          await sequelize.query(
            "UPDATE invoice_payment_plans SET status = 'cancelled', updated_at = NOW() WHERE invoice_id = :id",
            { replacements: { id: invoice.id }, type: QueryTypes.UPDATE, transaction },
          );
          // Belt and braces — an unpaid invoice should hold nothing anyway.
          await releaseHold(sequelize, { invoiceId: invoice.id, reason: 'Invoice expired', transaction });
          /**
           * And hand back whatever promotion allocation it was holding, for
           * the same reason the cancel path does: a campaign exhausted by
           * expired invoices looks live and refuses everybody.
           */
          await promotions.settleRedemptions(sequelize, {
            invoiceId: invoice.id, status: 'RELEASED', transaction,
          }).catch(() => {});
          await transaction.commit();
          expired += 1;

          purchaseNotifier.dispatch({
            // Its own event, so a company can tell an expiry from a deliberate
            // cancellation and route them differently.
            eventKey: 'invoice_expired',
            invoiceId: invoice.id,
            type: 'invoice_expired',
            title: (role, ctx) => `Invoice ${ctx.invoice_id} has expired`,
            body: (role, ctx) => (role === 'client'
              ? `Your invoice ${ctx.invoice_id} for ${purchaseNotifier.describeSubject(ctx)} expired after `
                + `${days} days without payment. You can start a new purchase at any time.`
              : `${ctx.client_name || 'A client'}'s invoice ${ctx.invoice_id} expired after ${days} days `
                + 'without payment.'),
          }).catch(() => {});
        } catch (error) {
          if (!transaction.finished) await transaction.rollback();
          console.error(`[schedule-job] expiring invoice ${invoice.id} failed:`, error.message);
        }
      }
    }
  } catch (error) {
    console.error('[schedule-job] invoice expiry sweep failed:', error.message);
  }
  return expired;
};

/** One full run. Exported so it can be driven directly for verification. */
const runScheduleSweep = async (today = new Date()) => {
  const started = Date.now();
  const { summary, events } = await evaluateSchedules(today);
  await dispatchEvents(events);
  const expired = await expireStaleInvoices(today);

  const result = { ...summary, expired, ms: Date.now() - started };
  console.log('[schedule-job]', JSON.stringify(result));
  return result;
};

/**
 * Arms the job. Called from index.js's onReady, so it starts once the port is
 * open and never during migrations.
 *
 * 02:00 daily: after midnight so a schedule due "today" is evaluated on its own
 * date, and in the quiet hours because a fee application writes to every
 * overdue schedule in the database.
 */
const startScheduleJob = () => {
  const task = cron.schedule('0 2 * * *', () => {
    runScheduleSweep().catch((error) => {
      console.error('[schedule-job] run failed:', error.message);
    });
  });
  console.log('[schedule-job] armed — daily at 02:00');
  return task;
};

module.exports = {
  startScheduleJob,
  runScheduleSweep,
  evaluateSchedules,
  expireStaleInvoices,
  // Exported for direct assertion in the verification script.
  timingStatusFor,
  highestFeePeriod,
  daysBetween,
};

/**
 * Realtor Reactivation Scheduler
 *
 * Runs daily at 08:00. Checks last_active_at for realtor users and sends
 * escalating notifications at 30, 60, and 90 days of inactivity.
 *
 * At 90 days, the realtor is also flagged as inactive (is_active = false)
 * and added to a reactivation campaign via a care alert.
 */
const cron = require('node-cron');
const { Op } = require('sequelize');
const { User, RealtorReactivationNotice } = require('../models');
const { isDuplicateError } = require('../../../../shared/src/dialect');

const INACTIVE_THRESHOLDS = [
  { days: 30, message: 'You haven\'t logged in for 30 days. We miss you! Check the latest properties and leads.' },
  { days: 60, message: 'It\'s been 60 days since your last activity. Your leads may be going cold — log in and follow up!' },
  { days: 90, message: 'You\'ve been inactive for 90 days. Your account has been flagged for review. Please log in to reactivate.' },
];

const { createDispatcher } = require('../../../../shared/src/notificationDispatcher');
const { sequelize } = require('../config/database');
const notify = createDispatcher(sequelize);

/**
 * Tells a lapsing realtor, and whoever watches for them.
 *
 * This used to POST to `/notifications/internal` on notification-service. That
 * route does not exist and never has, so every reactivation notice since this
 * scheduler was written has been fired into a 404 — silently, because the
 * request was not awaited and the catch swallowed everything. Nobody has been
 * receiving these.
 *
 * Now a configured event, delivered in-process like every other notification,
 * so a failure is at least logged.
 */
const sendNotification = async (realtor, message, days) => {
  await notify.dispatch({
    eventKey: 'realtor_inactive',
    subjectUserId: realtor.id,
    companyId: realtor.company_id ?? null,
    context: { realtor, days },
    title: () => `${days} days without activity`,
    body: (role, ctx) => (role === 'subject'
      ? message
      : `${ctx.subject?.name || 'A realtor'} has been inactive for ${days} days.`),
    data: { days },
  });
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The furthest step a realtor has passed, or null if they are still inside 30 days. */
const reachedThreshold = (lastActiveAt, now) => {
  const idle = (now.getTime() - new Date(lastActiveAt).getTime()) / DAY_MS;
  // Descending, so 95 days idle is a 90-day notice and not a 30-day one.
  return [...INACTIVE_THRESHOLDS].reverse().find((t) => idle >= t.days) || null;
};

/**
 * Who has lapsed, and what they have already been told.
 *
 * ── Why this is no longer a date band ───────────────────────────────────────
 *
 * It used to select everyone whose last activity fell inside a one-day window
 * ending exactly at the threshold, which made the notice depend on the job
 * running that day. A missed run — a deploy at 08:00, an instance restarting —
 * moved the window past the realtor and they were never told, silently. Two
 * runs in a day told them twice.
 *
 * Now it asks the durable question instead: past the step, and not yet told.
 * A missed day is caught up the next morning, and a second instance loses the
 * race on the unique index rather than sending a second email.
 */
const runReactivationCheck = async () => {
  const now = new Date();
  const earliest = new Date(now.getTime() - INACTIVE_THRESHOLDS[0].days * DAY_MS);

  const realtors = await User.findAll({
    where: {
      type: 'realtor',
      is_active: true,
      last_active_at: { [Op.ne]: null, [Op.lte]: earliest },
    },
    attributes: ['id', 'name', 'email', 'company_id', 'last_active_at'],
  });

  const counts = {};

  for (const realtor of realtors) {
    const threshold = reachedThreshold(realtor.last_active_at, now);
    if (!threshold) continue;

    /*
     * A realtor who came back and lapsed again earns the whole escalation
     * again. Notices recorded against an OLDER last_active_at belong to the
     * previous cycle and are cleared, so the unique index cannot silence
     * somebody for ever after one run of nudges.
     */
    // eslint-disable-next-line no-await-in-loop
    await RealtorReactivationNotice.destroy({
      where: { user_id: realtor.id, basis: { [Op.lt]: realtor.last_active_at } },
    });

    /*
     * The insert IS the decision to send, not a note taken afterwards.
     *
     * Claiming the row first means two instances reaching this line together
     * produce one winner and one duplicate-key error, and only the winner
     * sends. Recording it after the notification would let both send and both
     * then record.
     */
    try {
      // eslint-disable-next-line no-await-in-loop
      await RealtorReactivationNotice.create({
        user_id: realtor.id,
        days: threshold.days,
        basis: realtor.last_active_at,
        company_id: realtor.company_id ?? null,
        sent_at: now,
      });
    } catch (error) {
      // Already told, by an earlier run or by another instance a moment ago.
      if (isDuplicateError(error)) continue;
      throw error;
    }

    // eslint-disable-next-line no-await-in-loop
    await sendNotification(realtor, threshold.message, threshold.days);

    if (threshold.days === 90) {
      // eslint-disable-next-line no-await-in-loop
      await User.update({ is_active: false }, { where: { id: realtor.id } });
    }

    counts[threshold.days] = (counts[threshold.days] || 0) + 1;
  }

  Object.entries(counts).forEach(([days, count]) => {
    console.info(`[reactivation] Notified ${count} realtor(s) at ${days}-day threshold`);
  });
};

function startReactivationScheduler() {
  // Run daily at 08:00 server time
  cron.schedule('0 8 * * *', () => {
    runReactivationCheck().catch((err) =>
      console.error('[reactivation] Scheduler error:', err.message)
    );
  });
  console.info('[reactivation] Realtor reactivation scheduler started (daily at 08:00)');
};

module.exports = startReactivationScheduler;
module.exports.runReactivationCheck = runReactivationCheck;

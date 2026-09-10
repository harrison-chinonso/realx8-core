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
const { User } = require('../models');

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

const runReactivationCheck = async () => {
  const now = new Date();

  for (const threshold of INACTIVE_THRESHOLDS) {
    const cutoff = new Date(now.getTime() - threshold.days * 24 * 60 * 60 * 1000);
    const prev = new Date(cutoff.getTime() - 24 * 60 * 60 * 1000); // ±1 day window

    const realtors = await User.findAll({
      where: {
        type: 'realtor',
        is_active: true,
        last_active_at: { [Op.between]: [prev, cutoff] },
      },
      attributes: ['id', 'name', 'email', 'company_id'],
    });

    for (const realtor of realtors) {
      await sendNotification(realtor, threshold.message, threshold.days);

      // At 90 days — flag inactive
      if (threshold.days === 90) {
        await User.update({ is_active: false }, { where: { id: realtor.id } });
      }
    }

    if (realtors.length) {
      console.info(`[reactivation] Notified ${realtors.length} realtor(s) at ${threshold.days}-day threshold`);
    }
  }
};

module.exports = function startReactivationScheduler() {
  // Run daily at 08:00 server time
  cron.schedule('0 8 * * *', () => {
    runReactivationCheck().catch((err) =>
      console.error('[reactivation] Scheduler error:', err.message)
    );
  });
  console.info('[reactivation] Realtor reactivation scheduler started (daily at 08:00)');
};

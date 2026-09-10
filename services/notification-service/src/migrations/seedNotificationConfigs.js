const { EVENTS } = require('../../../../shared/src/notificationEvents');

/**
 * Seeds the platform default notification configuration from the event
 * catalogue.
 *
 * Idempotent and deliberately additive: an event already present is left
 * exactly as it is. The platform operator may edit these rows, and a seeder
 * that reasserted the catalogue on every boot would silently undo that on the
 * next restart.
 *
 * New events added to the catalogue later DO get seeded, because the check is
 * per event rather than "is the table empty" — so adding one entry to
 * notificationEvents.js is all that is needed for it to appear, configured to
 * its default, on every existing deployment.
 */
module.exports = async (models) => {
  const { NotificationConfig } = models;
  let created = 0;

  for (const entry of EVENTS) {
    // findOrCreate rather than relying on the unique index: company_id is NULL
    // for platform rows, and MySQL treats NULLs as distinct in a unique index,
    // so the index would not prevent a duplicate here.
    // eslint-disable-next-line no-await-in-loop
    const [, wasCreated] = await NotificationConfig.findOrCreate({
      where: { company_id: null, event_key: entry.key },
      defaults: {
        company_id: null,
        event_key: entry.key,
        enabled: entry.defaults.enabled,
        notify_subject: entry.defaults.subject,
        notify_realtor: entry.defaults.realtor,
        notify_permissions: entry.defaults.permissions,
        channel: entry.defaults.channel,
      },
    });
    if (wasCreated) created += 1;
  }

  if (created > 0) {
    console.log(`[notify-config] ${EVENTS.length} events in the catalogue; seeded ${created} new default(s)`);
  }
};

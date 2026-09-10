const { PLATFORM_DEFAULTS } = require('../../../../shared/src/notificationConfig');

/**
 * Seeds the FRD 12.2 platform default notification matrix.
 *
 * Idempotent, and deliberately additive: an event already present is left
 * exactly as it is. The platform operator is allowed to edit these rows, and a
 * seeder that reasserted the matrix on every boot would silently undo that on
 * the next restart.
 *
 * New events added to the matrix later DO get seeded, because the check is per
 * event rather than "is the table empty".
 */
module.exports = async (models) => {
  const { NotificationConfig } = models;

  for (const [eventKey, recipients] of Object.entries(PLATFORM_DEFAULTS)) {
    // findOrCreate rather than relying on the unique index: company_id is NULL
    // for platform rows, and MySQL treats NULLs as distinct in a unique index,
    // so the index would not prevent a duplicate here.
    // eslint-disable-next-line no-await-in-loop
    await NotificationConfig.findOrCreate({
      where: { company_id: null, event_key: eventKey },
      defaults: {
        company_id: null,
        event_key: eventKey,
        enabled: true,
        notify_client: recipients.client,
        notify_realtor: recipients.realtor,
        notify_admin: recipients.admin,
        channel: 'both',
      },
    });
  }
};

const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize, NotificationConfig } = require('../models');
const {
  EVENTS, EVENT_KEYS, EVENTS_BY_KEY, CHANNELS,
  resolveNotificationConfig, unknownPermissions, usersWithPermissions,
} = require('../../../../shared/src/notificationConfig');
const { evictNotificationConfig } = require('../../../../shared/src/cacheEvict');
const { MODULES } = require('../../../../shared/src/notificationEvents');

/**
 * Configuring who hears about each event.
 *
 * A company admin configures their own company's set; the platform operator
 * configures the defaults by asking for company_id null explicitly.
 */

/** Which company's configuration this caller may touch. */
const targetCompanyId = (req) => {
  if (req.user?.isSuperiorAdmin) {
    // A superior admin editing the PLATFORM set asks for it explicitly, so
    // "no company_id" cannot silently mean "rewrite everyone's defaults".
    const raw = req.query.company_id ?? req.body?.company_id;
    if (raw === null || String(raw ?? '').toLowerCase() === 'platform') return null;
    return raw ? Number(raw) : null;
  }
  return req.user?.company_id ?? null;
};

/**
 * The effective configuration, the catalogue it is drawn from, and the
 * permissions available to target.
 *
 * `is_company_override` is the field the screen needs most: resolution is per
 * COMPANY rather than per event, so an admin has to be able to see that they
 * are currently inheriting the platform set — and that saving anything takes
 * over all of it.
 */
const getNotificationConfig = asyncHandler(async (req, res) => {
  const companyId = targetCompanyId(req);

  const own = companyId
    ? await NotificationConfig.findAll({ where: { company_id: companyId } })
    : [];
  const resolve = await resolveNotificationConfig(sequelize, companyId);

  // Everything selectable as a permission recipient, for the multi-select.
  const permissions = await sequelize.query(
    'SELECT name, display_name, module FROM permissions ORDER BY module, name',
    { type: QueryTypes.SELECT },
  );

  res.json({
    data: {
      company_id: companyId,
      is_company_override: own.length > 0,
      modules: MODULES,
      channels: CHANNELS,
      available_permissions: permissions,
      events: EVENTS.map((entry) => ({
        event_key: entry.key,
        module: entry.module,
        label: entry.label,
        description: entry.description,
        // What "subject" means for THIS event, so the UI can say "Buyer" or
        // "Author" rather than a word the admin has to decode.
        subject_label: entry.subjectLabel,
        // Which relational recipients are meaningful here. Offering "Realtor"
        // on an event with no client behind it would be noise.
        supports: entry.recipients,
        platform_default: entry.defaults,
        ...resolve(entry.key),
      })),
    },
  });
});

/**
 * Saves the company's configuration.
 *
 * Takes the WHOLE set, not one event. That is the resolution rule made explicit
 * in the API: the moment a company has any configuration, that configuration is
 * what applies and the platform set is no longer consulted for the events it
 * omitted. Accepting a single event would let an admin create an override by
 * editing one row and unknowingly switch off all the others.
 */
const saveNotificationConfig = asyncHandler(async (req, res) => {
  const companyId = targetCompanyId(req);

  const events = Array.isArray(req.body.events) ? req.body.events : null;
  if (!events) {
    return res.status(400).json({
      message: 'Send the full set of events. Because a company configuration replaces the platform '
        + 'set entirely rather than being merged into it, a partial save would switch off every event it omitted.',
    });
  }

  const unknown = events.map((e) => e.event_key).filter((key) => !EVENT_KEYS.includes(key));
  if (unknown.length) {
    return res.status(400).json({ message: `Unknown notification events: ${unknown.join(', ')}.` });
  }

  const badChannel = events.find((e) => e.channel && !CHANNELS.includes(e.channel));
  if (badChannel) {
    return res.status(400).json({
      message: `"${badChannel.channel}" is not a delivery channel. Use one of: ${CHANNELS.join(', ')}.`,
    });
  }

  /**
   * Permission names are validated against the real catalogue.
   *
   * A typo would otherwise be stored happily and then notify nobody, which
   * looks exactly like a working setting — the worst kind of failure for
   * something whose whole job is telling people.
   */
  const requested = [...new Set(events.flatMap((e) => (Array.isArray(e.permissions) ? e.permissions : [])))];
  const missing = await unknownPermissions(sequelize, requested);
  if (missing.length) {
    return res.status(400).json({
      message: `These permissions do not exist: ${missing.join(', ')}. `
        + 'A permission that does not exist would notify nobody.',
    });
  }

  const transaction = await sequelize.transaction();
  try {
    for (const event of events) {
      const entry = EVENTS_BY_KEY.get(event.event_key);
      const payload = {
        enabled: event.enabled !== false,
        // Only stored where the event actually has that recipient, so a stale
        // client cannot switch on a realtor for an event with no client.
        notify_subject: Boolean(event.subject) && Boolean(entry.recipients.subject),
        notify_realtor: Boolean(event.realtor) && Boolean(entry.recipients.realtor),
        notify_permissions: Array.isArray(event.permissions) ? [...new Set(event.permissions)] : [],
        channel: CHANNELS.includes(event.channel) ? event.channel : 'both',
      };
      // eslint-disable-next-line no-await-in-loop
      const [row, created] = await NotificationConfig.findOrCreate({
        where: { company_id: companyId, event_key: event.event_key },
        defaults: { company_id: companyId, event_key: event.event_key, ...payload, created_by: req.user?.id ?? null },
        transaction,
      });
      // eslint-disable-next-line no-await-in-loop
      if (!created) await row.update(payload, { transaction });
    }
    await transaction.commit();
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }

  /**
   * Evicted BEFORE the response is built, not after.
   *
   * resolveNotificationConfig on the next line is cached, so evicting
   * afterwards would make this endpoint return the configuration it just
   * replaced — the admin saves, sees the old values echoed back, and reasonably
   * concludes the save failed.
   */
  await evictNotificationConfig(companyId);

  const resolve = await resolveNotificationConfig(sequelize, companyId);
  res.json({
    data: {
      company_id: companyId,
      is_company_override: companyId != null,
      events: EVENT_KEYS.map((key) => ({ event_key: key, ...resolve(key) })),
    },
  });
});

/** Drops the company's configuration, returning it to the platform defaults. */
const resetNotificationConfig = asyncHandler(async (req, res) => {
  const companyId = targetCompanyId(req);
  if (!companyId) {
    return res.status(400).json({
      message: 'The platform default set cannot be reset — it IS the fallback. Edit the events instead.',
    });
  }
  await NotificationConfig.destroy({ where: { company_id: companyId } });
  // Without this the company keeps resolving against its deleted rows.
  await evictNotificationConfig(companyId);
  res.json({ message: 'Notification configuration reset to the platform defaults.' });
});

/**
 * Who would actually be notified for one event, as configured right now.
 *
 * The answer to "I selected these permissions — who is that?", which is
 * otherwise guesswork for an admin who cannot see the whole role structure.
 */
const previewRecipients = asyncHandler(async (req, res) => {
  const companyId = targetCompanyId(req);
  const eventKey = req.params.eventKey;
  if (!EVENT_KEYS.includes(eventKey)) {
    return res.status(404).json({ message: 'Unknown notification event.' });
  }

  const config = (await resolveNotificationConfig(sequelize, companyId))(eventKey);
  const entry = EVENTS_BY_KEY.get(eventKey);

  const ids = config.permissions?.length
    ? await usersWithPermissions(sequelize, { companyId, permissionNames: config.permissions })
    : [];

  const users = ids.length
    ? await sequelize.query(
      'SELECT id, name, email, type FROM users WHERE id IN (:ids) ORDER BY name',
      { replacements: { ids }, type: QueryTypes.SELECT },
    )
    : [];

  res.json({
    data: {
      event_key: eventKey,
      enabled: config.enabled,
      channel: config.channel,
      // The relational recipients cannot be listed in advance: they depend on
      // the individual invoice, post or ticket the event fires for.
      relational: {
        subject: config.subject ? entry.subjectLabel : null,
        realtor: config.realtor,
      },
      permissions: config.permissions,
      permission_recipients: users,
    },
  });
});

module.exports = {
  getNotificationConfig, saveNotificationConfig, resetNotificationConfig, previewRecipients,
};

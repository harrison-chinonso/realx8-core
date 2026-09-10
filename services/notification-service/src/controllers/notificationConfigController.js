const asyncHandler = require('../utils/asyncHandler');
const { sequelize, NotificationConfig } = require('../models');
const { EVENT_KEYS, PLATFORM_DEFAULTS, resolveNotificationConfig } = require('../../../../shared/src/notificationConfig');

/**
 * Configuring who hears about purchase-journey events (FRD 12.1).
 *
 * A company admin configures their own company's set; the platform operator
 * (a superior admin) configures the platform defaults by passing company_id
 * explicitly as null.
 */

/** Which company's configuration this caller is allowed to touch. */
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
 * The effective configuration, and whether it is the company's own.
 *
 * `is_company_override` is the field the settings screen needs most: FRD 12.1
 * resolves per COMPANY rather than per event, so an admin has to be able to see
 * that they are currently inheriting the platform set — and that saving any
 * single event will take over all of them.
 */
const getNotificationConfig = asyncHandler(async (req, res) => {
  const companyId = targetCompanyId(req);

  const own = companyId
    ? await NotificationConfig.findAll({ where: { company_id: companyId } })
    : [];
  const resolve = await resolveNotificationConfig(sequelize, companyId);

  res.json({
    data: {
      company_id: companyId,
      is_company_override: own.length > 0,
      events: EVENT_KEYS.map((eventKey) => ({
        event_key: eventKey,
        platform_default: PLATFORM_DEFAULTS[eventKey],
        ...resolve(eventKey),
      })),
    },
  });
});

/**
 * Saves the company's configuration.
 *
 * Takes the WHOLE set, not one event. That is FRD 12.1's resolution rule made
 * explicit in the API: the moment a company has any configuration, that
 * configuration is what applies and the platform set is no longer consulted for
 * the events it omitted. Accepting a single event would let an admin create a
 * company override by editing one row and unknowingly switch off the other
 * twelve.
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

  const transaction = await sequelize.transaction();
  try {
    for (const event of events) {
      // eslint-disable-next-line no-await-in-loop
      const [row, created] = await NotificationConfig.findOrCreate({
        where: { company_id: companyId, event_key: event.event_key },
        defaults: {
          company_id: companyId,
          event_key: event.event_key,
          enabled: event.enabled !== false,
          notify_client: Boolean(event.client),
          notify_realtor: Boolean(event.realtor),
          notify_admin: Boolean(event.admin),
          channel: ['in_app', 'email', 'both'].includes(event.channel) ? event.channel : 'both',
          created_by: req.user?.id ?? null,
        },
        transaction,
      });
      if (!created) {
        // eslint-disable-next-line no-await-in-loop
        await row.update({
          enabled: event.enabled !== false,
          notify_client: Boolean(event.client),
          notify_realtor: Boolean(event.realtor),
          notify_admin: Boolean(event.admin),
          channel: ['in_app', 'email', 'both'].includes(event.channel) ? event.channel : 'both',
        }, { transaction });
      }
    }
    await transaction.commit();
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }

  const resolve = await resolveNotificationConfig(sequelize, companyId);
  res.json({
    data: {
      company_id: companyId,
      is_company_override: companyId != null,
      events: EVENT_KEYS.map((eventKey) => ({ event_key: eventKey, ...resolve(eventKey) })),
    },
  });
});

/**
 * Drops the company's configuration and returns it to the platform defaults
 * (FRD 12.1's fallback).
 */
const resetNotificationConfig = asyncHandler(async (req, res) => {
  const companyId = targetCompanyId(req);
  if (!companyId) {
    return res.status(400).json({
      message: 'The platform default set cannot be reset — it IS the fallback. Edit the events instead.',
    });
  }
  await NotificationConfig.destroy({ where: { company_id: companyId } });
  res.json({ message: 'Notification configuration reset to the platform defaults.' });
});

module.exports = { getNotificationConfig, saveNotificationConfig, resetNotificationConfig };

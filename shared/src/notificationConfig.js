const { QueryTypes } = require('sequelize');
const { EVENTS, EVENTS_BY_KEY, EVENT_KEYS, CHANNELS } = require('./notificationEvents');
const { cache, KEYS, TTL } = require('./cache');

/**
 * Resolving who should hear about an event, for one company.
 *
 * The catalogue in notificationEvents.js is both the seed for the platform-level
 * rows and the last-resort fallback, so a database whose seeder has not run
 * still notifies the right people rather than nobody — the failure mode that
 * matters here is a missed OVERDUE notice, i.e. a client who did not know a fee
 * was coming.
 */

const OFF = { enabled: false, subject: false, realtor: false, permissions: [], channel: 'both' };

const rowToConfig = (row) => ({
  enabled: Boolean(row.enabled),
  subject: Boolean(row.notify_subject),
  realtor: Boolean(row.notify_realtor),
  permissions: Array.isArray(row.notify_permissions)
    ? row.notify_permissions
    : (() => { try { return JSON.parse(row.notify_permissions || '[]'); } catch { return []; } })(),
  channel: CHANNELS.includes(row.channel) ? row.channel : 'both',
});

/** The catalogue default for an event, for a database with no rows at all. */
const builtIn = (eventKey) => {
  const entry = EVENTS_BY_KEY.get(eventKey);
  if (!entry) return { ...OFF };
  return { ...entry.defaults };
};

/**
 * Resolves the whole notification set for one company.
 *
 * The important half of FRD 12.1's rule is what does NOT happen: there is no
 * per-event merge. If a company has any rows, its rows are the configuration
 * and the platform set is not consulted for the events it omitted. Merging per
 * event would mean a company that deliberately switched an event off would have
 * it switched back on by the platform default.
 *
 * Returns a function from event key to config, so a caller resolving several
 * events for one company pays for one query.
 */
const loadConfigRows = async (sequelize, companyId) => {
  let rows = [];
  // Whether the rows in hand are the COMPANY's own, which decides what an event
  // missing from them means.
  let isCompanySet = false;

  try {
    if (companyId) {
      rows = await sequelize.query(
        'SELECT * FROM notification_configs WHERE company_id = :companyId',
        { replacements: { companyId }, type: QueryTypes.SELECT },
      );
      isCompanySet = rows.length > 0;
    }
    if (!rows.length) {
      rows = await sequelize.query(
        'SELECT * FROM notification_configs WHERE company_id IS NULL',
        { type: QueryTypes.SELECT },
      );
    }
  } catch (error) {
    console.error('[notify-config] lookup failed, using the event catalogue:', error.message);
    /**
     * A failed lookup returns null so the cache does not remember it.
     *
     * Caching the fallback would turn one database blip into ten minutes of
     * every company silently running on catalogue defaults instead of its own
     * settings — a company that switched an event OFF would see it firing.
     */
    return null;
  }

  // Only the two fields the resolver needs, so the cached value stays small and
  // does not carry timestamps that change without changing the answer.
  return {
    isCompanySet,
    events: rows.map((row) => [row.event_key, rowToConfig(row)]),
  };
};

const resolveNotificationConfig = async (sequelize, companyId) => {
  /**
   * Cached because this runs on EVERY dispatched event, and a single action can
   * dispatch several — so an invoice being created re-read the same handful of
   * rows once per notice. The rows change only when an admin saves the
   * notification settings screen, which evicts this key (see
   * evictNotificationConfig).
   */
  const loaded = await cache.wrap(
    KEYS.notificationConfig(companyId),
    TTL.notificationConfig,
    () => loadConfigRows(sequelize, companyId),
  );

  const { isCompanySet, events } = loaded || { isCompanySet: false, events: [] };
  const byEvent = new Map(events);

  return (eventKey) => {
    const configured = byEvent.get(eventKey);
    if (configured) return configured;
    /**
     * What an unconfigured event means depends on WHOSE set this is.
     *
     * Where the company has its own configuration, that configuration applies
     * in place of the platform set — so an event the company left out is OFF.
     * Where we are on the platform rows, a missing event falls back to the
     * catalogue those rows were seeded from.
     */
    return isCompanySet ? { ...OFF } : builtIn(eventKey);
  };
};

/**
 * The users in a company holding ANY of `permissionNames`.
 *
 * This is what replaced "notify every admin". Three things about it matter:
 *
 *   It is COMPANY-SCOPED. A platform admin holds every permission in the
 *   catalogue and has company_id null, so an unscoped query would copy them on
 *   every event of every company on the platform. They are reachable only by
 *   configuring a platform-level event.
 *
 *   It follows ROLES, not user.type. A company that invents a "Collections
 *   Officer" role and grants it finance.payment-schedules.view has thereby
 *   chosen who hears about overdue installments, with no change here.
 *
 *   Inactive and soft-deleted users are excluded, so a departed employee stops
 *   receiving mail without anyone editing notification settings.
 */
const usersWithPermissions = async (sequelize, { companyId, permissionNames }) => {
  const names = (permissionNames || []).filter((n) => typeof n === 'string' && n.trim());
  if (!names.length) return [];

  /**
   * Cached per company and permission set. This is a four-table join that ran
   * once per notice; the answer changes only when roles, role grants or user
   * activation change, all of which evict it.
   *
   * The empty result is deliberately NOT distinguished from a failure by the
   * cache: loadRecipients returns null on error so a blip is not remembered,
   * while a genuine empty list is cached as [] because "nobody in this company
   * holds that permission" is a real and stable answer.
   */
  const loadRecipients = async () => {
    try {
      /**
       * `is_active IS TRUE`, never `= 1`.
       *
       * is_active is a BOOLEAN, and Postgres refuses to compare one against an
       * integer. MySQL stores it as tinyint and accepted the comparison, so
       * this only ever failed in production — and silently, because the catch
       * below turns a failed lookup into "nobody holds that permission".
       */
      const rows = await sequelize.query(
        `SELECT DISTINCT u.id
           FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN role_permissions rp ON rp.role_id = ur.role_id
           JOIN permissions p ON p.id = rp.permission_id
          WHERE p.name IN (:names)
            AND u.is_active IS TRUE
            AND u.deleted_at IS NULL
            AND u.company_id ${companyId ? '= :companyId' : 'IS NULL'}
          LIMIT 200`,
        { replacements: { names, companyId: companyId ?? null }, type: QueryTypes.SELECT },
      );
      return rows.map((row) => row.id);
    } catch (error) {
      console.error('[notify-config] permission recipient lookup failed:', error.message);
      return null;
    }
  };

  const recipients = await cache.wrap(
    KEYS.permissionRecipients(companyId, names),
    TTL.authorisation,
    loadRecipients,
  );
  return recipients || [];
};

/**
 * Names in `permissions` that do not exist.
 *
 * Used when saving a configuration: a typo would otherwise notify nobody and
 * look like a working setting.
 */
const unknownPermissions = async (sequelize, permissions) => {
  const names = [...new Set((permissions || []).filter(Boolean))];
  if (!names.length) return [];
  try {
    const rows = await sequelize.query(
      'SELECT name FROM permissions WHERE name IN (:names)',
      { replacements: { names }, type: QueryTypes.SELECT },
    );
    const known = new Set(rows.map((r) => r.name));
    return names.filter((n) => !known.has(n));
  } catch (error) {
    console.error('[notify-config] permission validation failed:', error.message);
    return [];
  }
};

module.exports = {
  EVENTS, EVENT_KEYS, EVENTS_BY_KEY, CHANNELS,
  resolveNotificationConfig,
  usersWithPermissions,
  unknownPermissions,
  builtIn,
  /**
   * Reminder cadence — "twice within the month" without dates in the
   * requirement, defaulted to 14 and 3 days before the due date.
   */
  REMINDER_DAYS_BEFORE: { schedule_reminder_first: 14, schedule_reminder_second: 3 },
};

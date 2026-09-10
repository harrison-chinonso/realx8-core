const { QueryTypes } = require('sequelize');

/**
 * The notification matrix and how it resolves (FRD 12).
 *
 * PLATFORM_DEFAULTS below is the FRD 12.2 table, transcribed. It is both the
 * seed for the platform-level rows and the last-resort fallback, so a database
 * with no configuration rows at all still notifies the right people rather than
 * nobody — which is the failure mode that matters here: a missed OVERDUE notice
 * is a client who did not know a fee was coming.
 */

/**
 * FRD 12.2, one entry per event.
 *
 * `client` / `realtor` / `admin` mirror the matrix's three columns. The realtor
 * entries are the ones with a stated intent behind them: FRD 12.2 wants the
 * realtor able to engage the client directly and drive collection, which is why
 * they are on every payment and schedule event rather than only the ones that
 * concern their commission.
 */
const PLATFORM_DEFAULTS = {
  invoice_created: { client: true, realtor: true, admin: false },
  payment_receipt_submitted: { client: true, realtor: false, admin: true },
  payment_approved: { client: true, realtor: true, admin: false },
  payment_rejected: { client: true, realtor: true, admin: false },
  invoice_fully_paid: { client: true, realtor: true, admin: true },
  // Twice within the month for each schedule approaching its due date.
  schedule_reminder_first: { client: true, realtor: true, admin: false },
  schedule_reminder_second: { client: true, realtor: true, admin: false },
  schedule_due: { client: true, realtor: true, admin: false },
  schedule_in_grace: { client: true, realtor: true, admin: false },
  schedule_overdue: { client: true, realtor: true, admin: true },
  availability_reduced: { client: true, realtor: true, admin: true },
  invoice_cancelled: { client: true, realtor: true, admin: false },
  payment_plan_completed: { client: true, realtor: true, admin: true },
};

const EVENT_KEYS = Object.keys(PLATFORM_DEFAULTS);

/**
 * Reminder cadence — FRD 12.2 asks for twice within the month without naming
 * the days, and FRD 15.4 defaults them to 14 and 3 days before the due date.
 */
const REMINDER_DAYS_BEFORE = { schedule_reminder_first: 14, schedule_reminder_second: 3 };

const rowToConfig = (row) => ({
  enabled: Boolean(row.enabled),
  client: Boolean(row.notify_client),
  realtor: Boolean(row.notify_realtor),
  admin: Boolean(row.notify_admin),
  channel: row.channel || 'both',
});

const builtIn = (eventKey) => {
  const matrix = PLATFORM_DEFAULTS[eventKey];
  if (!matrix) return { enabled: false, client: false, realtor: false, admin: false, channel: 'both' };
  return { enabled: true, ...matrix, channel: 'both' };
};

/**
 * Resolves the whole notification set for one company.
 *
 * The resolution rule is FRD 12.1's, and the important half of it is what does
 * NOT happen: there is no per-event merge. If a company has any rows, its rows
 * are the configuration and the platform set is not consulted for the events it
 * omitted. Merging per event would mean a company that deliberately switched an
 * event off would have it switched back on by the platform default.
 *
 * Returns a function from event key to config, so a caller resolving several
 * events for one company pays for one query.
 */
const OFF = { enabled: false, client: false, realtor: false, admin: false, channel: 'both' };

const resolveNotificationConfig = async (sequelize, companyId) => {
  let rows = [];
  // Whether the rows in hand are the COMPANY's own, which decides what an
  // event missing from them means. See below.
  let isCompanySet = false;

  try {
    if (companyId) {
      rows = await sequelize.query(
        'SELECT * FROM notification_configs WHERE company_id = :companyId',
        { replacements: { companyId }, type: QueryTypes.SELECT },
      );
      isCompanySet = rows.length > 0;
    }
    // Per-company, not per-event: only an EMPTY company set falls back.
    if (!rows.length) {
      rows = await sequelize.query(
        'SELECT * FROM notification_configs WHERE company_id IS NULL',
        { type: QueryTypes.SELECT },
      );
    }
  } catch (error) {
    // The table may not exist yet on a database that has not run the seeder.
    // The built-in matrix is the same set, so this degrades to correct
    // behaviour rather than to silence.
    console.error('[notify-config] lookup failed, using the platform matrix:', error.message);
  }

  const byEvent = new Map(rows.map((row) => [row.event_key, rowToConfig(row)]));

  return (eventKey) => {
    const configured = byEvent.get(eventKey);
    if (configured) return configured;
    /**
     * What an unconfigured event means depends on WHOSE set this is, and
     * getting it wrong is the whole substance of FRD 12.1.
     *
     * Where the company has its own configuration, that configuration applies
     * "in place of the platform set" — so an event the company left out is OFF.
     * Falling back to the platform default per event would merge the two, and a
     * company that deliberately switched an event off would have it switched
     * back on by the default it was trying to override.
     *
     * Where we are already on the platform rows, a missing event falls back to
     * the built-in matrix, which is the same table those rows were seeded from
     * — so a database whose seeder has not run still notifies the right people.
     */
    return isCompanySet ? OFF : builtIn(eventKey);
  };
};

module.exports = {
  PLATFORM_DEFAULTS,
  EVENT_KEYS,
  REMINDER_DAYS_BEFORE,
  resolveNotificationConfig,
  builtIn,
};

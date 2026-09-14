const { QueryTypes } = require('sequelize');

/**
 * When a buyer is reminded that an installment is coming, or late.
 *
 * ── Three levels, most specific first ───────────────────────────────────────
 *
 *   the invoice's own schedule   -> this invoice, however it was assigned
 *   the company's default        -> every invoice the company raises
 *   the platform's default       -> every company that has not chosen
 *   the built-in                 -> when nothing is configured at all
 *
 * A company that edits the platform default does not edit the platform's — it
 * gets one of its own, which is what makes the platform's a default rather than
 * a shared setting. Editing a company's schedule changes what happens NEXT for
 * every invoice on it; reminders already sent are recorded and are not
 * revisited.
 */

/**
 * Days relative to the due date. Negative is before, 0 is the day itself,
 * positive is after.
 *
 * One week out is a heads-up, two days out is a prompt, the due date is the
 * fact, and two days late is the first chase. Past that a person should be
 * making the decision rather than a schedule.
 */
const BUILT_IN_OFFSETS = [-7, -2, 0, 2];

/** What a usable schedule looks like, whatever level it came from. */
const normalise = (row, source) => {
  let offsets = BUILT_IN_OFFSETS;
  try {
    const parsed = typeof row?.offsets === 'string' ? JSON.parse(row.offsets) : row?.offsets;
    if (Array.isArray(parsed) && parsed.length) {
      offsets = parsed
        .map((entry) => (typeof entry === 'object' ? Number(entry.days) : Number(entry)))
        .filter((days) => Number.isFinite(days))
        .sort((a, b) => a - b);
    }
  } catch {
    // A schedule whose offsets will not parse falls back to the built-in rather
    // than silently reminding nobody.
  }
  return {
    id: row?.id ?? null,
    name: row?.name ?? 'Default reminder schedule',
    source,
    offsets: offsets.length ? offsets : BUILT_IN_OFFSETS,
  };
};

/**
 * The schedule in force for one invoice.
 *
 * Never throws: a reminder job that dies on a lookup stops reminding everybody,
 * which is worse than reminding them on the built-in pattern.
 */
const scheduleForInvoice = async (sequelize, { invoiceId, companyId }) => {
  try {
    if (invoiceId) {
      const [own] = await sequelize.query(
        `SELECT s.id, s.name, s.offsets
           FROM invoices i
           JOIN reminder_schedules s ON s.id = i.reminder_schedule_id
          WHERE i.id = :invoiceId AND s.is_active IS TRUE
          LIMIT 1`,
        { replacements: { invoiceId }, type: QueryTypes.SELECT },
      );
      if (own) return normalise(own, 'invoice');
    }

    if (companyId) {
      const [company] = await sequelize.query(
        `SELECT id, name, offsets FROM reminder_schedules
          WHERE company_id = :companyId AND is_default IS TRUE AND is_active IS TRUE
          ORDER BY id DESC LIMIT 1`,
        { replacements: { companyId }, type: QueryTypes.SELECT },
      );
      if (company) return normalise(company, 'company');
    }

    const [platform] = await sequelize.query(
      `SELECT id, name, offsets FROM reminder_schedules
        WHERE company_id IS NULL AND is_default IS TRUE AND is_active IS TRUE
        ORDER BY id DESC LIMIT 1`,
      { type: QueryTypes.SELECT },
    );
    if (platform) return normalise(platform, 'platform');
  } catch (error) {
    console.error('[reminders] schedule lookup failed, using the built-in:', error.message);
  }

  return normalise(null, 'built-in');
};

/** Midnight, so a comparison is about the DAY rather than the hour a job ran. */
const startOfDay = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date;
};

/** Whole days from `from` to `to`, ignoring the time of day. */
const daysBetween = (from, to) => {
  const a = startOfDay(from);
  const b = startOfDay(to);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
};

/**
 * Which offsets are due to be sent for an installment today.
 *
 * ── Nothing is sent for an installment that has been paid ───────────────────
 *
 * The rule the whole feature rests on: a reminder is a request for money, and
 * asking somebody for money they have already sent is the fastest way to make
 * them distrust every other message. `outstandingMinor` is what is still owed
 * on THAT installment — not on the invoice — so a buyer who is up to date on
 * this month hears nothing, even with later months outstanding.
 *
 * ── Catching up without shouting ────────────────────────────────────────────
 *
 * A job that did not run for a week must not send four reminders at once. Only
 * the LATEST offset now due is returned, so a missed window is closed quietly
 * rather than replayed.
 *
 * @param {number[]} alreadySent  offsets already sent for this installment
 */
const offsetsDueToday = ({
  offsets, dueDate, outstandingMinor, alreadySent = [], now = new Date(),
}) => {
  if (Number(outstandingMinor) <= 0) return [];

  const elapsed = daysBetween(dueDate, now);
  if (elapsed === null) return [];

  const sent = new Set(alreadySent.map(Number));
  const reached = (offsets || [])
    .filter((days) => !sent.has(Number(days)))
    .filter((days) => elapsed >= days)
    .sort((a, b) => a - b);

  return reached.length ? [reached[reached.length - 1]] : [];
};

/** How a reminder describes itself, given how far from the due date it is. */
const describeOffset = (days) => {
  if (days < -1) return `${Math.abs(days)} days before it is due`;
  if (days === -1) return 'the day before it is due';
  if (days === 0) return 'on the day it is due';
  if (days === 1) return 'a day late';
  return `${days} days late`;
};

module.exports = {
  BUILT_IN_OFFSETS,
  scheduleForInvoice,
  offsetsDueToday,
  describeOffset,
  daysBetween,
};

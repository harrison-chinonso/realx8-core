const { QueryTypes } = require('sequelize');
const { columnsOf, tableExists, q } = require('../../../../shared/src/dialect');
const { BUILT_IN_OFFSETS } = require('../../../../shared/src/reminderSchedule');

/**
 * Puts the platform's default reminder schedule in the database, and carries
 * the reminders already sent into the new per-offset record.
 *
 * ── Why the default is a ROW and not a constant ─────────────────────────────
 *
 * The built-in offsets exist in code as a last resort, but the whole feature is
 * that a company can change them — and a company changes them by editing what
 * it sees. If the platform default were only a constant, the first edit would
 * have nothing to copy from and the screen would have nothing to show. A row
 * makes "the default" an object that can be read, displayed, copied and
 * overridden, which is what every level above it needs.
 *
 * ── The old two-column tracking ─────────────────────────────────────────────
 *
 * Reminders used to be recorded as `reminder_first_sent_at` and
 * `reminder_second_sent_at` on the schedule row, at fixed offsets. Those two
 * are translated into rows in schedule_reminder_sends at the offsets they
 * actually represented, so a buyer part way through a plan is not sent a
 * reminder they already had the day this ships. The columns are left in place:
 * they are the evidence of what was sent under the old system, and nothing
 * reads them any more.
 *
 * Idempotent throughout — it inserts only what is missing, so every boot after
 * the first does nothing.
 */

/** What the old columns meant, in days before the due date. */
const LEGACY_OFFSETS = { reminder_first_sent_at: -7, reminder_second_sent_at: -3 };

module.exports = async (sequelize) => {
  try {
    if (!(await tableExists(sequelize, 'reminder_schedules'))) return;

    const schedules = q(sequelize, 'reminder_schedules');

    const [existing] = await sequelize.query(
      `SELECT id FROM ${schedules} WHERE company_id IS NULL AND is_default IS TRUE LIMIT 1`,
      { type: QueryTypes.SELECT },
    );

    if (!existing) {
      await sequelize.query(
        `INSERT INTO ${schedules} (name, company_id, offsets, is_default, is_active, description, created_at, updated_at)
         VALUES (:name, NULL, :offsets, TRUE, TRUE, :description, NOW(), NOW())`,
        {
          replacements: {
            name: 'Standard reminders',
            offsets: JSON.stringify(BUILT_IN_OFFSETS),
            description: 'A week before, two days before, on the due date, and two days late. '
              + 'Companies that want something different get a copy of this to edit.',
          },
          type: QueryTypes.INSERT,
        },
      );
      console.log('[finance] reminder_schedules: platform default created');
    }
  } catch (error) {
    console.warn('[finance] reminder schedule seed skipped:', error.message);
  }

  // ── carry the old sends across ───────────────────────────────────────────
  try {
    if (!(await tableExists(sequelize, 'schedule_reminder_sends'))) return;
    const columns = await columnsOf(sequelize, 'payment_schedules');
    if (!columns) return;

    const sends = q(sequelize, 'schedule_reminder_sends');
    const paymentSchedules = q(sequelize, 'payment_schedules');

    for (const [column, offset] of Object.entries(LEGACY_OFFSETS)) {
      if (!columns.has(column)) continue;

      /**
       * NOT EXISTS rather than INSERT IGNORE / ON CONFLICT: the two engines
       * spell those differently, and the condition is cheap here because the
       * source set is only schedules that were actually reminded.
       */
      // eslint-disable-next-line no-await-in-loop
      const [, metadata] = await sequelize.query(
        `INSERT INTO ${sends} (payment_schedule_id, invoice_id, offset_days, sent_at, company_id, created_at)
         SELECT ps.id, ps.invoice_id, :offset, ps.${column}, ps.company_id, NOW()
           FROM ${paymentSchedules} ps
          WHERE ps.${column} IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM ${sends} s
               WHERE s.payment_schedule_id = ps.id AND s.offset_days = :offset
            )`,
        { replacements: { offset }, type: QueryTypes.INSERT },
      );
      const moved = Number(metadata?.rowCount ?? metadata?.affectedRows ?? metadata ?? 0);
      if (moved) console.log(`[finance] schedule_reminder_sends: ${moved} legacy ${column} carried across`);
    }
  } catch (error) {
    console.warn('[finance] legacy reminder carry-over skipped:', error.message);
  }
};

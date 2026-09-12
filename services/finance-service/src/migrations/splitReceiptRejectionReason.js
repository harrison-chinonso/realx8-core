const { columnsOf, q } = require('../../../../shared/src/dialect');

/**
 * Moves existing rejection reasons out of receipts.notes and into their own
 * column.
 *
 * Rejecting a payment used to write the admin's reason over `notes` — the
 * buyer's own note from when they submitted. Two costs: whatever the buyer had
 * written was destroyed, and afterwards nothing distinguished "the buyer said
 * this" from "an admin said this", so neither could be shown honestly.
 *
 * The column itself arrives via sync({ alter: true }), which finance-service
 * runs and which does add missing columns — unlike user-service's
 * { force: false }. This only has to carry the data across, which sync will
 * never do.
 *
 * Only `rejected` rows are touched, because only on those is `notes` known to
 * hold a reason. On every other status it is the buyer's note and must be left
 * exactly where it is.
 *
 * Idempotent: it fills only rows whose rejection_reason is still empty, so a
 * reason an admin has since rewritten is never reverted to the old copy.
 */

/** mysql2 reports affectedRows; pg reports rowCount. Read both. */
const affectedBy = (result, metadata) => Number(
  result?.affectedRows
  ?? (typeof metadata === 'number' ? metadata : metadata?.rowCount ?? metadata?.affectedRows)
  ?? 0,
);

module.exports = async (sequelize) => {
  const columns = await columnsOf(sequelize, 'receipts');
  // No table yet, or sync has not added the column — nothing to carry across.
  if (!columns || !columns.has('rejection_reason') || !columns.has('notes')) return;

  const receipts = q(sequelize, 'receipts');

  try {
    const [result, metadata] = await sequelize.query(
      `UPDATE ${receipts}
          SET rejection_reason = notes
        WHERE status = 'rejected'
          AND notes IS NOT NULL
          AND TRIM(notes) <> ''
          AND (rejection_reason IS NULL OR TRIM(rejection_reason) = '')`,
    );
    const moved = affectedBy(result, metadata);
    if (moved) console.log(`[finance] receipts: ${moved} rejection reason(s) moved out of notes`);
  } catch (error) {
    // A data tidy-up must never stop the service booting.
    console.warn('[finance] receipt rejection reason split skipped:', error.message);
  }
};

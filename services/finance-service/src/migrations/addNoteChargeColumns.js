const { columnsOf, quoteIdent, isPostgres } = require('../../../../shared/src/dialect');

/**
 * What a note is FOR, and how the party paid it.
 *
 * ── Why a note needs to know its source ────────────────────────────────────
 *
 * A credit note raised because a realtor asked to be verified is not a note
 * somebody typed: approving its payment has to approve the verification too.
 * That needs a link back, and it needs to be a pair of plain columns rather
 * than a reference squeezed into `reason`, because the approval path reads it
 * and free text is not something to route money decisions on.
 *
 * The overpayment refunds already carry
 * source_payment_id, but a note raised for any other reason has nowhere to say
 * so, and use cases beyond these two are expected.
 *
 * ── Why the proof lives on the note ────────────────────────────────────────
 *
 * A realtor paying a fee has no invoice — the note IS the bill — so there is
 * no invoice_payments row to hang a receipt on. Three columns on the note say
 * what was uploaded, what reference it carried and when it arrived; an admin
 * approving it settles the note through the existing settle path, so the money
 * reaches the ledger the same way every other settlement does.
 *
 * reminder_sent_at is for the other direction: a client chasing a refund the
 * company owes them, throttled to one reminder a day.
 *
 * Idempotent, and written for both engines.
 */
const COLUMNS = {
  credit_notes: [
    ['source_type', 'VARCHAR(40)'],
    ['source_id', 'INTEGER'],
    ['payment_proof_url', 'VARCHAR(500)'],
    ['payment_reference', 'VARCHAR(255)'],
    ['payment_submitted_at', 'TIMESTAMP'],
  ],
};

module.exports = async function addNoteChargeColumns(sequelize) {
  const stamp = isPostgres(sequelize) ? 'TIMESTAMP' : 'DATETIME';

  for (const [table, columns] of Object.entries(COLUMNS)) {
    // eslint-disable-next-line no-await-in-loop
    /*
     * `columnsOf` answers NULL for a table that is not there, not an empty
     * map. debit_notes was retired in ACC-0.6, and on a database built fresh
     * from the models it simply does not exist — reading `.size` off null took
     * the whole boot down, which is how this was found.
     */
    const existing = await columnsOf(sequelize, table).catch(() => null);
    if (!existing || !existing.size) continue;

    for (const [name, type] of columns) {
      if (existing.has(name)) continue;
      // eslint-disable-next-line no-await-in-loop
      await sequelize.query(
        `ALTER TABLE ${quoteIdent(sequelize, table)}
           ADD COLUMN ${quoteIdent(sequelize, name)} ${type === 'TIMESTAMP' ? stamp : type} NULL`,
      ).catch((error) => {
        if (!/duplicate column|already exists/i.test(error.message)) throw error;
      });
      console.log(`[migration] ${table}.${name} added`);
    }
  }
};

const { QueryTypes } = require('sequelize');
const { toMinor } = require('./money');

/**
 * What an approved credit note takes off an invoice (ACC-0.4).
 *
 * ── The behaviour that was missing ──────────────────────────────────────────
 *
 * `credit_notes` existed, had a whole approval machinery, and did nothing.
 * Settling one set its status to `used` and wrote no transaction, touched no
 * balance and moved no money — while the table was simultaneously being used
 * for realtor fees, which are the opposite instrument. The fees are now
 * invoices (ACC-0.1); this is the other half, which makes the credit note the
 * thing its name says it is: the document that REDUCES what a client owes.
 *
 * ── Why it is spread as a discount rather than modelled separately ──────────
 *
 * The platform already has the concept of "a reduction against what is owed,
 * which does not change the agreed price": `invoices.discount`, spread across
 * unpaid schedules by shared/src/invoiceDiscount.js, subtracted by payableFor,
 * reported alongside `total` by outstandingFor. Every screen, every balance and
 * the whole purchase journey already understand it.
 *
 * A credit note is that same idea arrived at by a different route — a price
 * reduction after the fact, a cancelled portion, an overcharge corrected. So
 * it joins the existing term rather than inventing a parallel one that every
 * balance calculation would then have to learn about separately. The invoice
 * total is still never touched, which is what keeps "what was this sold for"
 * answerable.
 *
 * ── Which statuses count ────────────────────────────────────────────────────
 *
 * `approved` and `used`. A note is approved when somebody with the authority
 * signed it off, and that is the moment the client stops owing the money — not
 * the later bookkeeping step that marks it consumed. `pending_approval` counts
 * for nothing, which is the point of the approval.
 */

const COUNTING_STATUSES = ['approved', 'used'];

/**
 * The total credit approved against one invoice, in minor units.
 *
 * Never throws: a balance is worth showing without this if the table is
 * unreadable, and a credit that fails to load understates the reduction rather
 * than overstating it — the safe direction, since the alternative would tell a
 * client they owe less than they do.
 */
const approvedCreditMinor = async (sequelize, invoiceId, { transaction = null } = {}) => {
  if (!invoiceId) return 0;
  try {
    const [row] = await sequelize.query(
      `SELECT COALESCE(SUM(amount), 0) AS credited
         FROM credit_notes
        WHERE invoice_id = :invoiceId AND status IN (:statuses)`,
      {
        replacements: { invoiceId, statuses: COUNTING_STATUSES },
        type: QueryTypes.SELECT,
        transaction,
      },
    );
    return toMinor(row?.credited || 0);
  } catch (error) {
    console.error(`[credit-note] could not read the credit on invoice ${invoiceId}: ${error.message}`);
    return 0;
  }
};

/** The same, for several invoices at once. Returns a Map of id → minor units. */
const approvedCreditByInvoice = async (sequelize, invoiceIds = [], { transaction = null } = {}) => {
  const ids = [...new Set(invoiceIds.map(Number).filter(Boolean))];
  if (!ids.length) return new Map();
  try {
    const rows = await sequelize.query(
      `SELECT invoice_id, COALESCE(SUM(amount), 0) AS credited
         FROM credit_notes
        WHERE invoice_id IN (:ids) AND status IN (:statuses)
        GROUP BY invoice_id`,
      {
        replacements: { ids, statuses: COUNTING_STATUSES },
        type: QueryTypes.SELECT,
        transaction,
      },
    );
    return new Map(rows.map((row) => [Number(row.invoice_id), toMinor(row.credited || 0)]));
  } catch (error) {
    console.error(`[credit-note] could not read credits: ${error.message}`);
    return new Map();
  }
};

module.exports = { approvedCreditMinor, approvedCreditByInvoice, COUNTING_STATUSES };

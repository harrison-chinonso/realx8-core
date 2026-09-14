const { setDeleteRule } = require('../../../../shared/src/foreignKeyRule');

/**
 * Stop a receipt being deleted along with the payment it produced.
 *
 * `receipts.invoice_payment_id` referenced `invoice_payments.id` ON DELETE
 * CASCADE, so removing a payment row also removed the receipt — and with it the
 * buyer's uploaded proof of payment, the record of who verified it and when,
 * and the receipt the company issued back. The entire evidence trail for a
 * payment, deleted as a side effect of deleting the payment.
 *
 * Worse, it is reachable from further up: invoice_payments itself cascades from
 * invoices, so removing one invoice would silently take every receipt on it.
 *
 * SET NULL rather than RESTRICT. The column is nullable and a receipt is
 * perfectly meaningful without a payment — that is its state for the whole time
 * it sits pending. A receipt whose payment has been removed goes back to
 * describing a claim with no payment behind it, which is the truth rather than
 * a dangling reference.
 *
 * ── Why a migration and not just the model ──────────────────────────────────
 *
 * The association now declares SET NULL, which is what a database built from
 * scratch will get. `sync({ alter: true })` does not rewrite the delete rule of
 * a constraint that already exists, so every installed database keeps CASCADE
 * until something explicitly changes it. That is this.
 *
 * Idempotent on both engines: it reads the current rule first and does nothing
 * when it is already SET NULL. The engine-specific half — where each database
 * keeps its delete rules, and how each spells "drop this constraint" — lives in
 * shared/src/foreignKeyRule.js, which this and the media_posts migration share.
 */

module.exports = async (sequelize) => {
  const result = await setDeleteRule(sequelize, {
    table: 'receipts',
    column: 'invoice_payment_id',
    references: 'invoice_payments',
    rule: 'SET NULL',
  });

  if (result.changed) {
    console.log('[receipts] invoice_payment_id no longer cascades — a receipt now '
      + 'survives the deletion of its payment');
  }
};

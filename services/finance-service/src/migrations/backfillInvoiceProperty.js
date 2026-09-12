const { isPostgres, columnsOf } = require('../../../../shared/src/dialect');

/**
 * Fills invoices.property_id from the purchase request that raised the invoice.
 *
 * The column has existed for a while and the purchase flow has always set it,
 * but invoices raised before it did — and any raised by hand against a purchase
 * — carry NULL. The buyer then sees an invoice that cannot say what it is for,
 * which is the whole complaint this answers.
 *
 * Hand-raised invoices with no purchase behind them are LEFT null on purpose:
 * a fee or a penalty is a real invoice that is not for a property, and giving
 * it a borrowed property_id would be worse than an empty one.
 *
 * Idempotent — only touches rows where property_id IS NULL, so it is safe on
 * every boot and cannot overwrite a value someone set deliberately.
 */

/**
 * Only unambiguous requests are used.
 *
 * An invoice normally has exactly one purchase request. Where a duplicate
 * exists they could disagree about the property, and picking one at random is
 * how an invoice ends up confidently labelled with the wrong thing — so a
 * conflicting pair is skipped and left visible as a null.
 */
const SOURCE = `
  SELECT invoice_id, MIN(property_id) AS property_id
    FROM property_purchase_requests
   WHERE invoice_id IS NOT NULL AND property_id IS NOT NULL
   GROUP BY invoice_id
  HAVING COUNT(DISTINCT property_id) = 1`;

/** mysql2 reports affectedRows; pg reports rowCount. Read both. */
const affectedBy = (result, metadata) => Number(
  result?.affectedRows
  ?? (typeof metadata === 'number' ? metadata : metadata?.rowCount ?? metadata?.affectedRows)
  ?? 0,
);

module.exports = async (sequelize) => {
  /**
   * Both tables have to be there.
   *
   * property_purchase_requests belongs to property-service, and in a split
   * deployment it can be in another database entirely — in which case there is
   * nothing to read and this is not a failure.
   */
  const [invoices, requests] = await Promise.all([
    columnsOf(sequelize, 'invoices'),
    columnsOf(sequelize, 'property_purchase_requests'),
  ]);
  if (!invoices || !requests) return;
  if (!invoices.has('property_id')) return;

  const sql = isPostgres(sequelize)
    ? `UPDATE invoices i
          SET property_id = src.property_id
         FROM (${SOURCE}) src
        WHERE i.id = src.invoice_id
          AND i.property_id IS NULL`
    : `UPDATE invoices i
         JOIN (${SOURCE}) src ON src.invoice_id = i.id
          SET i.property_id = src.property_id
        WHERE i.property_id IS NULL`;

  try {
    const [result, metadata] = await sequelize.query(sql);
    const filled = affectedBy(result, metadata);
    if (filled) console.log(`[finance] invoices: property_id backfilled on ${filled} row(s)`);
  } catch (error) {
    // A backfill must never stop the service booting.
    console.warn('[finance] invoice property backfill skipped:', error.message);
  }
};

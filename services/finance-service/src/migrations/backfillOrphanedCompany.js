const { backfillCompany } = require('../../../../shared/src/backfillCompany');

/**
 * Attaches finance rows that lost their company to the one they belong to.
 *
 * ── What was actually wrong ─────────────────────────────────────────────────
 *
 * A paid invoice, its four payments and their ledger entries all carried
 * company_id NULL. Every company-scoped read skipped them, so ₦530,000 of
 * genuinely received money was missing from the revenue report — while the
 * invoice sat in the database marked paid. Nothing reported a problem, because
 * from the report's point of view the rows did not exist.
 *
 * ── The order is not arbitrary ──────────────────────────────────────────────
 *
 * Invoices are attached FIRST, because payments and schedules derive their
 * company from the invoice. Running them the other way round would leave a
 * payment unable to inherit from an invoice that had not been fixed yet, and
 * the second run would be needed to finish what the first started.
 */
module.exports = async (sequelize) => {
  const results = [];

  /**
   * An invoice's client proves ownership more directly than its property: a
   * company sells its own stock, but a property could in principle be listed by
   * one company and invoiced by another. The client is who the invoice is FOR.
   */
  results.push(await backfillCompany(sequelize, {
    table: 'invoices',
    label: 'invoices',
    sources: [
      { join: 'users', on: 'client_id', column: 'company_id', label: 'its client' },
      { join: 'properties', on: 'property_id', column: 'company_id', label: 'its property' },
    ],
  }));

  // Everything below hangs off an invoice, which is now attached.
  for (const table of ['invoice_payments', 'invoice_payment_plans', 'payment_schedules', 'receipts']) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await backfillCompany(sequelize, {
      table,
      sources: [{ join: 'invoices', on: 'invoice_id', column: 'company_id', label: 'its invoice' }],
    }));
  }

  /**
   * A transaction names the user it was recorded against, and that is the only
   * thing on it that proves a company. Where the user has none either, the row
   * is left alone and counted.
   */
  results.push(await backfillCompany(sequelize, {
    table: 'transactions',
    sources: [{ join: 'users', on: 'user_id', column: 'company_id', label: 'its user' }],
  }));

  const fixed = results.reduce((total, row) => total + (row.fixed || 0), 0);
  if (fixed) console.log(`[finance] ${fixed} orphaned row(s) attached to a company`);
  return results;
};

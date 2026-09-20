const { QueryTypes } = require('sequelize');
const { postEvent, recognitionFor } = require('../../../../shared/src/accounting/posting');
const { toMinor } = require('../../../../shared/src/money');
const { nextNumber } = require('../../../../shared/src/documentSequence');

/**
 * Invoice creation on behalf of a property purchase.
 *
 * finance-service OWNS the invoices table; this writes to it directly because
 * all services share one database and the purchase + invoice must commit
 * atomically — a purchase recorded without its invoice (or vice versa) would be
 * worse than the coupling. Kept in one file so the dependency is obvious.
 *
 * ── The number comes from the shared sequence, not from this file ───────────
 *
 * It used to be worked out here, by reading the most recently inserted invoice
 * and adding one:
 *
 *     SELECT invoice_id FROM invoices ORDER BY id DESC LIMIT 1
 *
 * Two things are wrong with that, and both of them bite in production rather
 * than in a fresh database.
 *
 * It reads the LATEST ROW instead of the HIGHEST NUMBER. Those are the same
 * thing only while every invoice ever created is still present and was created
 * in order. One deleted invoice, one imported row, one number issued by
 * finance-service's own counter, and the two diverge for good.
 *
 * And it is COMPANY-BLIND, while the uniqueness it has to satisfy is not:
 * `ux_invoices_company_reference` is on (company_id, invoice_id). So it read
 * some other company's latest invoice and proposed a number that was already
 * taken in this one.
 *
 * The observed failure: company 1's highest number was INV-0005 while its
 * newest row was INV-0003, so every purchase proposed INV-0004 and the insert
 * was refused — permanently, for that company, until somebody happened to
 * create an invoice through finance-service instead. It surfaced as
 * "ux_invoices_company_reference already exists", which reads like a schema
 * problem and is in fact a duplicate value.
 *
 * shared/src/documentSequence.js is the counter finance-service already uses:
 * per company, seeded from the highest number actually in use, and backed by
 * the unique index rather than trusting itself. Using it here means there is
 * one way to number a document instead of two that agree until they don't.
 */

/** Creates an invoice row and returns { id, invoice_id }. */
const createInvoiceForPurchase = async (sequelize, transaction, {
  clientId, propertyId, amount, companyId, createdBy, dueDays = 14,
}) => {
  const invoiceRef = await nextNumber(sequelize, {
    docType: 'invoice',
    table: 'invoices',
    field: 'invoice_id',
    prefix: 'INV-',
    companyId,
    // The caller's transaction, so the number and the row it goes on commit
    // together — and so the counter is rolled back with the purchase if the
    // purchase fails.
    transaction,
  });
  const dueDate = new Date(Date.now() + dueDays * 24 * 60 * 60 * 1000);

  await sequelize.query(
    `INSERT INTO invoices (invoice_id, client_id, property_id, amount, due_date, status, discount, created_by, company_id, created_at)
     VALUES (:invoiceRef, :clientId, :propertyId, :amount, :dueDate, 'sent', 0, :createdBy, :companyId, NOW())`,
    {
      replacements: { invoiceRef, clientId, propertyId, amount, dueDate, createdBy, companyId },
      type: QueryTypes.INSERT,
      transaction,
    },
  );

  /**
   * Scoped to the company, like the index it reads back through. Without it
   * this returns whichever company's invoice happens to share the reference —
   * which is exactly the confusion the per-company numbering exists to end.
   */
  const [row] = await sequelize.query(
    `SELECT id, invoice_id FROM invoices
      WHERE invoice_id = :invoiceRef
        AND company_id ${companyId == null ? 'IS NULL' : '= :companyId'}
      LIMIT 1`,
    { replacements: { invoiceRef, companyId }, type: QueryTypes.SELECT, transaction },
  );

  /*
   * ACC-3.1: the sale, in the general ledger.
   *
   * Dr AR, Cr VAT output, and the remaining credit to either revenue or
   * CONTRACT LIABILITY depending on when this property recognises revenue.
   * The default is on handover — for an off-plan unit the invoice and the
   * handover are years apart, and IFRS 15 asks when control passes rather
   * than when the paperwork was raised. Recognising here would report a
   * completed sale on a hole in the ground.
   *
   * No VAT leg: the purchase journey prices a unit inclusive and does not
   * carry a separate output-tax figure, so inventing one here would be
   * inventing a liability. ACC-5.6's VAT return is where that gets settled.
   *
   * Inside the purchase's own transaction, so the sale and its journal commit
   * together or neither does.
   */
  await postEvent(sequelize, {
    rule: 'invoice',
    companyId: companyId ?? null,
    entryDate: new Date(),
    source: 'invoice',
    sourceId: String(row?.id ?? invoiceRef),
    memo: `Invoice ${invoiceRef} raised`,
    createdBy,
    input: {
      grossMinor: toMinor(amount),
      recognition: await recognitionFor(sequelize, { propertyId, companyId }),
      dimensions: {
        property_id: propertyId ?? null,
        party_id: clientId ?? null,
        party_type: 'client',
      },
    },
  }, { transaction });

  return row;
};

module.exports = { createInvoiceForPurchase };

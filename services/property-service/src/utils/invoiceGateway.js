const { QueryTypes } = require('sequelize');

/**
 * Invoice creation on behalf of a property purchase.
 *
 * finance-service OWNS the invoices table; this writes to it directly because
 * all services share one database and the purchase + invoice must commit
 * atomically — a purchase recorded without its invoice (or vice versa) would be
 * worse than the coupling. Kept in one file so the dependency is obvious.
 *
 * The invoice_id sequence mirrors finance-service's buildSequence ("INV-0001").
 */

const nextInvoiceRef = async (sequelize, transaction) => {
  const rows = await sequelize.query(
    'SELECT invoice_id FROM invoices ORDER BY id DESC LIMIT 1 FOR UPDATE',
    { type: QueryTypes.SELECT, transaction },
  );
  const current = Number(String(rows[0]?.invoice_id || '').split('-').pop()) || 0;
  return `INV-${String(current + 1).padStart(4, '0')}`;
};

/** Creates an invoice row and returns { id, invoice_id }. */
const createInvoiceForPurchase = async (sequelize, transaction, {
  clientId, propertyId, amount, companyId, createdBy, dueDays = 14,
}) => {
  const invoiceRef = await nextInvoiceRef(sequelize, transaction);
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

  const [row] = await sequelize.query(
    'SELECT id, invoice_id FROM invoices WHERE invoice_id = :invoiceRef LIMIT 1',
    { replacements: { invoiceRef }, type: QueryTypes.SELECT, transaction },
  );
  return row;
};

module.exports = { createInvoiceForPurchase };

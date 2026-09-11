module.exports = (sequelize, DataTypes) => {
      const Invoice = sequelize.define('Invoice', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

invoice_id: { type: DataTypes.STRING, allowNull: false },
client_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
property_id: { type: DataTypes.INTEGER.UNSIGNED },
amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
due_date: { type: DataTypes.DATE },
// 'payment_under_review' sits between sent and paid: the buyer has uploaded
// proof of payment and an admin has not yet confirmed it.
//
// 'sent' is what FRD 6 calls PENDING_PAYMENT — issued, nothing approved yet,
// and (since FRD 10.1) holding no inventory. 'partially_paid' and 'expired'
// are the two states the purchase journey added:
//
//   partially_paid  an approved payment landed and a balance remains. Was
//                   indistinguishable from 'sent' before, which is why an
//                   installment invoice mid-plan looked untouched.
//   expired         auto-expired unpaid after the company's configured window
//                   (FRD 15.6). Off unless a company sets one, so no existing
//                   invoice moves here on its own.
//
// The FRD's status set is a subset: 'draft' (not yet issued) and
// 'payment_under_review' (the admin review queue) have no FRD equivalent but
// the invoicing screens and the review queue are built on them.
status: {
  type: DataTypes.ENUM(
    'draft', 'sent', 'payment_under_review', 'partially_paid',
    'paid', 'overdue', 'cancelled', 'expired',
  ),
  defaultValue: 'draft',
},
tax_id: { type: DataTypes.INTEGER.UNSIGNED },
// Optional: an admin can point one invoice at a specific bank account. When
// null the buyer is shown the company's active accounts instead.
bank_account_id: { type: DataTypes.INTEGER.UNSIGNED },
discount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
created_by: { type: DataTypes.INTEGER.UNSIGNED },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, {
    tableName: 'invoices',
    updatedAt: false,
    // Unique within a company — see creditNote.js.
    indexes: [{ unique: true, fields: ['company_id', 'invoice_id'], name: 'ux_invoices_company_reference' }],
  });

      return Invoice;
    };

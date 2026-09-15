const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Invoice = require('./invoice')(sequelize, DataTypes);
const InvoicePayment = require('./invoicePayment')(sequelize, DataTypes);
const InvoiceProduct = require('./invoiceProduct')(sequelize, DataTypes);
const Transaction = require('./transaction')(sequelize, DataTypes);
const Tax = require('./tax')(sequelize, DataTypes);
const BankAccount = require('./bankAccount')(sequelize, DataTypes);
const PaymentPlan = require('./paymentPlan')(sequelize, DataTypes);
const CreditNote = require('./creditNote')(sequelize, DataTypes);
const DebitNote = require('./debitNote')(sequelize, DataTypes);
const PaymentReminder = require('./paymentReminder')(sequelize, DataTypes);
const Commission = require('./commission')(sequelize, DataTypes);
const CommissionRule = require('./commissionRule')(sequelize, DataTypes);
const Receipt = require('./receipt')(sequelize, DataTypes);
const InvoiceDocument = require('./invoiceDocument')(sequelize, DataTypes);
const ReferralSetting = require('./referralSetting')(sequelize, DataTypes);
const ReferralTransaction = require('./referralTransaction')(sequelize, DataTypes);

// The property purchase journey. InstallmentPlan is the company's reusable
// template; InvoicePaymentPlan is the arrangement on one invoice, carrying a
// snapshot of the template's terms. Neither is `PaymentPlan` above, which is
// the subscription price list and shares only the word.
const InstallmentPlan = require('./installmentPlan')(sequelize, DataTypes);
const InstallmentPlanUnit = require('./installmentPlanUnit')(sequelize, DataTypes);
const InvoicePaymentPlan = require('./invoicePaymentPlan')(sequelize, DataTypes);
const PaymentSchedule = require('./paymentSchedule')(sequelize, DataTypes);
const PaymentAllocation = require('./paymentAllocation')(sequelize, DataTypes);
const ScheduleFeeApplication = require('./scheduleFeeApplication')(sequelize, DataTypes);
const ReminderSchedule = require('./reminderSchedule')(sequelize, DataTypes);
const ScheduleReminderSend = require('./scheduleReminderSend')(sequelize, DataTypes);

Invoice.hasMany(InvoicePayment, { foreignKey: 'invoice_id', as: 'payments' });
Invoice.hasMany(InvoiceProduct, { foreignKey: 'invoice_id', as: 'products' });
Invoice.belongsTo(Tax, { foreignKey: 'tax_id', as: 'tax' });
Invoice.hasMany(PaymentReminder, { foreignKey: 'invoice_id', as: 'reminders' });
InvoicePayment.belongsTo(Invoice, { foreignKey: 'invoice_id', as: 'invoice' });
/**
 * A receipt SURVIVES the payment it produced.
 *
 * The default was CASCADE, which meant deleting an invoice_payments row also
 * deleted the receipt — and with it the buyer's uploaded proof of payment, the
 * admin's verification record, and the receipt the company issued back. The
 * whole evidence trail for a payment, removed as a side effect of removing the
 * payment.
 *
 * It is also reachable from further up: invoice_payments cascades from
 * invoices, so deleting one invoice would take every receipt on it too.
 *
 * SET NULL rather than RESTRICT: the column is nullable and a receipt is
 * meaningful without a payment — that is exactly its state while it is pending.
 * A receipt whose payment has been removed reverts to describing a claim that
 * no longer has a payment behind it, which is the truth.
 */
InvoicePayment.hasOne(Receipt, {
  foreignKey: 'invoice_payment_id', as: 'receipt', onDelete: 'SET NULL', onUpdate: 'CASCADE',
});
Invoice.hasMany(InvoiceDocument, { foreignKey: 'invoice_id', as: 'documents' });
InvoiceDocument.belongsTo(Invoice, { foreignKey: 'invoice_id', as: 'invoice' });
InvoiceProduct.belongsTo(Invoice, { foreignKey: 'invoice_id', as: 'invoice' });
PaymentReminder.belongsTo(Invoice, { foreignKey: 'invoice_id', as: 'invoice' });
CreditNote.belongsTo(Tax, { foreignKey: 'tax_id', as: 'tax' });
DebitNote.belongsTo(Tax, { foreignKey: 'tax_id', as: 'tax' });
// Declared on both sides, because Sequelize builds the constraint from
// whichever it processes and the two disagreeing is how it ends up CASCADE.
Receipt.belongsTo(InvoicePayment, {
  foreignKey: 'invoice_payment_id', as: 'payment', onDelete: 'SET NULL', onUpdate: 'CASCADE',
});

// Purchase journey associations.
InstallmentPlan.hasMany(InstallmentPlanUnit, { foreignKey: 'installment_plan_id', as: 'unitAssignments' });
InstallmentPlanUnit.belongsTo(InstallmentPlan, { foreignKey: 'installment_plan_id', as: 'plan' });

// hasOne, matching the unique index on invoice_payment_plans.invoice_id: an
// invoice has exactly one arrangement, and `include: ['paymentPlan']` returning
// an array would let a caller quietly read [0] of a set that must never grow.
Invoice.hasOne(InvoicePaymentPlan, { foreignKey: 'invoice_id', as: 'paymentPlan' });
InvoicePaymentPlan.belongsTo(Invoice, { foreignKey: 'invoice_id', as: 'invoice' });
// Provenance only — the snapshot columns, not this association, are what any
// calculation for an issued invoice reads (FRD 3.3).
InvoicePaymentPlan.belongsTo(InstallmentPlan, { foreignKey: 'installment_plan_id', as: 'installmentPlan' });

// Ordered by sequence, not id: the schedule table is always read in due order,
// and after an admin regenerates a schedule set the new rows have higher ids
// than nothing else guarantees to be later dates.
InvoicePaymentPlan.hasMany(PaymentSchedule, {
  foreignKey: 'invoice_payment_plan_id', as: 'schedules',
});
PaymentSchedule.belongsTo(InvoicePaymentPlan, { foreignKey: 'invoice_payment_plan_id', as: 'paymentPlan' });
Invoice.hasMany(PaymentSchedule, { foreignKey: 'invoice_id', as: 'schedules' });

PaymentSchedule.hasMany(PaymentAllocation, { foreignKey: 'payment_schedule_id', as: 'allocations' });
PaymentAllocation.belongsTo(PaymentSchedule, { foreignKey: 'payment_schedule_id', as: 'schedule' });
InvoicePayment.hasMany(PaymentAllocation, { foreignKey: 'invoice_payment_id', as: 'allocations' });
PaymentAllocation.belongsTo(InvoicePayment, { foreignKey: 'invoice_payment_id', as: 'payment' });

PaymentSchedule.hasMany(ScheduleReminderSend, { foreignKey: 'payment_schedule_id', as: 'reminderSends' });
ScheduleReminderSend.belongsTo(PaymentSchedule, { foreignKey: 'payment_schedule_id', as: 'schedule' });
/**
 * An invoice may be put on a named schedule of its own. SET NULL rather than
 * CASCADE: deleting a schedule must return its invoices to the company default,
 * not delete the invoices.
 */
Invoice.belongsTo(ReminderSchedule, {
  foreignKey: 'reminder_schedule_id', as: 'reminderSchedule', onDelete: 'SET NULL', onUpdate: 'CASCADE',
});

PaymentSchedule.hasMany(ScheduleFeeApplication, { foreignKey: 'payment_schedule_id', as: 'feeApplications' });
ScheduleFeeApplication.belongsTo(PaymentSchedule, { foreignKey: 'payment_schedule_id', as: 'schedule' });

module.exports = {
  sequelize,
  Invoice, InvoicePayment, InvoiceProduct,
  Transaction, Tax, BankAccount, PaymentPlan,
  CreditNote, DebitNote, PaymentReminder,
  Commission, CommissionRule, Receipt, InvoiceDocument,
  ReferralSetting, ReferralTransaction,
  InstallmentPlan, InstallmentPlanUnit, InvoicePaymentPlan,
  PaymentSchedule, PaymentAllocation, ScheduleFeeApplication,
  ReminderSchedule, ScheduleReminderSend,
};

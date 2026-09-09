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
const ReferralSetting = require('./referralSetting')(sequelize, DataTypes);
const ReferralTransaction = require('./referralTransaction')(sequelize, DataTypes);

Invoice.hasMany(InvoicePayment, { foreignKey: 'invoice_id', as: 'payments' });
Invoice.hasMany(InvoiceProduct, { foreignKey: 'invoice_id', as: 'products' });
Invoice.belongsTo(Tax, { foreignKey: 'tax_id', as: 'tax' });
Invoice.hasMany(PaymentReminder, { foreignKey: 'invoice_id', as: 'reminders' });
InvoicePayment.belongsTo(Invoice, { foreignKey: 'invoice_id', as: 'invoice' });
InvoicePayment.hasOne(Receipt, { foreignKey: 'invoice_payment_id', as: 'receipt' });
InvoiceProduct.belongsTo(Invoice, { foreignKey: 'invoice_id', as: 'invoice' });
PaymentReminder.belongsTo(Invoice, { foreignKey: 'invoice_id', as: 'invoice' });
CreditNote.belongsTo(Tax, { foreignKey: 'tax_id', as: 'tax' });
DebitNote.belongsTo(Tax, { foreignKey: 'tax_id', as: 'tax' });
Receipt.belongsTo(InvoicePayment, { foreignKey: 'invoice_payment_id', as: 'payment' });

module.exports = {
  sequelize,
  Invoice, InvoicePayment, InvoiceProduct,
  Transaction, Tax, BankAccount, PaymentPlan,
  CreditNote, DebitNote, PaymentReminder,
  Commission, CommissionRule, Receipt,
  ReferralSetting, ReferralTransaction,
};

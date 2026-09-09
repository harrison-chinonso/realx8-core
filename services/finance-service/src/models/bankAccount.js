module.exports = (sequelize, DataTypes) => {
      const BankAccount = sequelize.define('BankAccount', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

name: { type: DataTypes.STRING, allowNull: false },
bank_name: { type: DataTypes.STRING, allowNull: false },
account_number: { type: DataTypes.STRING, allowNull: false },
// Only active accounts are offered to buyers for a bank deposit.
is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
// International/settlement details. The Bank Accounts form has always
// collected these; without the columns Sequelize discarded them silently.
routing_number: { type: DataTypes.STRING },
iban: { type: DataTypes.STRING },
swift_code: { type: DataTypes.STRING },
opening_balance: { type: DataTypes.DECIMAL(14, 2), defaultValue: 0 },
// No default: the company's configured currency is the source of truth, and
// stamping one here would silently disagree with it.
currency: { type: DataTypes.STRING(8) },
created_by: { type: DataTypes.INTEGER.UNSIGNED },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'bank_accounts', updatedAt: false });

      return BankAccount;
    };

const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const InvestmentPlan = require('./investmentPlan')(sequelize, DataTypes);
const InvestmentCategory = require('./investmentCategory')(sequelize, DataTypes);
const InvestmentPeriod = require('./investmentPeriod')(sequelize, DataTypes);
const Investment = require('./investment')(sequelize, DataTypes);
const InvestmentTransaction = require('./investmentTransaction')(sequelize, DataTypes);
const InvestmentPayout = require('./investmentPayout')(sequelize, DataTypes);

InvestmentPlan.belongsTo(InvestmentCategory, { foreignKey: 'category_id', as: 'category' });
InvestmentPlan.belongsTo(InvestmentPeriod, { foreignKey: 'period_id', as: 'period' });
InvestmentCategory.hasMany(InvestmentPlan, { foreignKey: 'category_id', as: 'plans' });
InvestmentPeriod.hasMany(InvestmentPlan, { foreignKey: 'period_id', as: 'plans' });
Investment.belongsTo(InvestmentPlan, { foreignKey: 'plan_id', as: 'plan' });
Investment.hasMany(InvestmentTransaction, { foreignKey: 'investment_id', as: 'transactions' });
Investment.hasMany(InvestmentPayout, { foreignKey: 'investment_id', as: 'payouts' });
InvestmentTransaction.belongsTo(Investment, { foreignKey: 'investment_id', as: 'investment' });
InvestmentPayout.belongsTo(Investment, { foreignKey: 'investment_id', as: 'investment' });

module.exports = { sequelize, InvestmentPlan, InvestmentCategory, InvestmentPeriod, Investment, InvestmentTransaction, InvestmentPayout };

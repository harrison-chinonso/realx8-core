module.exports = (sequelize, DataTypes) => {
      const InvestmentPlan = sequelize.define('InvestmentPlan', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

name: { type: DataTypes.STRING, allowNull: false },
description: { type: DataTypes.TEXT },
min_amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
max_amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
return_rate: { type: DataTypes.DECIMAL(5, 2), defaultValue: 0 },
period_id: { type: DataTypes.INTEGER.UNSIGNED },
category_id: { type: DataTypes.INTEGER.UNSIGNED },
status: { type: DataTypes.STRING, defaultValue: 'active' },
total_investment_amount: { type: DataTypes.DECIMAL(14, 2), defaultValue: 0 },
/**
 * ── The opportunity's terms ─────────────────────────────────────────────────
 *
 * A rate alone is not a specification: 12% a year paid monthly and compounding
 * is a different sum from 12% paid once at maturity. All three are stored, and
 * all three are copied onto a subscription when it is made — see
 * shared/src/investments/terms.js for why they are copied rather than read back
 * through this row.
 *
 * Every one of these is a VARCHAR rather than an ENUM, deliberately. Postgres
 * gives each ENUM column its own type named after its table, which makes the
 * column impossible to UNION with any other and produced three production
 * outages in this codebase in one evening. A short string with a documented set
 * of values costs nothing and cannot do that.
 */
/** 'at_maturity' | 'monthly' | 'quarterly' */
payout_frequency: { type: DataTypes.STRING(20), defaultValue: 'at_maturity' },
/** 'simple' | 'compound' — simple unless a company deliberately chose otherwise. */
return_basis: { type: DataTypes.STRING(20), defaultValue: 'simple' },
/** How long the money is committed for. Derived from the period when one is set. */
tenor_days: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },

/**
 * What is being funded.
 *
 * Optional, because a company may raise against its balance sheet rather than
 * one estate — but when it is set, the investor can see what their money is
 * behind, which is the whole difference between this and a savings product.
 */
property_id: { type: DataTypes.INTEGER.UNSIGNED },
unit_id: { type: DataTypes.INTEGER.UNSIGNED },

/** The raise, in minor units. A cap of 0 means no ceiling. */
raise_target_minor: { type: DataTypes.BIGINT.UNSIGNED, defaultValue: 0 },
cap_minor: { type: DataTypes.BIGINT.UNSIGNED, defaultValue: 0 },

/**
 * The offer window, which is not the tenor. An opportunity can be open for
 * subscription for two weeks and run for two years.
 */
opens_at: { type: DataTypes.DATE },
closes_at: { type: DataTypes.DATE },

/**
 * Leaving early. Off unless switched on: silence should not grant the right to
 * withdraw from money a company has committed to a development.
 */
early_exit_allowed: { type: DataTypes.BOOLEAN, defaultValue: false },
lock_in_days: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
/** 'none' | 'percentage_of_return' | 'flat_fee' | 'forfeit_all_return' */
penalty_type: { type: DataTypes.STRING(30), defaultValue: 'none' },
penalty_value: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },

created_by: { type: DataTypes.INTEGER.UNSIGNED },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'investment_plans', updatedAt: false });

      return InvestmentPlan;
    };

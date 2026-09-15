module.exports = (sequelize, DataTypes) => {
      const InvestmentPayout = sequelize.define('InvestmentPayout', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

investment_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
/**
 * What kind of money this is: 'return', 'capital' or 'exit_settlement'.
 *
 * Everything used to be one undifferentiated amount, which made "how much
 * capital is still outstanding" unanswerable without inferring it from dates.
 * A string rather than an ENUM, for the Postgres reason set out on the plan.
 */
kind: { type: DataTypes.STRING(20), defaultValue: 'return' },

/** The figure, in minor units. `amount` is kept in step for older readers. */
amount_minor: { type: DataTypes.BIGINT.UNSIGNED, defaultValue: 0 },

/**
 * What it was computed FROM — principal, rate, days, basis, paid-to-date.
 *
 * So a figure disputed in three years can be reconstructed from the inputs it
 * actually used, rather than re-derived from whatever the configuration says
 * by then. The commission engine keeps the same kind of record for the same
 * reason.
 */
computed_from: { type: DataTypes.JSON },

/** Approved before it is paid, by somebody who can be named afterwards. */
approved_by: { type: DataTypes.INTEGER.UNSIGNED },
approved_at: { type: DataTypes.DATE },
/** The debit note that actually moves the money. */
debit_note_id: { type: DataTypes.INTEGER.UNSIGNED },

amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
/*
 * 'approved' sits between pending and paid, because raising money and
 * releasing it should be separable acts — a payout is checked by somebody
 * before it leaves. syncEnums reconciles this with the database on boot, which
 * is the only reason widening a Postgres enum in place is safe here.
 */
status: { type: DataTypes.ENUM('pending', 'approved', 'paid', 'cancelled'), defaultValue: 'pending' },
payout_date: { type: DataTypes.DATE },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'investment_payouts', updatedAt: false });

      return InvestmentPayout;
    };

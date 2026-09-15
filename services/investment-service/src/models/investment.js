module.exports = (sequelize, DataTypes) => {
      const Investment = sequelize.define('Investment', {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
plan_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
/*
 * 'exited' is distinct from 'completed': one ran its term, the other was ended
 * early and settled with a penalty. Reporting on how many investors leave early
 * is impossible if both are called completed.
 */
status: { type: DataTypes.ENUM('pending', 'active', 'completed', 'cancelled', 'exited'), defaultValue: 'pending' },
start_date: { type: DataTypes.DATE },
end_date: { type: DataTypes.DATE },
// Cash-out request workflow
cash_out_status: {
  type: DataTypes.ENUM('not_requested', 'requested', 'approved', 'rejected', 'paid'),
  defaultValue: 'not_requested',
},
cash_out_requested_at: { type: DataTypes.DATE },
cash_out_notes: { type: DataTypes.TEXT },
cash_out_approved_by: { type: DataTypes.INTEGER.UNSIGNED },
/**
 * ── The terms this investor actually agreed to ──────────────────────────────
 *
 * Copied from the opportunity at the moment of subscription and never read back
 * through it again. Editing an opportunity must not rewrite what an existing
 * investor is owed — including money already paid — and this column is what
 * makes that impossible rather than merely discouraged.
 */
terms: { type: DataTypes.JSON },

/** What they committed to, in minor units. */
principal_minor: { type: DataTypes.BIGINT.UNSIGNED, defaultValue: 0 },
/**
 * What has actually landed. Not the same number: a subscription is a promise
 * until money arrives against its invoice, and a part-funded one accrues on
 * what landed rather than on what was promised.
 */
funded_minor: { type: DataTypes.BIGINT.UNSIGNED, defaultValue: 0 },
/**
 * When the money arrived, which is when the tenor starts — not the subscription
 * date. Money that arrives three weeks late earns from three weeks late.
 */
funded_at: { type: DataTypes.DATE },

/** The invoice the investor pays. Funding is confirmed through finance. */
invoice_id: { type: DataTypes.INTEGER.UNSIGNED },

/** Running totals, so a payout never has to re-derive what came before it. */
return_paid_minor: { type: DataTypes.BIGINT.UNSIGNED, defaultValue: 0 },
capital_paid_minor: { type: DataTypes.BIGINT.UNSIGNED, defaultValue: 0 },

matured_at: { type: DataTypes.DATE },
exited_at: { type: DataTypes.DATE },
exit_penalty_minor: { type: DataTypes.BIGINT.UNSIGNED, defaultValue: 0 },

created_by: { type: DataTypes.INTEGER.UNSIGNED },
      
company_id: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: 'investments', updatedAt: false });

      return Investment;
    };

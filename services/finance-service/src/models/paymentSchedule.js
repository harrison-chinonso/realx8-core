module.exports = (sequelize, DataTypes) => {
  /**
   * One dated installment obligation (FRD 9).
   *
   * Two independent status dimensions, deliberately not collapsed into one
   * (FRD 9.2) — collapsing them loses information, because "overdue" and "part
   * paid" are both true of the same schedule and either alone misreports it:
   *
   *   timing_status      where the date has got to
   *   settlement_status  how much of it has been paid
   *
   * A settled schedule exits the timing progression by being PAID, not by
   * having its timing overwritten, so a schedule that went overdue before it
   * was settled still records that it did. Every read that drives money or
   * notifications asks for overdue AND unsettled.
   */
  const PaymentSchedule = sequelize.define('PaymentSchedule', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    invoice_payment_plan_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    // Denormalised so the whole schedule table can be joined to invoices
    // without going through the plan on every reporting query.
    invoice_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    // 1-based position in the plan. The LAST one carries the rounding
    // remainder (FRD 4, 9.1).
    sequence: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    due_date: { type: DataTypes.DATEONLY, allowNull: false },

    // What this schedule was for, and what is left of it. principal_minor is
    // fixed at generation; the outstanding figure is what allocation moves.
    principal_minor: { type: DataTypes.BIGINT, allowNull: false },
    principal_outstanding_minor: { type: DataTypes.BIGINT, allowNull: false },

    // Default fees accrued against this schedule (FRD 9.3). The payable amount
    // is principal plus accrued fee, and BOTH must clear for it to reach PAID.
    /**
     * A discount granted against this installment, held SEPARATELY from the
     * principal.
     *
     * The principal is what the buyer agreed to pay, and every schedule's
     * principal still sums to the plan's total — an invariant `outstandingFor`
     * depends on to report "total" and "paid + balance" as the same number.
     * Reducing the principal to express a discount would break that silently
     * and leave no record of the agreed price.
     *
     * So the discount sits beside it, and what the buyer must actually send is
     * `principal_outstanding_minor - discount_minor + fee_outstanding_minor`.
     */
    discount_minor: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    fee_accrued_minor: { type: DataTypes.BIGINT, defaultValue: 0 },
    fee_outstanding_minor: { type: DataTypes.BIGINT, defaultValue: 0 },

    timing_status: {
      type: DataTypes.ENUM('upcoming', 'due', 'in_grace', 'overdue'),
      defaultValue: 'upcoming',
    },
    settlement_status: {
      type: DataTypes.ENUM('unpaid', 'partially_paid', 'paid'),
      defaultValue: 'unpaid',
    },

    // Set once the schedule first clears, so a plan's completion date is a fact
    // rather than something inferred from the newest allocation.
    settled_at: { type: DataTypes.DATE },

    /**
     * Which of the two pre-due reminders (FRD 12.2) have gone out.
     *
     * Stored rather than derived from "is today 14 days before the due date?",
     * because that question is only idempotent if the job runs exactly once a
     * day — and FRD 9.4 requires the job to be safe to re-run. It also means a
     * job that missed a day still sends the reminder late rather than skipping
     * it, which is the more useful failure.
     */
    reminder_first_sent_at: { type: DataTypes.DATE },
    reminder_second_sent_at: { type: DataTypes.DATE },

    /**
     * The timing status last NOTIFIED, as opposed to the current one above.
     *
     * The FRD 12.2 schedule events fire on a transition — "status → DUE" — so
     * the job compares the two and sends only on a change. Without it every
     * daily run would re-tell a client their schedule is overdue for as long as
     * it stayed overdue.
     */
    notified_timing_status: { type: DataTypes.STRING(16) },

    company_id: { type: DataTypes.INTEGER.UNSIGNED },
  }, {
    tableName: 'payment_schedules',
    indexes: [
      { unique: true, fields: ['invoice_payment_plan_id', 'sequence'], name: 'payment_schedule_plan_sequence_unique' },
      // The daily job (FRD 9.4) sweeps by date across every active plan.
      { fields: ['due_date', 'settlement_status'], name: 'payment_schedule_due_sweep' },
      { fields: ['invoice_id'], name: 'payment_schedule_invoice' },
    ],
  });

  return PaymentSchedule;
};

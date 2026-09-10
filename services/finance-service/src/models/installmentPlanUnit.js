module.exports = (sequelize, DataTypes) => {
  /**
   * Assignment of a plan to ONE property unit (FRD 3.2) — a hard requirement:
   * different units of the same property carry different plan sets, so a full
   * plot can be 3-month only while a half plot offers 1, 2, 3 and 6.
   *
   * property_unit_id references property_units, which property-service owns.
   * The row lives here because the terms it points at are finance's, and the
   * two services already share one database; property-service reads the
   * assignment rather than defining a model for it, so its sync({ alter: true })
   * cannot reshape this table.
   *
   * A unit with no rows here can only be purchased outright.
   */
  const InstallmentPlanUnit = sequelize.define('InstallmentPlanUnit', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    installment_plan_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    property_unit_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
  }, {
    tableName: 'installment_plan_units',
    updatedAt: false,
    indexes: [
      // Assigning the same plan to the same unit twice would list it twice in
      // the plan picker; the unique index makes the assign endpoint idempotent.
      {
        unique: true,
        fields: ['installment_plan_id', 'property_unit_id'],
        name: 'installment_plan_unit_unique',
      },
      { fields: ['property_unit_id'], name: 'installment_plan_unit_by_unit' },
    ],
  });

  return InstallmentPlanUnit;
};

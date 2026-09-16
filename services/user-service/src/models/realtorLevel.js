module.exports = (sequelize, DataTypes) => {
  const RealtorLevel = sequelize.define('RealtorLevel', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT },
    // Rank order, lowest first. Drives "is this an upgrade?" comparisons and
    // the order levels are displayed in.
    position: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    // Commission rate earned by realtors on this level, as a percentage.
    commission_percentage: { type: DataTypes.DECIMAL(5, 2), defaultValue: 0 },
    /**
     * What a realtor pays to move UP to this level, in kobo. Zero means free.
     *
     * On the level rather than in settings because the price belongs to the
     * step: Bronze to Silver is not worth what Gold to Platinum is. An integer
     * because it is cash — the percentage above is a rate, which is why that
     * one is a decimal.
     */
    levelup_fee_minor: { type: DataTypes.BIGINT.UNSIGNED, defaultValue: 0 },
    is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
  }, { tableName: 'realtor_levels' });

  return RealtorLevel;
};

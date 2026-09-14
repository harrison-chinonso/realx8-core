module.exports = (sequelize, DataTypes) => {
  const CommissionRule = sequelize.define('CommissionRule', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    product_type: {
      type: DataTypes.ENUM('land', 'house', 'investment', 'any'),
      allowNull: false,
      defaultValue: 'any',
    },
    /**
     * The level this rule is for, by NAME, or 'any' for every level.
     *
     * Free text rather than an enum of three fixed names: a company's ladder is
     * its own, and the old enum meant a rule could not be written for a level
     * called Ambassador — or Gold, or Associate — at all. Kept alongside
     * `realtor_level_id` because it is what old rows carry and what a reader
     * recognises.
     */
    realtor_category: {
      type: DataTypes.STRING(64),
      allowNull: false,
      defaultValue: 'any',
    },
    /**
     * The same level by id, which is what the generator matches on first. A
     * rule follows a level through a rename this way; matching on the name
     * alone silently detaches it.
     */
    realtor_level_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    type: { type: DataTypes.ENUM('fixed', 'percentage'), allowNull: false, defaultValue: 'percentage' },
    value: { type: DataTypes.DECIMAL(12, 4), allowNull: false },
    description: { type: DataTypes.STRING },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
  }, { tableName: 'commission_rules' });

  return CommissionRule;
};

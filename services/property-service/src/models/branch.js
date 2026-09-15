module.exports = (sequelize, DataTypes) => {
  /**
   * A company's office, and the properties run out of it.
   *
   * ── Why a property carries the branch, and not the other way round ─────────
   *
   * A property belongs to at most one branch, so the relationship is stored as
   * a single `branch_id` on the property. That is not merely the cheaper of two
   * layouts — it is the rule itself: with one column there is no arrangement of
   * rows that can put a property in two branches at once, so the constraint
   * cannot be broken by a bad write, a race, or a future endpoint that forgets
   * to check. A join table would have needed a unique index and a reason.
   *
   * Nullable, and deliberately so. A company that has not set up branches yet
   * still has properties, and a property that has not been assigned to one is a
   * normal state rather than a broken one — "unassigned" is a real answer to
   * "which branch runs this?", and forcing a default branch on every tenant to
   * avoid a null would invent an office that does not exist.
   */
  const Branch = sequelize.define('Branch', {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    name: { type: DataTypes.STRING, allowNull: false },
    /** The office address. Free text: addresses here do not fit a schema. */
    address: { type: DataTypes.STRING },
    company_id: { type: DataTypes.INTEGER.UNSIGNED },
    created_by: { type: DataTypes.INTEGER.UNSIGNED },
  }, {
    tableName: 'branches',
    /*
     * Soft-deleted, like properties. A branch that closes is still the branch
     * every historic property was sold out of, and hard-deleting it would leave
     * that history pointing at nothing.
     */
    paranoid: true,
  });

  return Branch;
};

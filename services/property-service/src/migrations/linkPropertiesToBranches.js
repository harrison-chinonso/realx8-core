const {
  isPostgres, q, columnsOf, tableExists, indexExists,
} = require('../../../../shared/src/dialect');

/**
 * The foreign key from a property to its branch, and the index that makes
 * "what does this branch run?" a cheap question.
 *
 * ── Why this is not left to sync ────────────────────────────────────────────
 *
 * `sync({ alter: true })` creates the branches table and adds `branch_id` to
 * properties, and it would be reasonable to stop there. It is the DELETE
 * BEHAVIOUR that cannot be left to it.
 *
 * A branch is soft-deleted, so in ordinary use the row survives and the foreign
 * key never fires — the controller unassigns the properties itself. But the row
 * can also leave for reasons no controller sees: a hard delete run by hand
 * during support, a company purge, a restore. Without an explicit rule, the
 * database's default is RESTRICT, and the delete simply fails with a constraint
 * error nobody can read; with CASCADE, which is the default a careless hand
 * would reach for, deleting an office would delete the properties it ran.
 *
 * SET NULL is the only correct answer: the properties survive, unassigned,
 * which is exactly the state they were in before anybody set up branches.
 *
 * Idempotent, and safe on a database that already has all of this.
 */
module.exports = async (sequelize) => {
  const qi = sequelize.getQueryInterface();

  // sync() runs before this and creates both. If either is somehow missing
  // there is nothing to constrain, and erroring here would stop the service.
  if (!await tableExists(sequelize, 'branches')) return;
  if (!await tableExists(sequelize, 'properties')) return;

  const propertyColumns = await columnsOf(sequelize, 'properties');
  if (!propertyColumns.has('branch_id')) return;

  /*
   * The index first. Every branch screen asks "which properties are in this
   * branch", and unassigning on delete does the same lookup — without it both
   * are a full scan of the property table.
   */
  const INDEX = 'idx_properties_branch_id';
  if (!await indexExists(sequelize, 'properties', INDEX)) {
    try {
      await qi.addIndex('properties', ['branch_id'], { name: INDEX });
    } catch (error) {
      // A concurrent boot of the same service can win the race. Any other
      // failure is real and must not be swallowed.
      if (!/exists|duplicate/i.test(error.message || '')) throw error;
    }
  }

  /*
   * The constraint. Named explicitly so it can be found again — an
   * auto-generated name differs between the two engines, and a migration that
   * cannot recognise its own work is not idempotent.
   */
  const CONSTRAINT = 'fk_properties_branch_id';

  const [existing] = await sequelize.query(
    isPostgres(sequelize)
      ? `SELECT 1 FROM pg_constraint WHERE conname = '${CONSTRAINT}'`
      : `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = '${CONSTRAINT}'`,
  );
  if (existing.length) return;

  /*
   * Any property pointing at a branch that is not there is cleared first.
   * Adding the constraint would otherwise fail on exactly the rows it exists to
   * prevent — and failing to boot is a worse outcome than a handful of
   * properties reverting to unassigned, which is what they effectively already
   * were.
   */
  await sequelize.query(
    `UPDATE ${q(sequelize, 'properties')} SET ${q(sequelize, 'branch_id')} = NULL
     WHERE ${q(sequelize, 'branch_id')} IS NOT NULL
       AND ${q(sequelize, 'branch_id')} NOT IN (SELECT ${q(sequelize, 'id')} FROM ${q(sequelize, 'branches')})`,
  );

  try {
    await qi.addConstraint('properties', {
      fields: ['branch_id'],
      type: 'foreign key',
      name: CONSTRAINT,
      references: { table: 'branches', field: 'id' },
      // See the note above: never CASCADE. An office closing does not delete
      // the properties it ran.
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });
  } catch (error) {
    if (!/exists|duplicate/i.test(error.message || '')) throw error;
  }
};

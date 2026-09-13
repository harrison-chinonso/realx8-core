const {
  columnsOf, tableExists, indexExists, dropIndex, addUniqueIndex, quoteIdent,
  isDuplicateError, isPostgres,
} = require('../../../../shared/src/dialect');

/**
 * Lets a short share code point at a single property.
 *
 * A shared property used to be `/p/<48 hex characters>?ref=<code>`: the long
 * half named the property, the short half named who shared it. The property is
 * now a code in `referral_links` like everything else, so the URL is one short
 * code and one lookup answers both questions.
 *
 * Two steps, and the second is the one that matters. Adding the column is
 * harmless; REPLACING the uniqueness key is what stops a realtor's sign-up link
 * being handed back as their link to a property. Under the old key
 * (company_id, realtor_code) those two rows are the same row.
 *
 * Runs before sync, which is `{ force: false }` here and so never adds a column
 * to an existing table — without this the model would select a column that is
 * not there.
 */
const OLD_INDEX = 'ux_referral_links_company_realtor';
const NEW_INDEX = 'ux_referral_links_company_realtor_property';

module.exports = async (sequelize) => {
  if (!(await tableExists(sequelize, 'referral_links'))) return;

  // A Map of column name -> column type, or null when the table is absent —
  // which tableExists above has already ruled out.
  const columns = await columnsOf(sequelize, 'referral_links');

  /**
   * UNSIGNED on MySQL, to match the model and every other id column in the
   * schema. A signed column would work, but it would be the one `*_id` in the
   * database that disagrees with its neighbours, and Sequelize's sync — which
   * is `{ force: false }` here and never alters anything — would not fix it
   * later.
   */
  const columnType = isPostgres(sequelize) ? 'INTEGER NULL' : 'INT UNSIGNED NULL';

  if (!columns.has('property_id')) {
    /**
     * Tolerating a duplicate rather than trusting the check above.
     *
     * Two instances booting at once both read the column as absent and both
     * try to add it; one succeeds and the other must not take the whole
     * deployment down over work that has already been done. Every migration in
     * this directory is written to survive being run again, and being run
     * CONCURRENTLY is the same requirement with tighter timing.
     */
    await sequelize.query(
      `ALTER TABLE ${quoteIdent(sequelize, 'referral_links')} ADD COLUMN property_id ${columnType}`,
    ).catch((error) => { if (!isDuplicateError(error)) throw error; });
  }

  /**
   * Order matters: the new index has to exist before the old one goes, or a
   * deploy interrupted between the two leaves the table with no uniqueness on
   * the key at all — and duplicate rows minted in that window would survive the
   * next attempt to create it.
   */
  if (!(await indexExists(sequelize, 'referral_links', NEW_INDEX))) {
    await addUniqueIndex(sequelize, 'referral_links', ['company_id', 'realtor_code', 'property_id'], NEW_INDEX)
      .catch((error) => { if (!isDuplicateError(error)) throw error; });
  }
  if (await indexExists(sequelize, 'referral_links', OLD_INDEX)) {
    await dropIndex(sequelize, 'referral_links', OLD_INDEX);
  }
};

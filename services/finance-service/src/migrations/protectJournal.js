const { isPostgres, tableExists } = require('../../../../shared/src/dialect');

/**
 * Makes the journal append-only in the database, not merely in the code
 * (ACC-2.4).
 *
 * ── Why the guarantee cannot live in shared/src/accounting/ledger.js alone ──
 *
 * That module has no UPDATE and no DELETE, and it is the only door anything
 * posts through. That is a convention held by every future caller, and a
 * convention is not what "a statement is reproducible exactly as it read at a
 * past date" requires — as book of record, it is the claim an auditor tests.
 * A trigger is the version of the claim that survives somebody opening a SQL
 * console at eleven at night to "just fix one figure".
 *
 * Copied deliberately from user-service's createAuditLog, which made the same
 * argument about audit entries and has been holding it since. The refusal
 * message is worded the same way for the same reason: whoever hits it needs to
 * know it is a rule rather than a bug.
 *
 * ── A managed database may refuse to grant TRIGGER ──────────────────────────
 *
 * Logged and tolerated, again as createAuditLog does. Booting the platform is
 * worth more than the belt to the code's braces, and a deployment without the
 * trigger still has the single-door guarantee.
 */

const REFUSAL = 'journal_entries is append-only: a posted journal is corrected by reversing it, never by editing it.';
const LINE_REFUSAL = 'journal_lines is append-only: a posted journal is corrected by reversing it, never by editing it.';

const guardsFor = async (sequelize, table, message) => {
  if (isPostgres(sequelize)) {
    await sequelize.query(`
      CREATE OR REPLACE FUNCTION ${table}_refuse_change() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION '${message}';
      END;
      $$ LANGUAGE plpgsql;
    `);
    // DROP first: CREATE OR REPLACE TRIGGER is not available before Postgres 14.
    await sequelize.query(`DROP TRIGGER IF EXISTS ${table}_no_update ON ${table}`);
    await sequelize.query(`DROP TRIGGER IF EXISTS ${table}_no_delete ON ${table}`);
    await sequelize.query(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
                           FOR EACH ROW EXECUTE FUNCTION ${table}_refuse_change()`);
    await sequelize.query(`CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
                           FOR EACH ROW EXECUTE FUNCTION ${table}_refuse_change()`);
    return;
  }

  await sequelize.query(`DROP TRIGGER IF EXISTS ${table}_no_update`);
  await sequelize.query(`DROP TRIGGER IF EXISTS ${table}_no_delete`);
  await sequelize.query(
    `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} FOR EACH ROW
       SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${message}'`,
  );
  await sequelize.query(
    `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} FOR EACH ROW
       SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${message}'`,
  );
};

module.exports = async function protectJournal(sequelize) {
  try {
    // sync() creates the tables; this runs after it and adds what sync cannot.
    if (!(await tableExists(sequelize, 'journal_entries'))) return;
    await guardsFor(sequelize, 'journal_entries', REFUSAL);
    await guardsFor(sequelize, 'journal_lines', LINE_REFUSAL);
  } catch (error) {
    console.warn(
      `[accounting] could not install the append-only guards: ${error.message}. `
      + 'The ledger module is still the only writer, but the database will not refuse a manual edit.',
    );
  }
};

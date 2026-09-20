const { QueryTypes } = require('sequelize');
const { isPostgres, tableExists, columnsOf, quoteIdent } = require('../../../../shared/src/dialect');

/**
 * Removes what ACC-0 retired: the debit_notes table, and the fee columns on
 * credit_notes that moved to invoices.
 *
 * ── Why this is a separate, later migration ─────────────────────────────────
 *
 * ACC-0 stopped WRITING to both of them and removed every reader — the model,
 * the routes, the controller paths. Dropping them in the same change would
 * have meant the code and the schema moving together with no interval in
 * which to notice that something still read them. Leaving them a while is
 * what makes this step safe to take rather than brave.
 *
 * ── It refuses to drop a table with rows in it ──────────────────────────────
 *
 * Staging is disposable and the table is empty, which is why this can run at
 * all. But "disposable" is a fact about one database at one moment, and this
 * migration runs on every boot of every deployment for as long as it exists —
 * including, eventually, one where somebody restored a backup. So the row
 * count is checked and a non-empty table is left alone with a message, rather
 * than trusting that what was true on staging in September is true everywhere
 * afterwards.
 *
 * The columns are dropped without that check, because a column cannot be
 * "non-empty" in the same way: they were written only by the fee flow, that
 * flow is gone, and any value left in one is a fee that became an invoice.
 */

const MARKER_GROUP = 'migrations';
/*
 * v2. The first version dropped the columns and had them put straight back:
 * the model still declared them, so sync({ alter: true }) recreated them, and
 * addNoteChargeColumns re-added them on the next boot. Both of those are now
 * fixed; bumping the key is what lets the drop run again on a database the
 * first attempt already marked done.
 */
const MARKER_KEY = 'acc0_retired_tables_dropped_v2';

const DEAD_COLUMNS = ['payment_proof_url', 'payment_reference', 'payment_submitted_at'];

const quoted = (sequelize) => {
  const pg = isPostgres(sequelize);
  return {
    group: pg ? '"group"' : '`group`',
    key: pg ? '"key"' : '`key`',
    value: pg ? '"value"' : '`value`',
  };
};

module.exports = async function dropRetiredNoteTables(sequelize) {
  const q = quoted(sequelize);
  try {
    const done = await sequelize.query(
      `SELECT 1 FROM settings WHERE ${q.group} = :group AND ${q.key} = :key LIMIT 1`,
      { replacements: { group: MARKER_GROUP, key: MARKER_KEY }, type: QueryTypes.SELECT },
    );
    if (done.length) return;

    let dropped = false;

    if (await tableExists(sequelize, 'debit_notes')) {
      const [{ n }] = await sequelize.query(
        'SELECT COUNT(*) AS n FROM debit_notes', { type: QueryTypes.SELECT },
      );
      if (Number(n) > 0) {
        /*
         * Left in place, and deliberately NOT marked done — so a deployment
         * that clears the rows later has this run and finish the job, rather
         * than carrying an empty table for ever because one boot found data.
         */
        console.warn(
          `[accounting] debit_notes still holds ${n} row(s) and was not dropped. `
          + 'Nothing reads it since ACC-0.6; clear it when you are satisfied and this will finish on the next boot.',
        );
        return;
      }
      await sequelize.query(`DROP TABLE ${quoteIdent(sequelize, 'debit_notes')}`);
      console.log('[accounting] debit_notes dropped — retired in ACC-0.6.');
      dropped = true;
    }

    /*
     * Counted separately from the table.
     *
     * The first version reused one `dropped` flag for both, so a boot that
     * dropped the TABLE reported the columns dropped too — and they had not
     * been. A log line that says a thing happened because a different thing
     * happened is worse than no log line, because it is believed.
     */
    let columnsDropped = 0;
    const columns = await columnsOf(sequelize, 'credit_notes').catch(() => null);
    if (columns) {
      for (const column of DEAD_COLUMNS) {
        if (!columns.has(column)) continue;
        // eslint-disable-next-line no-await-in-loop
        await sequelize.query(
          `ALTER TABLE ${quoteIdent(sequelize, 'credit_notes')} DROP COLUMN ${quoteIdent(sequelize, column)}`,
        ).then(() => { columnsDropped += 1; }).catch((error) => {
          console.error(`[accounting] could not drop credit_notes.${column}: ${error.message}`);
        });
      }
      if (columnsDropped) {
        console.log(
          `[accounting] ${columnsDropped} fee column(s) dropped from credit_notes — `
          + 'a fee is an invoice since ACC-0.1.',
        );
      }
    }
    void dropped;

    const settingColumns = (await columnsOf(sequelize, 'settings')) || new Map();
    const extra = ['created_at', 'updated_at'].filter((column) => settingColumns.has(column));
    await sequelize.query(
      `INSERT INTO settings (${q.group}, ${q.key}, ${q.value}, company_id${extra.length ? `, ${extra.join(', ')}` : ''})
       VALUES (:group, :key, 'done', NULL${extra.map(() => ', NOW()').join('')})`,
      { replacements: { group: MARKER_GROUP, key: MARKER_KEY }, type: QueryTypes.INSERT },
    );
  } catch (error) {
    // Best effort, like the migrations beside it. The marker is written only
    // on success, so a failure is retried on the next boot rather than lost.
    console.error(`[accounting] could not drop the retired tables: ${error.message}`);
  }
};

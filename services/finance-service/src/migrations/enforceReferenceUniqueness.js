const { QueryTypes } = require('sequelize');

/**
 * Makes a document reference unique WITHIN a company, and stops one payment
 * reference being attached to two payments.
 *
 * ── Why per company rather than globally ────────────────────────────────────
 *
 * invoice_id, credit_note_id and debit_note_id were globally unique, which is
 * stricter than it sounds useful: every tenant drew from one sequence, so a
 * company's invoice numbers skipped — INV-0007 then INV-0019 — because other
 * companies had taken the numbers between. To an auditor that reads as eleven
 * missing invoices. Each company now numbers from 1 and cannot collide with
 * its own past documents, which is the property that actually matters.
 *
 * ── Why the index and not just a check in code ──────────────────────────────
 *
 * Two requests can both read "the highest is 6" before either writes 7. No
 * amount of checking first closes that window; only the database can, by
 * refusing the second write. The controller catches that refusal and retries
 * with the next number.
 *
 * ── NULL is deliberately allowed to repeat ──────────────────────────────────
 *
 * MySQL treats NULLs as distinct in a unique index, which is exactly right for
 * payment references: a payment marked paid by an admin has no proof and no
 * reference, and any number of those must be able to coexist. Empty strings
 * are NOT distinct, so they are converted to NULL first — otherwise the second
 * reference-less payment would be rejected as a duplicate of the first.
 */

/** Indexes that already exist, so this can run on every boot. */
const indexExists = async (sequelize, table, name) => {
  const rows = await sequelize.query(
    `SELECT 1 FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = :table AND index_name = :name
      LIMIT 1`,
    { replacements: { table, name }, type: QueryTypes.SELECT },
  );
  return rows.length > 0;
};

const dropIndexIfExists = async (sequelize, table, name) => {
  if (!(await indexExists(sequelize, table, name))) return;
  try {
    await sequelize.query(`ALTER TABLE \`${table}\` DROP INDEX \`${name}\``);
    console.log(`[finance] dropped the global unique index ${table}.${name}`);
  } catch (error) {
    console.warn(`[finance] could not drop ${table}.${name}: ${error.message}`);
  }
};

/** Rewrites '' to NULL so blank references do not collide with each other. */
const blankToNull = async (sequelize, table, column) => {
  const [result] = await sequelize.query(
    `UPDATE \`${table}\` SET \`${column}\` = NULL WHERE TRIM(COALESCE(\`${column}\`, '')) = ''
       AND \`${column}\` IS NOT NULL`,
  );
  const changed = result?.affectedRows ?? 0;
  if (changed) console.log(`[finance] ${table}.${column}: ${changed} blank reference(s) set to NULL`);
};

/**
 * Rows that would violate the index, so it can be reported rather than
 * crashing the boot.
 */
const duplicates = async (sequelize, table, column) => sequelize.query(
  `SELECT company_id, \`${column}\` AS value, COUNT(*) AS copies
     FROM \`${table}\`
    WHERE \`${column}\` IS NOT NULL
    GROUP BY company_id, \`${column}\`
   HAVING COUNT(*) > 1
    LIMIT 10`,
  { type: QueryTypes.SELECT },
);

const addCompanyUnique = async (sequelize, table, column, name) => {
  if (await indexExists(sequelize, table, name)) return;

  await blankToNull(sequelize, table, column);

  const clashes = await duplicates(sequelize, table, column);
  if (clashes.length) {
    /**
     * Reported, NOT resolved automatically.
     *
     * Renumbering an existing document would change a reference somebody has
     * already been sent, and deleting one would destroy a record. Which of two
     * duplicates is the real one is a business question, so this says exactly
     * what to look at and leaves the data alone. The index is not created, so
     * the boot continues and nothing else is blocked.
     */
    console.warn(
      `[finance] NOT adding ${name}: ${table}.${column} already has duplicates within a company.\n`
      + clashes.map((row) => `    company ${row.company_id ?? 'none'}: "${row.value}" x${row.copies}`).join('\n')
      + '\n    Resolve these by hand, then restart — the index will be created then.',
    );
    return;
  }

  try {
    await sequelize.query(
      `ALTER TABLE \`${table}\` ADD UNIQUE INDEX \`${name}\` (\`company_id\`, \`${column}\`)`,
    );
    console.log(`[finance] ${table}: ${column} is now unique per company`);
  } catch (error) {
    console.warn(`[finance] could not add ${name}: ${error.message}`);
  }
};

module.exports = async function enforceReferenceUniqueness(sequelize) {
  // Document numbers: unique per company, and the old global index retired.
  await addCompanyUnique(sequelize, 'invoices', 'invoice_id', 'ux_invoices_company_reference');
  await dropIndexIfExists(sequelize, 'invoices', 'invoice_id');

  await addCompanyUnique(sequelize, 'credit_notes', 'credit_note_id', 'ux_credit_notes_company_reference');
  await dropIndexIfExists(sequelize, 'credit_notes', 'credit_note_id');

  await addCompanyUnique(sequelize, 'debit_notes', 'debit_note_id', 'ux_debit_notes_company_reference');
  await dropIndexIfExists(sequelize, 'debit_notes', 'debit_note_id');

  /**
   * Payment references: one reference, one payment.
   *
   * transaction_id on a payment is the reference read off the customer's proof
   * of payment. Two payments carrying the same one means the same bank
   * transfer has been credited twice — the exact double-credit this is here to
   * make impossible.
   */
  await addCompanyUnique(sequelize, 'invoice_payments', 'transaction_id', 'ux_invoice_payments_company_reference');
  await addCompanyUnique(sequelize, 'transactions', 'reference', 'ux_transactions_company_reference');
};

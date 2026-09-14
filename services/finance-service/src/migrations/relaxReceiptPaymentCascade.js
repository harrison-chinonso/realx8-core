const { QueryTypes } = require('sequelize');
const { isPostgres, quoteIdent, tableExists, columnsOf } = require('../../../../shared/src/dialect');

/**
 * Stop a receipt being deleted along with the payment it produced.
 *
 * `receipts.invoice_payment_id` referenced `invoice_payments.id` ON DELETE
 * CASCADE, so removing a payment row also removed the receipt — and with it the
 * buyer's uploaded proof of payment, the record of who verified it and when,
 * and the receipt the company issued back. The entire evidence trail for a
 * payment, deleted as a side effect of deleting the payment.
 *
 * Worse, it is reachable from further up: invoice_payments itself cascades from
 * invoices, so removing one invoice would silently take every receipt on it.
 *
 * SET NULL rather than RESTRICT. The column is nullable and a receipt is
 * perfectly meaningful without a payment — that is its state for the whole time
 * it sits pending. A receipt whose payment has been removed goes back to
 * describing a claim with no payment behind it, which is the truth rather than
 * a dangling reference.
 *
 * ── Why a migration and not just the model ──────────────────────────────────
 *
 * The association now declares SET NULL, which is what a database built from
 * scratch will get. `sync({ alter: true })` does not rewrite the delete rule of
 * a constraint that already exists, so every installed database keeps CASCADE
 * until something explicitly changes it. That is this.
 *
 * Idempotent on both engines: it reads the current rule first and does nothing
 * when it is already SET NULL.
 */

/** The FK on receipts.invoice_payment_id, and its current delete rule. */
const currentConstraint = async (sequelize) => {
  const pg = isPostgres(sequelize);

  if (pg) {
    const [row] = await sequelize.query(
      `SELECT con.conname AS name,
              CASE con.confdeltype
                WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
                WHEN 'c' THEN 'CASCADE'   WHEN 'n' THEN 'SET NULL'
                WHEN 'd' THEN 'SET DEFAULT' END AS delete_rule
         FROM pg_constraint con
         JOIN pg_class child ON child.oid = con.conrelid
         JOIN pg_attribute att ON att.attrelid = child.oid AND att.attnum = ANY (con.conkey)
        WHERE con.contype = 'f'
          AND child.relname = 'receipts'
          AND att.attname = 'invoice_payment_id'
        LIMIT 1`,
      { type: QueryTypes.SELECT },
    );
    return row || null;
  }

  const [row] = await sequelize.query(
    `SELECT k.CONSTRAINT_NAME AS name, r.DELETE_RULE AS delete_rule
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        AND r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
      WHERE k.TABLE_SCHEMA = DATABASE()
        AND k.TABLE_NAME = 'receipts'
        AND k.COLUMN_NAME = 'invoice_payment_id'
        AND k.REFERENCED_TABLE_NAME = 'invoice_payments'
      LIMIT 1`,
    { type: QueryTypes.SELECT },
  );
  return row || null;
};

module.exports = async (sequelize) => {
  if (!await tableExists(sequelize, 'receipts')) return;
  if (!await tableExists(sequelize, 'invoice_payments')) return;

  const columns = await columnsOf(sequelize, 'receipts');
  if (!columns?.has('invoice_payment_id')) return;

  const existing = await currentConstraint(sequelize);

  /**
   * No constraint at all is left alone.
   *
   * A database with no foreign key here cannot cascade-delete anything, which
   * is the outcome this migration exists to produce. Adding one would be a new
   * guarantee rather than the removal of a harmful one, and it would fail on
   * any installation carrying rows that point at payments already gone.
   */
  if (!existing) return;
  if (String(existing.delete_rule).toUpperCase() === 'SET NULL') return;

  const receipts = quoteIdent(sequelize, 'receipts');
  const name = quoteIdent(sequelize, existing.name);
  const column = quoteIdent(sequelize, 'invoice_payment_id');
  const parent = quoteIdent(sequelize, 'invoice_payments');

  /**
   * Dropped and recreated, because neither engine can alter a delete rule in
   * place. Not wrapped in a transaction on purpose: MySQL commits DDL
   * implicitly, so a transaction here would give a false impression that the
   * drop and the create succeed or fail together. They do not — which is why
   * the create is attempted even if the process died between the two, on the
   * next boot, by re-reading the state above.
   */
  await sequelize.query(
    isPostgres(sequelize)
      ? `ALTER TABLE ${receipts} DROP CONSTRAINT ${name}`
      : `ALTER TABLE ${receipts} DROP FOREIGN KEY ${name}`,
  );

  await sequelize.query(
    `ALTER TABLE ${receipts} ADD CONSTRAINT ${quoteIdent(sequelize, 'fk_receipts_invoice_payment')}`
    + ` FOREIGN KEY (${column}) REFERENCES ${parent} (${quoteIdent(sequelize, 'id')})`
    + ' ON DELETE SET NULL ON UPDATE CASCADE',
  );

  console.log('[receipts] invoice_payment_id no longer cascades — a receipt now '
    + 'survives the deletion of its payment');
};

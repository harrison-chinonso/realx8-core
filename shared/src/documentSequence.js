const { QueryTypes } = require('sequelize');
const { isMySQL } = require('./dialect');

/**
 * Assigns the next document number for a company, atomically.
 *
 * ── Why a counter and not MAX() + 1 ─────────────────────────────────────────
 *
 * Reading the highest number in use and adding one is correct only if nobody
 * else is doing it at the same moment. Under a burst — a bulk import, or an
 * impatient double-click — every request reads the SAME maximum, one wins the
 * unique index and the rest retry; they then contend for the next number, and
 * the next. Retrying harder does not fix that, it just moves the failure: a
 * measured burst of twelve concurrent creates exhausted five attempts and the
 * user got an error for a document that should simply have been numbered.
 *
 * This claims the number in a single statement instead, so there is nothing to
 * contend over. MySQL's LAST_INSERT_ID(expr) makes the increment and the read
 * of its result one atomic operation on one row.
 *
 * ── It stays honest about existing data ─────────────────────────────────────
 *
 * A counter can drift from reality — rows imported directly, a database
 * restored, this feature arriving on a table that already has documents. The
 * counter is therefore SEEDED from the highest number actually in use, and the
 * unique index remains the real guarantee: if the counter is ever behind, the
 * insert is refused and the caller retries, which re-seeds it.
 */

/**
 * company_id NULL becomes 0.
 *
 * A unique key treats NULLs as distinct, so a NULL company would get a new
 * counter row on every call and restart the numbering each time. Platform-level
 * documents get one shared counter under 0.
 */
const scopeOf = (companyId) => (companyId == null ? 0 : Number(companyId));

/**
 * Which connections have already had the table created, so it is created once
 * per process rather than once per document.
 *
 * ── Not an optimisation ─────────────────────────────────────────────────────
 *
 * CREATE TABLE IF NOT EXISTS is DDL, and DDL issued while another transaction
 * is open invalidates that transaction's cached table definitions — MySQL
 * fails it with "Table definition has changed, please retry transaction". So a
 * caller that creates a document INSIDE its own transaction (raising a debit
 * note for an overpayment as part of applying the payment, say) would have the
 * whole payment fail, not on the first run but on whichever run happened to be
 * the first since the table appeared.
 *
 * Running it once per process means the DDL happens at boot, when nothing else
 * is in flight, and every document afterwards is pure DML. `ensureTable` is
 * also called explicitly at service start so that the once is definitely then.
 *
 * Keyed on the connection object rather than a boolean, because a verification
 * script points a second connection at a throwaway database in the same
 * process and that one needs its own table.
 */
const ensured = new WeakSet();

const ensureTable = async (sequelize) => {
  if (ensured.has(sequelize)) return;

  if (isMySQL(sequelize)) {
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS document_sequences (
        company_scope INT UNSIGNED NOT NULL,
        doc_type VARCHAR(32) NOT NULL,
        next_value INT UNSIGNED NOT NULL DEFAULT 1,
        PRIMARY KEY (company_scope, doc_type)
      )
    `);
    ensured.add(sequelize);
    return;
  }

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS document_sequences (
      company_scope INTEGER NOT NULL,
      doc_type VARCHAR(32) NOT NULL,
      next_value INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (company_scope, doc_type)
    )
  `);
  ensured.add(sequelize);
};

/**
 * The highest number already used, so a counter starting on a populated table
 * does not hand out numbers that exist.
 */
const highestInUse = async (sequelize, { table, field, prefix, companyId, transaction }) => {
  const quote = sequelize.getQueryInterface().queryGenerator.quoteIdentifier.bind(
    sequelize.getQueryInterface().queryGenerator,
  );
  const fieldName = quote(field);
  const tableName = quote(table);
  const numberExpression = isMySQL(sequelize)
    ? `CAST(SUBSTRING(${fieldName}, :prefixLength) AS UNSIGNED)`
    : `CAST(SUBSTRING(${fieldName} FROM :prefixLength) AS INTEGER)`;
  const [row] = await sequelize.query(
    `SELECT MAX(${numberExpression}) AS highest
       FROM ${tableName}
      WHERE ${fieldName} LIKE :pattern
        AND company_id ${companyId == null ? 'IS NULL' : '= :companyId'}`,
    {
      replacements: {
        prefixLength: prefix.length + 1, // MySQL SUBSTRING is 1-indexed
        pattern: `${prefix}%`,
        ...(companyId == null ? {} : { companyId }),
      },
      type: QueryTypes.SELECT,
      transaction,
    },
  );
  return Number(row?.highest) || 0;
};

const claim = async (sequelize, { docType, table, field, prefix, companyId, transaction }) => {
  const scope = scopeOf(companyId);

  // Seed from the data, so a counter used for the first time on a populated
  // table does not hand out numbers that already exist. GREATEST never lowers
  // it, so deleted rows cannot cause a number to be reissued.
  const seed = await highestInUse(sequelize, { table, field, prefix, companyId, transaction });
  if (isMySQL(sequelize)) {
    await sequelize.query(
      `INSERT INTO document_sequences (company_scope, doc_type, next_value)
       VALUES (:scope, :docType, :seed)
       ON DUPLICATE KEY UPDATE next_value = GREATEST(next_value, :seed)`,
      { replacements: { scope, docType, seed }, type: QueryTypes.INSERT, transaction },
    );

    await sequelize.query(
      `INSERT INTO document_sequences (company_scope, doc_type, next_value)
       VALUES (:scope, :docType, 1)
       ON DUPLICATE KEY UPDATE next_value = LAST_INSERT_ID(next_value + 1)`,
      { replacements: { scope, docType }, type: QueryTypes.INSERT, transaction },
    );

    const [row] = await sequelize.query('SELECT LAST_INSERT_ID() AS value', {
      type: QueryTypes.SELECT, transaction,
    });
    const value = Number(row?.value) || 1;
    return `${prefix}${String(value).padStart(4, '0')}`;
  }

  await sequelize.query(
    `INSERT INTO document_sequences (company_scope, doc_type, next_value)
     VALUES (:scope, :docType, :seed)
     ON CONFLICT (company_scope, doc_type) DO UPDATE
     SET next_value = GREATEST(document_sequences.next_value, EXCLUDED.next_value)`,
    { replacements: { scope, docType, seed }, type: QueryTypes.INSERT, transaction },
  );

  const [row] = await sequelize.query(
    `INSERT INTO document_sequences (company_scope, doc_type, next_value)
     VALUES (:scope, :docType, 1)
     ON CONFLICT (company_scope, doc_type) DO UPDATE
     SET next_value = document_sequences.next_value + 1
     RETURNING next_value AS value`,
    { replacements: { scope, docType }, type: QueryTypes.SELECT, transaction },
  );

  const value = Number(row?.value) || 1;
  return `${prefix}${String(value).padStart(4, '0')}`;
};

/**
 * Claims the next number for (company, document type).
 *
 * ── The increment and its read MUST share a connection ──────────────────────
 *
 * LAST_INSERT_ID() is per-connection state. Sequelize runs each query on
 * whichever pooled connection is free, so issuing the increment and then
 * `SELECT LAST_INSERT_ID()` as two loose queries can read a value another
 * request set on that connection — or a stale one. Measured under twelve
 * concurrent creates that produced duplicate numbers: the unique index caught
 * every one and the retries recovered, but the numbering came out full of
 * gaps because each rejected attempt had already consumed a number.
 *
 * Wrapping them in a transaction pins both to one connection, which is what
 * makes the returned value this caller's own. A caller that already has a
 * transaction passes it in and it is used directly — nesting one here would
 * deadlock against the row locks the outer transaction already holds.
 */
const nextNumber = async (sequelize, { docType, table, field, prefix, companyId, transaction = null }) => {
  /**
   * Deliberately BEFORE the branch, and a no-op after the first call — see
   * `ensured`. A caller inside its own transaction relies on this having
   * happened already; the table is created at service start for that reason.
   */
  await ensureTable(sequelize);

  if (transaction) {
    return claim(sequelize, { docType, table, field, prefix, companyId, transaction });
  }

  const own = await sequelize.transaction();
  try {
    const reference = await claim(sequelize, {
      docType, table, field, prefix, companyId, transaction: own,
    });
    await own.commit();
    return reference;
  } catch (error) {
    await own.rollback();
    throw error;
  }
};

module.exports = { nextNumber, ensureTable, scopeOf };

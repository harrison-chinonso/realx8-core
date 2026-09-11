const { QueryTypes } = require('sequelize');

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

const ensureTable = async (sequelize) => {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS document_sequences (
      company_scope INT UNSIGNED NOT NULL,
      doc_type VARCHAR(32) NOT NULL,
      next_value INT UNSIGNED NOT NULL DEFAULT 1,
      PRIMARY KEY (company_scope, doc_type)
    )
  `);
};

/**
 * The highest number already used, so a counter starting on a populated table
 * does not hand out numbers that exist.
 */
const highestInUse = async (sequelize, { table, field, prefix, companyId, transaction }) => {
  const [row] = await sequelize.query(
    `SELECT MAX(CAST(SUBSTRING(\`${field}\`, :prefixLength) AS UNSIGNED)) AS highest
       FROM \`${table}\`
      WHERE \`${field}\` LIKE :pattern
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

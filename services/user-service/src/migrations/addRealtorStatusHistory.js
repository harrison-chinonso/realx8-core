const { QueryTypes } = require('sequelize');
const {
  isPostgres, columnsOf, tableExists, quoteIdent, indexExists,
  isDuplicateError, isDuplicateIndexError,
} = require('../../../../shared/src/dialect');
const { STATUS, statusFromAccount } = require('../../../../shared/src/realtorStatus');

/**
 * The append-only record of every realtor's standing over time.
 *
 * The commission engine's eligibility gate is checked at accrual and again at
 * every release, against the status AS OF that moment (FR-ELG-013). A current
 * status column cannot answer that, so this table does — see
 * shared/src/realtorStatus.js for why the distinction matters.
 *
 * ── The backfill is the interesting half ────────────────────────────────────
 *
 * Existing realtors have no history, and the gate refuses anybody it cannot
 * place — so without a seed row every entitlement on every existing realtor
 * would be forfeited the moment this ships. Each gets one row, dated to when
 * their account was created, reflecting what their current flags mean.
 *
 * Dating it to account creation rather than to now is deliberate. A deal
 * attributed last month is evaluated against last month, and a history that
 * began this morning would say "no status" and forfeit it. Backdating asserts
 * something we cannot actually know — that their standing never changed before
 * today — but it is the only assumption that leaves existing data payable, and
 * it is recorded as `administrative` so nobody mistakes it for an observation.
 */
const TABLE = 'realtor_status_history';

const createTable = async (sequelize) => {
  if (await tableExists(sequelize, TABLE)) return;

  await sequelize.query(isPostgres(sequelize)
    ? `CREATE TABLE ${TABLE} (
         id BIGSERIAL PRIMARY KEY,
         user_id INTEGER NOT NULL,
         status VARCHAR(20) NOT NULL,
         reason VARCHAR(40) NULL,
         note TEXT NULL,
         changed_by INTEGER NULL,
         effective_from TIMESTAMP WITH TIME ZONE NOT NULL,
         created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
       )`
    : `CREATE TABLE ${TABLE} (
         id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
         user_id INT UNSIGNED NOT NULL,
         status VARCHAR(20) NOT NULL,
         reason VARCHAR(40) NULL,
         note TEXT NULL,
         changed_by INT UNSIGNED NULL,
         effective_from DATETIME NOT NULL,
         created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
};

/**
 * The lookup is always "this realtor, at or before this instant", so the index
 * is on exactly that and in that order — a scan of one realtor's transitions is
 * never more than a handful of rows.
 */
const INDEXES = [
  ['ix_realtor_status_user_effective', ['user_id', 'effective_from']],
];

const addIndexes = async (sequelize) => {
  for (const [name, columns] of INDEXES) {
    // eslint-disable-next-line no-await-in-loop
    if (await indexExists(sequelize, TABLE, name)) continue;
    const cols = columns.map((column) => quoteIdent(sequelize, column)).join(', ');
    // eslint-disable-next-line no-await-in-loop
    await sequelize.query(
      `CREATE INDEX ${quoteIdent(sequelize, name)} ON ${quoteIdent(sequelize, TABLE)} (${cols})`,
    ).catch((error) => {
      // A concurrent boot won the race between the check and the create.
      if (!isDuplicateIndexError(error)) throw error;
    });
  }
};

/** The cached "where are they now", for list screens. Never read historically. */
const addStatusColumn = async (sequelize) => {
  const columns = await columnsOf(sequelize, 'users');
  if (!columns || columns.has('realtor_status')) return;

  await sequelize.query(
    `ALTER TABLE ${quoteIdent(sequelize, 'users')} ADD COLUMN realtor_status VARCHAR(20) NULL`,
  ).catch((error) => { if (!isDuplicateError(error)) throw error; });
};

const backfill = async (sequelize) => {
  /**
   * Only realtors, and only those with no history yet.
   *
   * Restricted to realtors because they are the only accounts the commission
   * engine ever asks about (§5.10) — seeding every client and admin would
   * multiply the table by ten for rows nothing will read.
   */
  const pending = await sequelize.query(
    `SELECT u.id, u.is_active, u.deleted_at, u.created_at
       FROM users u
       LEFT JOIN ${TABLE} h ON h.user_id = u.id
      WHERE u.type = 'realtor' AND h.id IS NULL`,
    { type: QueryTypes.SELECT },
  );
  if (!pending.length) return 0;

  for (const account of pending) {
    const status = statusFromAccount(account);
    // eslint-disable-next-line no-await-in-loop
    await sequelize.query(
      `INSERT INTO ${TABLE} (user_id, status, reason, note, effective_from, created_at)
       VALUES (:userId, :status, 'administrative',
               'Seeded from the account''s existing flags when status history was introduced.',
               :from, NOW())`,
      {
        replacements: {
          userId: account.id,
          status,
          from: account.created_at || new Date(),
        },
        type: QueryTypes.INSERT,
      },
    );
  }

  await sequelize.query(
    `UPDATE users SET realtor_status = CASE
        WHEN deleted_at IS NOT NULL THEN '${STATUS.TERMINATED}'
        WHEN is_active IS TRUE THEN '${STATUS.ACTIVE}'
        ELSE '${STATUS.INACTIVE}' END
      WHERE type = 'realtor' AND realtor_status IS NULL`,
  );

  return pending.length;
};

module.exports = async (sequelize) => {
  try {
    await createTable(sequelize);
    await addIndexes(sequelize);
    await addStatusColumn(sequelize);
    const seeded = await backfill(sequelize);
    if (seeded) {
      console.log(`[realtor-status] seeded standing for ${seeded} realtor(s) from their account flags`);
    }
  } catch (error) {
    // Never block a boot. A missing history means the commission gate refuses
    // to accrue, which is the safe direction and is visible immediately.
    console.error(`[realtor-status] could not prepare the status history: ${error.message}`);
  }
};

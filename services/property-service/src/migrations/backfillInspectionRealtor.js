const { isPostgres } = require('../../../../shared/src/dialect');

/**
 * Populates inspections.realtor_id from the free-text realtor_name for rows
 * created before the column existed, so realtor-scoped listing does not hide
 * an inspection that is genuinely theirs.
 *
 * Only unambiguous matches are bound: if two realtors in a company share a
 * name, the row is left null (visible to admins, not mis-assigned).
 * Idempotent — only touches rows where realtor_id IS NULL.
 *
 * ── Why it speaks both engines ──────────────────────────────────────────────
 *
 * The legacy rows this exists for are in production, and production is
 * Postgres. Written MySQL-only — `UPDATE ... JOIN`, which Postgres spells
 * `UPDATE ... FROM` — it could only ever have run against the development
 * database, where there is nothing much to backfill. The catch below is a
 * backstop for a missing table, not a licence to be one-engine: it would have
 * turned the syntax error into a one-line warning nobody reads.
 */

/**
 * The matchable realtors: one row per (name, company) that is unambiguous.
 *
 * Identical on both engines, which is why it is written once and embedded in
 * each UPDATE rather than duplicated.
 */
const UNAMBIGUOUS_REALTORS = `
  SELECT TRIM(LOWER(u.name)) AS uname, u.company_id, MIN(u.id) AS user_id
    FROM users u
   WHERE u.type = 'realtor'
   GROUP BY TRIM(LOWER(u.name)), u.company_id
  HAVING COUNT(*) = 1`;

const MATCH = `m.uname = TRIM(LOWER(i.realtor_name))
           AND (m.company_id = i.company_id OR i.company_id IS NULL)`;

/**
 * How many rows an UPDATE touched, whichever driver answered.
 *
 * mysql2 reports affectedRows on an OkPacket; pg reports rowCount on its
 * Result, and Sequelize hands each straight back. Reading only the MySQL shape
 * would log "0 linked" on Postgres however many rows it actually bound.
 */
const affectedBy = (result, metadata) => Number(
  result?.affectedRows
  ?? (typeof metadata === 'number' ? metadata : metadata?.rowCount ?? metadata?.affectedRows)
  ?? 0,
);

module.exports = async function backfillInspectionRealtor(sequelize) {
  const sql = isPostgres(sequelize)
    ? `UPDATE inspections i
          SET realtor_id = m.user_id
         FROM (${UNAMBIGUOUS_REALTORS}) m
        WHERE i.realtor_id IS NULL
          AND ${MATCH}`
    : `UPDATE inspections i
         JOIN (${UNAMBIGUOUS_REALTORS}) m
           ON ${MATCH}
          SET i.realtor_id = m.user_id
        WHERE i.realtor_id IS NULL`;

  try {
    const [result, metadata] = await sequelize.query(sql);
    const linked = affectedBy(result, metadata);
    if (linked) console.log(`[migration] linked ${linked} inspection(s) to a realtor id`);
  } catch (error) {
    // Never block boot on a best-effort backfill.
    console.warn('[migration] inspection realtor backfill skipped:', error.message);
  }
};

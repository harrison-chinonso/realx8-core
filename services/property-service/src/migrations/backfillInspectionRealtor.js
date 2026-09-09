/**
 * Populates inspections.realtor_id from the free-text realtor_name for rows
 * created before the column existed, so realtor-scoped listing does not hide
 * an inspection that is genuinely theirs.
 *
 * Only unambiguous matches are bound: if two realtors in a company share a
 * name, the row is left null (visible to admins, not mis-assigned).
 * Idempotent — only touches rows where realtor_id IS NULL.
 */
module.exports = async function backfillInspectionRealtor(sequelize) {
  try {
    const [result] = await sequelize.query(`
      UPDATE inspections i
        JOIN (
          SELECT TRIM(LOWER(u.name)) AS uname, u.company_id, MIN(u.id) AS user_id
            FROM users u
           WHERE u.type = 'realtor'
           GROUP BY TRIM(LOWER(u.name)), u.company_id
          HAVING COUNT(*) = 1
        ) m
          ON m.uname = TRIM(LOWER(i.realtor_name))
         AND (m.company_id = i.company_id OR i.company_id IS NULL)
         SET i.realtor_id = m.user_id
       WHERE i.realtor_id IS NULL
    `);
    if (result?.affectedRows) {
      console.log(`[migration] linked ${result.affectedRows} inspection(s) to a realtor id`);
    }
  } catch (error) {
    // Never block boot on a best-effort backfill.
    console.warn('[migration] inspection realtor backfill skipped:', error.message);
  }
};

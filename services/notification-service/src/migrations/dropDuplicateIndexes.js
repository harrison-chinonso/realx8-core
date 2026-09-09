/**
 * Idempotent pre-sync cleanup: drops any _2, _3, ... suffixed duplicate indexes
 * that Sequelize alter:true may have created on previous restarts.
 */
module.exports = async function dropDuplicateIndexes(sequelize) {
  const safeQuery = async (sql) => {
    try { await sequelize.query(sql); } catch (_) {}
  };

  const [dupes] = await sequelize.query(`
    SELECT TABLE_NAME, INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND NON_UNIQUE = 0
      AND INDEX_NAME != 'PRIMARY'
      AND (INDEX_NAME REGEXP '_[2-9]$' OR INDEX_NAME REGEXP '_[0-9]{2,}$')
    GROUP BY TABLE_NAME, INDEX_NAME
  `).catch(() => [[]]);

  for (const { TABLE_NAME, INDEX_NAME } of dupes) {
    await safeQuery(`ALTER TABLE \`${TABLE_NAME}\` DROP INDEX \`${INDEX_NAME}\``);
  }
};

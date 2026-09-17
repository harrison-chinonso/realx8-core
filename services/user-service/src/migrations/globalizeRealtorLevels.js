/**
 * The ladder the platform ships: Basic, Professional, Premium, Ambassador,
 * owned by nobody (company_id IS NULL) and free to climb.
 *
 * Every company starts on it. A company that changes anything gets its own
 * copy and stops sharing this one — see shared/src/realtorLevel.js for the
 * rule and realtorLevelController.saveLadder for the copy.
 *
 * The first cut seeded the four defaults into every company, which made one
 * ladder look duplicated to anyone who could see across companies. This moves
 * the defaults to a single global set and clears the per-company copies —
 * but only the untouched, unused ones, so a company's own additions survive.
 *
 * Re-seeds whenever the global ladder is EMPTY, not only on a fresh database.
 * A deployment with no platform rungs has no ladder at all for a company that
 * has not made its own, and the symptom is a Realtor Levels page showing
 * nothing — which reads as the feature being broken rather than unseeded.
 */
const DEFAULT_LEVELS = ['Basic', 'Professional', 'Premium', 'Ambassador'];

module.exports = async function globalizeRealtorLevels(sequelize) {
  const [globals] = await sequelize.query(
    'SELECT id FROM realtor_levels WHERE company_id IS NULL',
  );

  if (!globals.length) {
    for (let i = 0; i < DEFAULT_LEVELS.length; i += 1) {
      await sequelize.query(
        // `TRUE`, not `1`. is_active is a BOOLEAN on Postgres, which refuses
        // an integer outright — so on production this insert threw and the
        // platform ladder was never seeded at all.
        `INSERT INTO realtor_levels (name, position, is_active, company_id, created_at, updated_at)
         VALUES (:name, :position, TRUE, NULL, NOW(), NOW())`,
        // Gaps of 10 leave room for a company to slot a level between defaults.
        { replacements: { name: DEFAULT_LEVELS[i], position: (i + 1) * 10 } },
      );
    }
    console.log(`[migration] seeded ${DEFAULT_LEVELS.length} global realtor levels`);
  }

  // Drop the old per-company copies of the defaults — but never one that a
  // realtor sits on or a request points at, and never a company's own level.
  const [stale] = await sequelize.query(
    `SELECT l.id, l.name, l.company_id
       FROM realtor_levels l
      WHERE l.company_id IS NOT NULL
        AND l.name IN (:names)
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.realtor_level_id = l.id)
        AND NOT EXISTS (
          SELECT 1 FROM realtor_level_requests r
           WHERE r.requested_level_id = l.id OR r.current_level_id = l.id
        )`,
    { replacements: { names: DEFAULT_LEVELS } },
  );

  for (const level of stale) {
    await sequelize.query('DELETE FROM realtor_levels WHERE id = :id', { replacements: { id: level.id } });
  }
  if (stale.length) {
    console.log(`[migration] removed ${stale.length} duplicated per-company default level(s)`);
  }
};

/**
 * True when `sequelize` is connected to MySQL. Used to gate the legacy,
 * MySQL-only raw-SQL migrations in each service's `migrations/` folder — they
 * exist purely to evolve an EXISTING MySQL installation forward, and have
 * nothing to do on a fresh database of any dialect, Postgres included, where
 * `sequelize.sync()` already creates the correct schema from the current
 * models.
 */
const isMySQL = (sequelize) => sequelize.getDialect() === 'mysql';

module.exports = { isMySQL };

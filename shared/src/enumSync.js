const { isPostgres, enumValues, widenEnum } = require('./dialect');

/**
 * Makes every enum column in the database accept what its MODEL says it should.
 *
 * ── Why this has to exist at all ────────────────────────────────────────────
 *
 * On MySQL an enum is part of the column, and `sync({ alter: true })` rewrites
 * the column, so adding a value to a model is enough — the schema follows.
 *
 * On Postgres an enum is a TYPE that the column merely references, and
 * Sequelize will not add values to a type that already exists. So adding a
 * value to a model changes nothing in the database, and the first row that uses
 * it fails with
 *
 *     invalid input value for enum <type>: "<value>"
 *
 * — in production, on a code path that works perfectly in development. There is
 * no error at deploy time and nothing in the logs until a user hits it.
 *
 * ── Why per-model rather than per-migration ─────────────────────────────────
 *
 * The first fix for this was a migration that widened one column on one table.
 * That is correct and it is not enough: there are sixty-five enum columns
 * across forty-two models, and the next one to change would fail in exactly the
 * same way, needing exactly the same migration written again by someone who
 * remembered this class of bug existed.
 *
 * Reading the models instead means the rule is "the database accepts what the
 * code believes", enforced for every enum at once, including ones added later
 * by people who never read this file.
 *
 * ── It only ever WIDENS ─────────────────────────────────────────────────────
 *
 * A value removed from a model is left in the database. Narrowing is a
 * different and much more dangerous operation: it can only be done once no row
 * uses the retired value, and deciding what to do with the rows that do is a
 * business question. A stale value that nothing writes is harmless; a migration
 * that silently rewrote rows to make a type fit would not be.
 *
 * See migrateCommissionLifecycle.js for what a deliberate narrowing looks like.
 */

/** The enum attributes of one model, as [column, values] pairs. */
const enumAttributes = (model) => {
  const attributes = typeof model.getAttributes === 'function'
    ? model.getAttributes()
    : model.rawAttributes || {};

  return Object.entries(attributes)
    .filter(([, attribute]) => String(attribute?.type?.key || '').toUpperCase() === 'ENUM')
    .map(([column, attribute]) => [
      // The database column, which is not always the attribute name.
      attribute.field || column,
      Array.isArray(attribute.type?.values) ? attribute.type.values : [],
    ])
    .filter(([, values]) => values.length);
};

/**
 * Reconciles every model's enums with the database.
 *
 * Never throws. A database that cannot be widened is a problem worth reporting,
 * but it must not be the reason the application will not start — the running
 * code is usually still correct for every value already in the type.
 *
 * @returns {Array<{table: string, column: string, added: string[]}>} what changed
 */
const syncEnums = async (sequelize, { logger = console } = {}) => {
  const changes = [];

  for (const model of Object.values(sequelize.models || {})) {
    const table = model.getTableName();
    // A schema-qualified table comes back as an object; those are not in use
    // here and reconciling one would need the schema threading through.
    if (typeof table !== 'string') continue;

    for (const [column, expected] of enumAttributes(model)) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const accepted = await enumValues(sequelize, table, column);
        // An empty list means the column is not an enum in the database — a
        // table this service does not own, or one sync has not created yet.
        if (!accepted.length) continue;

        const missing = expected.filter((value) => !accepted.includes(value));
        if (!missing.length) continue;

        // eslint-disable-next-line no-await-in-loop
        const added = await widenEnum(sequelize, table, column, expected);
        if (added.length) {
          changes.push({ table, column, added });
          logger.log?.(`[enums] ${table}.${column} now accepts ${added.join(', ')}`);
        }
      } catch (error) {
        logger.warn?.(`[enums] could not reconcile ${table}.${column}: ${error.message}`);
      }
    }
  }

  return changes;
};

/**
 * Reports where the database and the models disagree, without changing
 * anything. Used by the diagnostic, and useful in a deploy check.
 */
const enumDrift = async (sequelize) => {
  const drift = [];

  for (const model of Object.values(sequelize.models || {})) {
    const table = model.getTableName();
    if (typeof table !== 'string') continue;

    for (const [column, expected] of enumAttributes(model)) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const accepted = await enumValues(sequelize, table, column);
        if (!accepted.length) continue;
        const missing = expected.filter((v) => !accepted.includes(v));
        const retired = accepted.filter((v) => !expected.includes(v));
        if (missing.length || retired.length) {
          drift.push({ table, column, accepted, expected, missing, retired });
        }
      } catch { /* unreadable column — not drift we can report on */ }
    }
  }

  return drift;
};

module.exports = { syncEnums, enumDrift, enumAttributes, isPostgres };

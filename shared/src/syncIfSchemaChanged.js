const crypto = require('crypto');
const { isPostgres } = require('./dialect');

/**
 * Skips `sequelize.sync({ alter: true })` when nothing has changed since the
 * last successful boot.
 *
 * ── The problem ──────────────────────────────────────────────────────────
 *
 * Every service in platform/boot.js runs `sync({ alter: true })` on EVERY
 * boot, not only when a model actually changed. That call diffs every table
 * against the database — columns, types, indexes — which is a handful of
 * metadata round trips per table. Over a real network to a hosted Postgres
 * (Neon), at 21-38 tables per service, that adds up to 60-105 seconds per
 * service and several minutes for the whole process — long enough that a
 * platform with its own deploy-health timeout (Render) gives up and rolls
 * the deploy back, even though the boot was healthy and simply slow.
 *
 * ── The fix, and why it is safe ─────────────────────────────────────────────
 *
 * A fingerprint of the CURRENT code's model definitions (columns, indexes)
 * is compared against the fingerprint stored from the last boot that
 * actually ran sync(). If they match, AND every model's table still exists
 * in the database, sync() is skipped entirely — the code has not changed
 * since the last boot proved the schema matches it, so there is nothing to
 * diff.
 *
 * The failure mode to guard against is a skip that should not have
 * happened — the database drifted from what the fingerprint assumes
 * without the code changing (someone dropped a table by hand, a DB was
 * restored from an older backup). The table-existence check catches the
 * common shape of that (a whole table missing); it does not catch a single
 * column having been altered outside of a deploy, but nothing short of
 * running the diff every time would, and that is precisely the cost this
 * exists to avoid. Every other path — first boot ever, a real model change,
 * a database that failed the existence check, or any error reading/writing
 * the fingerprint — falls back to running sync() unconditionally, which is
 * the safe direction to fail in.
 */

const FINGERPRINT_TABLE = 'schema_boot_fingerprints';

const ensureFingerprintTable = async (sequelize) => {
  await sequelize.query(`CREATE TABLE IF NOT EXISTS ${FINGERPRINT_TABLE} (
    service_name VARCHAR(64) PRIMARY KEY,
    fingerprint VARCHAR(64) NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
};

/** Functions, Sequelize.fn()/literal() wrappers, and plain values all need to
 *  serialise into something both stable across restarts and comparable. */
const normalizeDefault = (value) => {
  if (typeof value === 'function') return `fn:${value.name || 'anonymous'}`;
  if (value === undefined) return null;
  if (value && typeof value === 'object') return String(value);
  return value;
};

const normalizeReference = (references) => {
  if (!references) return null;
  const model = references.model;
  return {
    model: typeof model === 'string' ? model : (model?.tableName || model?.name || null),
    key: references.key || null,
  };
};

/** One model's shape — the exact things sync({alter:true}) would otherwise
 *  have to ask the database about, one query at a time. */
const fingerprintModel = (model) => {
  const attributes = model.rawAttributes || {};
  const columns = Object.keys(attributes).sort().map((key) => {
    const attribute = attributes[key];
    return {
      key,
      field: attribute.field || key,
      type: String(attribute.type),
      allowNull: attribute.allowNull !== false,
      primaryKey: !!attribute.primaryKey,
      autoIncrement: !!attribute.autoIncrement,
      unique: attribute.unique ? (typeof attribute.unique === 'string' ? attribute.unique : true) : false,
      defaultValue: normalizeDefault(attribute.defaultValue),
      references: normalizeReference(attribute.references),
    };
  });

  const indexes = (model.options?.indexes || [])
    .map((index) => ({
      name: index.name || null,
      unique: !!index.unique,
      fields: (index.fields || [])
        .map((field) => (typeof field === 'string' ? field : field.name || field.attribute))
        .sort(),
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  const table = model.getTableName();
  return {
    table: typeof table === 'string' ? table : table?.tableName,
    columns,
    indexes,
  };
};

const fingerprintAllModels = (sequelize) => {
  const modelNames = Object.keys(sequelize.models).sort();
  const shape = modelNames.map((name) => fingerprintModel(sequelize.models[name]));
  return crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex');
};

/** One cheap query (SHOW TABLES / information_schema, whichever the dialect
 *  uses) rather than one per model — this is only ever a safety check, not
 *  the expensive diff sync() itself does. */
const allTablesExist = async (sequelize) => {
  const rows = await sequelize.getQueryInterface().showAllTables();
  const existing = new Set(rows.map((row) => (typeof row === 'string' ? row : row.tableName).toLowerCase()));
  return Object.values(sequelize.models).every((model) => {
    const table = model.getTableName();
    const name = (typeof table === 'string' ? table : table?.tableName || '').toLowerCase();
    return existing.has(name);
  });
};

const readStoredFingerprint = async (sequelize, serviceName) => {
  const [row] = await sequelize.query(
    `SELECT fingerprint FROM ${FINGERPRINT_TABLE} WHERE service_name = :serviceName`,
    { replacements: { serviceName }, type: sequelize.QueryTypes.SELECT },
  );
  return row?.fingerprint || null;
};

const writeStoredFingerprint = async (sequelize, serviceName, fingerprint) => {
  if (isPostgres(sequelize)) {
    await sequelize.query(
      `INSERT INTO ${FINGERPRINT_TABLE} (service_name, fingerprint, updated_at)
       VALUES (:serviceName, :fingerprint, CURRENT_TIMESTAMP)
       ON CONFLICT (service_name)
       DO UPDATE SET fingerprint = EXCLUDED.fingerprint, updated_at = CURRENT_TIMESTAMP`,
      { replacements: { serviceName, fingerprint } },
    );
  } else {
    await sequelize.query(
      `INSERT INTO ${FINGERPRINT_TABLE} (service_name, fingerprint, updated_at)
       VALUES (:serviceName, :fingerprint, CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE fingerprint = VALUES(fingerprint), updated_at = CURRENT_TIMESTAMP`,
      { replacements: { serviceName, fingerprint } },
    );
  }
};

/**
 * @param {import('sequelize').Sequelize} sequelize
 * @param {{ serviceName: string, alter?: boolean, logger?: Console }} options
 */
const syncIfSchemaChanged = async (sequelize, { serviceName, alter = true, logger = console } = {}) => {
  if (!serviceName) throw new Error('syncIfSchemaChanged requires a serviceName');

  const fingerprint = fingerprintAllModels(sequelize);
  let skip = false;

  try {
    await ensureFingerprintTable(sequelize);
    const stored = await readStoredFingerprint(sequelize, serviceName);
    skip = stored === fingerprint && await allTablesExist(sequelize);
  } catch (error) {
    // Any failure here (permissions, a locked table, a transient network
    // blip) falls through to the safe side: sync runs, same as before this
    // existed.
    logger.warn(`[boot] ${serviceName}: schema-fingerprint check failed (${error.message}) — syncing unconditionally.`);
    skip = false;
  }

  if (skip) {
    logger.info(`[boot] ${serviceName}: schema unchanged since last boot — skipping sync({ alter: true })`);
    return;
  }

  await sequelize.sync({ alter });

  try {
    await writeStoredFingerprint(sequelize, serviceName, fingerprint);
  } catch (error) {
    // Not recording it just means the NEXT boot syncs unconditionally too —
    // slower, never wrong.
    logger.warn(`[boot] ${serviceName}: could not record the schema fingerprint (${error.message}).`);
  }
};

module.exports = { syncIfSchemaChanged };

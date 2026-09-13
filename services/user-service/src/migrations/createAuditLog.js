const { QueryTypes } = require('sequelize');
const { isPostgres, tableExists, quoteIdent } = require('../../../../shared/src/dialect');

/**
 * The audit table, and the guarantee that it is append-only.
 *
 * Creating the table is the easy half — sync({ force: false }) would do it, and
 * does on a fresh database. This runs BEFORE sync because eight other services
 * start writing to `audit_logs` as soon as they are up, and in the split
 * deployment they race user-service to get there. A table that appears halfway
 * through boot means the first few minutes of every deploy are silently
 * unaudited.
 *
 * The triggers are the half that cannot be expressed in a model. Sequelize
 * hooks refuse an update made THROUGH the model; they do nothing about a raw
 * query, another service, a migration, or somebody at a psql prompt. "An audit
 * cannot be edited or deleted" is only true if the database is the thing
 * enforcing it.
 *
 * ── When the triggers cannot be installed ───────────────────────────────────
 *
 * A managed database may not grant TRIGGER. That is logged and tolerated rather
 * than fatal: the application-level hooks still hold, and a deployment that
 * refuses to boot over a hardening measure is worse than one that boots without
 * it and says so. The message is deliberately loud, because an operator needs
 * to know which guarantee they actually have.
 */

const CREATE_SQL = (sequelize) => (isPostgres(sequelize)
  ? `CREATE TABLE IF NOT EXISTS audit_logs (
       id BIGSERIAL PRIMARY KEY,
       company_id INTEGER NULL,
       actor_id INTEGER NULL,
       actor_name VARCHAR(190) NULL,
       actor_email VARCHAR(190) NULL,
       actor_type VARCHAR(40) NULL,
       actor_company_id INTEGER NULL,
       actor_is_platform BOOLEAN NOT NULL DEFAULT FALSE,
       action VARCHAR(120) NOT NULL,
       action_label VARCHAR(190) NULL,
       module VARCHAR(60) NULL,
       entity_type VARCHAR(60) NULL,
       entity_id VARCHAR(64) NULL,
       entity_label VARCHAR(190) NULL,
       method VARCHAR(10) NULL,
       path VARCHAR(255) NULL,
       status_code INTEGER NULL,
       ip VARCHAR(64) NULL,
       user_agent VARCHAR(255) NULL,
       metadata TEXT NULL,
       created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
     )`
  : `CREATE TABLE IF NOT EXISTS audit_logs (
       id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
       company_id INT UNSIGNED NULL,
       actor_id INT UNSIGNED NULL,
       actor_name VARCHAR(190) NULL,
       actor_email VARCHAR(190) NULL,
       actor_type VARCHAR(40) NULL,
       actor_company_id INT UNSIGNED NULL,
       actor_is_platform TINYINT(1) NOT NULL DEFAULT 0,
       action VARCHAR(120) NOT NULL,
       action_label VARCHAR(190) NULL,
       module VARCHAR(60) NULL,
       entity_type VARCHAR(60) NULL,
       entity_id VARCHAR(64) NULL,
       entity_label VARCHAR(190) NULL,
       method VARCHAR(10) NULL,
       path VARCHAR(255) NULL,
       status_code INT NULL,
       ip VARCHAR(64) NULL,
       user_agent VARCHAR(255) NULL,
       metadata TEXT NULL,
       created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

const INDEXES = [
  ['ix_audit_logs_company_created', ['company_id', 'created_at']],
  ['ix_audit_logs_actor_created', ['actor_id', 'created_at']],
  ['ix_audit_logs_action', ['action']],
  ['ix_audit_logs_entity', ['entity_type', 'entity_id']],
  ['ix_audit_logs_created', ['created_at']],
];

const indexExists = async (sequelize, name) => {
  const sql = isPostgres(sequelize)
    ? `SELECT 1 FROM pg_indexes WHERE schemaname = CURRENT_SCHEMA() AND tablename = 'audit_logs' AND indexname = :name LIMIT 1`
    : `SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'audit_logs' AND index_name = :name LIMIT 1`;
  const rows = await sequelize.query(sql, { replacements: { name }, type: QueryTypes.SELECT });
  return rows.length > 0;
};

const REFUSAL = 'audit_logs is append-only: entries cannot be modified or deleted.';

const installGuards = async (sequelize) => {
  if (isPostgres(sequelize)) {
    await sequelize.query(`
      CREATE OR REPLACE FUNCTION audit_logs_refuse_change() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION '${REFUSAL}';
      END;
      $$ LANGUAGE plpgsql;
    `);
    // DROP first so a re-run replaces rather than fails; CREATE OR REPLACE
    // TRIGGER is not available before Postgres 14.
    await sequelize.query('DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs');
    await sequelize.query('DROP TRIGGER IF EXISTS audit_logs_no_delete ON audit_logs');
    await sequelize.query(`CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
                           FOR EACH ROW EXECUTE FUNCTION audit_logs_refuse_change()`);
    await sequelize.query(`CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
                           FOR EACH ROW EXECUTE FUNCTION audit_logs_refuse_change()`);
    return;
  }

  await sequelize.query('DROP TRIGGER IF EXISTS audit_logs_no_update');
  await sequelize.query('DROP TRIGGER IF EXISTS audit_logs_no_delete');
  await sequelize.query(
    `CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs FOR EACH ROW
       SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${REFUSAL}'`,
  );
  await sequelize.query(
    `CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs FOR EACH ROW
       SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${REFUSAL}'`,
  );
};

module.exports = async (sequelize) => {
  if (!(await tableExists(sequelize, 'audit_logs'))) {
    await sequelize.query(CREATE_SQL(sequelize));
  }

  for (const [name, columns] of INDEXES) {
    // eslint-disable-next-line no-await-in-loop
    if (await indexExists(sequelize, name)) continue;
    const cols = columns.map((column) => quoteIdent(sequelize, column)).join(', ');
    // eslint-disable-next-line no-await-in-loop
    await sequelize.query(
      `CREATE INDEX ${quoteIdent(sequelize, name)} ON ${quoteIdent(sequelize, 'audit_logs')} (${cols})`,
    ).catch(() => { /* a concurrent boot created it first */ });
  }

  try {
    await installGuards(sequelize);
  } catch (error) {
    console.error(
      '[audit] Could not install the append-only database triggers on audit_logs '
      + `(${error.message}). Audit entries are still refused by the application, `
      + 'but a direct database connection could alter them. Grant TRIGGER to fix this.',
    );
  }
};

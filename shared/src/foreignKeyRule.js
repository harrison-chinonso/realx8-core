const { QueryTypes } = require('sequelize');
const { isPostgres, quoteIdent, tableExists, columnsOf } = require('./dialect');

/**
 * Reading and changing a foreign key's ON DELETE rule, on either engine.
 *
 * Extracted because there are now two migrations that need it and the part that
 * differs between MySQL and Postgres is the part nobody remembers: MySQL keeps
 * delete rules in information_schema.REFERENTIAL_CONSTRAINTS, Postgres keeps
 * them as a single character in pg_constraint.confdeltype, and the statement
 * that drops a constraint is spelled differently in each.
 *
 * Every function here is safe to call against a table or column that does not
 * exist — migrations run on databases at every age, and one that throws because
 * a table has not been created yet takes the whole service down on boot.
 */

/** MySQL's word for each of Postgres's single-character delete rules. */
const PG_RULES = {
  a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT',
};

/**
 * The foreign key on `table.column`, and what it currently does on delete.
 * Returns null when there is no constraint there at all.
 */
const foreignKeyOn = async (sequelize, table, column) => {
  if (!await tableExists(sequelize, table)) return null;
  const columns = await columnsOf(sequelize, table);
  if (!columns?.has(column)) return null;

  if (isPostgres(sequelize)) {
    const [row] = await sequelize.query(
      `SELECT con.conname AS name, con.confdeltype AS rule_code,
              parent.relname AS references_table
         FROM pg_constraint con
         JOIN pg_class child ON child.oid = con.conrelid
         JOIN pg_class parent ON parent.oid = con.confrelid
         JOIN pg_attribute att ON att.attrelid = child.oid AND att.attnum = ANY (con.conkey)
        WHERE con.contype = 'f' AND child.relname = :table AND att.attname = :column
        LIMIT 1`,
      { replacements: { table, column }, type: QueryTypes.SELECT },
    );
    if (!row) return null;
    return {
      name: row.name,
      delete_rule: PG_RULES[row.rule_code] || null,
      references_table: row.references_table,
    };
  }

  const [row] = await sequelize.query(
    `SELECT k.CONSTRAINT_NAME AS name, r.DELETE_RULE AS delete_rule,
            k.REFERENCED_TABLE_NAME AS references_table
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        AND r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
      WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = :table
        AND k.COLUMN_NAME = :column AND k.REFERENCED_TABLE_NAME IS NOT NULL
      LIMIT 1`,
    { replacements: { table, column }, type: QueryTypes.SELECT },
  );
  return row || null;
};

/**
 * Change what a foreign key does on delete.
 *
 * ── What it deliberately will NOT do ────────────────────────────────────────
 *
 * It never CREATES a constraint. A table with no foreign key cannot cascade, so
 * there is nothing here to fix; adding one would be a new guarantee rather than
 * the removal of a harmful one, and it would fail on any installation holding
 * rows that already point at parents that are gone.
 *
 * Not wrapped in a transaction, on purpose. MySQL commits DDL implicitly, so a
 * transaction would give the false impression that the drop and the re-create
 * succeed or fail together. They do not — which is why this re-reads the state
 * every time and can finish a job interrupted halfway on the next boot.
 *
 * @returns {{ changed: boolean, from?: string, to?: string, reason?: string }}
 */
const setDeleteRule = async (sequelize, {
  table, column, references, referencesColumn = 'id', rule, constraintName,
}) => {
  const existing = await foreignKeyOn(sequelize, table, column);
  if (!existing) return { changed: false, reason: 'no_constraint' };

  const target = String(rule).toUpperCase();
  if (String(existing.delete_rule).toUpperCase() === target) {
    return { changed: false, reason: 'already_set', from: existing.delete_rule };
  }

  const child = quoteIdent(sequelize, table);
  const parent = quoteIdent(sequelize, references || existing.references_table);

  await sequelize.query(
    isPostgres(sequelize)
      ? `ALTER TABLE ${child} DROP CONSTRAINT ${quoteIdent(sequelize, existing.name)}`
      : `ALTER TABLE ${child} DROP FOREIGN KEY ${quoteIdent(sequelize, existing.name)}`,
  );

  await sequelize.query(
    `ALTER TABLE ${child} ADD CONSTRAINT `
    + `${quoteIdent(sequelize, constraintName || `fk_${table}_${column}`)} `
    + `FOREIGN KEY (${quoteIdent(sequelize, column)}) `
    + `REFERENCES ${parent} (${quoteIdent(sequelize, referencesColumn)}) `
    + `ON DELETE ${target} ON UPDATE CASCADE`,
  );

  return { changed: true, from: existing.delete_rule, to: target };
};

module.exports = { foreignKeyOn, setDeleteRule, PG_RULES };

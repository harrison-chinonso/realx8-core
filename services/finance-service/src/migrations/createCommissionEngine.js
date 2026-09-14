const {
  isPostgres, tableExists, quoteIdent, indexExists, isDuplicateIndexError,
} = require('../../../../shared/src/dialect');

/**
 * The commission engine's tables: plans, their immutable versions, the
 * entitlements a calculation produces, and the ledger those post to.
 *
 * shared/src/commission/ is the arithmetic and knows nothing about a database.
 * This is where its answers are kept.
 *
 * ── Why the rules are one JSON document and not a table of rows ─────────────
 *
 * A plan VERSION is immutable by definition (§5.6): a deal resolves the version
 * in force at its attribution date, and changing a plan must never restate what
 * an old deal paid. Nothing ever updates a version's rules — editing a plan
 * writes a NEW version. So the usual reason to normalise, that rows get edited
 * independently, does not arise.
 *
 * What does arise is the opposite need: the engine takes a plan as one plain
 * object, and a version has to still mean in five years exactly what it meant
 * when it was written. A document stored whole cannot be partially migrated by
 * a later schema change, cannot lose a rule to a cascade, and is read back with
 * one query rather than a join whose shape is itself versioned.
 *
 * The cost is that rules are not queryable in SQL. That is genuinely a cost —
 * "which plans pay a Gen 3 override" becomes a scan — and it is accepted
 * because it is a reporting question, and reporting can read the documents.
 *
 * ── Why money is a BIGINT of minor units ────────────────────────────────────
 *
 * NFR-003. DECIMAL would hold these figures correctly, but every derivation
 * would then round-trip through a float in JavaScript, and a prorated
 * allocation that drifts by a kobo no longer sums to the pool. The engine works
 * in integers throughout; the columns match it so nothing has to convert.
 */

const money = (pg) => (pg ? 'BIGINT' : 'BIGINT');
const id = (pg) => (pg ? 'BIGSERIAL PRIMARY KEY' : 'BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY');
const fk = (pg) => (pg ? 'INTEGER' : 'INT UNSIGNED');
const bigFk = (pg) => (pg ? 'BIGINT' : 'BIGINT UNSIGNED');
const ts = (pg) => (pg ? 'TIMESTAMP WITH TIME ZONE' : 'DATETIME');
const bool = (pg) => (pg ? 'BOOLEAN' : 'TINYINT(1)');
const suffix = (pg) => (pg ? '' : ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');

const TABLES = (pg) => [
  /**
   * A named commission structure. The plan is the identity people talk about
   * ("the 2026 realtor plan"); its versions are what actually pay.
   */
  ['commission_plans', `(
    id ${id(pg)},
    company_id ${fk(pg)} NULL,
    name VARCHAR(120) NOT NULL,
    description TEXT NULL,
    /* Exactly one default per company — the plan a deal falls back to. */
    is_default ${bool(pg)} NOT NULL DEFAULT ${pg ? 'FALSE' : '0'},
    /* Assignment scope (FR-CFG-004). NULL scope_type means company-wide. */
    scope_type VARCHAR(32) NULL,
    scope_id ${fk(pg)} NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'draft',
    created_by ${fk(pg)} NULL,
    created_at ${ts(pg)} NOT NULL,
    updated_at ${ts(pg)} NULL
  )`],

  /**
   * An immutable, effective-dated snapshot of a configuration.
   *
   * `config` is the whole plan as the engine consumes it. `engine_version`
   * records which build computed with it (NFR-009), so a figure can be
   * explained even after the engine's own behaviour has moved on.
   */
  ['commission_plan_versions', `(
    id ${id(pg)},
    plan_id ${bigFk(pg)} NOT NULL,
    company_id ${fk(pg)} NULL,
    version INTEGER NOT NULL,
    effective_from ${ts(pg)} NOT NULL,
    effective_to ${ts(pg)} NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'draft',
    config TEXT NOT NULL,
    engine_version VARCHAR(20) NULL,
    created_by ${fk(pg)} NULL,
    approved_by ${fk(pg)} NULL,
    approved_at ${ts(pg)} NULL,
    created_at ${ts(pg)} NOT NULL
  )`],

  /**
   * One realtor's claim on one deal under one rule.
   *
   * `gross_minor` is what the rules produced, `constrained_minor` what the pool
   * allowed, `released_minor` what has actually vested. Keeping all three is
   * what makes a payout explicable without re-running anything: the difference
   * between the first two is the constraint, between the second and third is
   * the vesting.
   *
   * `trace` and `eligibility_check` are the engine's own record (§5.8,
   * FR-ELG-011). A dispute is settled by reading them.
   */
  ['commission_entitlements', `(
    id ${id(pg)},
    company_id ${fk(pg)} NULL,
    deal_ref VARCHAR(64) NOT NULL,
    invoice_id ${fk(pg)} NULL,
    property_id ${fk(pg)} NULL,
    realtor_id ${fk(pg)} NOT NULL,
    plan_version_id ${bigFk(pg)} NULL,
    /**
     * Part of the uniqueness key below, so neither may be NULL.
     *
     * Both engines treat NULLs as DISTINCT inside a unique index, so a nullable
     * column in the key silently switches the guarantee off for exactly the
     * rows that use it — here, every direct-sale line, which has no generation.
     * A re-run would then insert a second one and the realtor is paid twice.
     * A generation of 0 means "not a generational line"; an empty rule_id means
     * the rule had no id of its own.
     */
    rule_id VARCHAR(120) NOT NULL DEFAULT '',
    rule_type VARCHAR(40) NULL,
    role VARCHAR(20) NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0,
    gross_minor ${money(pg)} NOT NULL DEFAULT 0,
    constrained_minor ${money(pg)} NOT NULL DEFAULT 0,
    released_minor ${money(pg)} NOT NULL DEFAULT 0,
    forfeited_minor ${money(pg)} NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'ACCRUED',
    attribution_date ${ts(pg)} NOT NULL,
    eligibility_check TEXT NULL,
    trace TEXT NULL,
    created_at ${ts(pg)} NOT NULL,
    updated_at ${ts(pg)} NULL
  )`],

  /**
   * The append-only ledger (NFR-004). Corrections are contra-entries; nothing
   * here is ever updated or deleted, which is why there is no updated_at.
   *
   * Wallet balances are DERIVED from this (FR-PAY-001) and never stored — a
   * balance column and a ledger inevitably disagree, and then neither can be
   * trusted.
   */
  ['commission_ledger_entries', `(
    id ${id(pg)},
    company_id ${fk(pg)} NULL,
    entitlement_id ${bigFk(pg)} NULL,
    realtor_id ${fk(pg)} NULL,
    deal_ref VARCHAR(64) NULL,
    /* ACCRUAL | RELEASE | FORFEIT | BREAKAGE | REVERSAL | ADJUSTMENT | PAYOUT */
    entry_type VARCHAR(20) NOT NULL,
    amount_minor ${money(pg)} NOT NULL,
    description VARCHAR(255) NULL,
    /* Makes a replayed event a no-op rather than a double posting. */
    idempotency_key VARCHAR(190) NOT NULL,
    metadata TEXT NULL,
    created_by ${fk(pg)} NULL,
    created_at ${ts(pg)} NOT NULL
  )`],
];

const INDEXES = [
  ['commission_plans', 'ix_commission_plans_company', ['company_id']],
  ['commission_plan_versions', 'ix_commission_versions_plan', ['plan_id', 'effective_from']],
  ['commission_entitlements', 'ix_commission_entitlements_deal', ['deal_ref']],
  ['commission_entitlements', 'ix_commission_entitlements_realtor', ['realtor_id', 'status']],
  ['commission_entitlements', 'ix_commission_entitlements_company', ['company_id', 'attribution_date']],
  ['commission_ledger_entries', 'ix_commission_ledger_realtor', ['realtor_id', 'entry_type']],
  ['commission_ledger_entries', 'ix_commission_ledger_deal', ['deal_ref']],
];

/**
 * The one uniqueness that carries weight.
 *
 * A calculation must be idempotent (FR-CLC-002, AC-010): re-running it for an
 * unchanged deal produces the same entitlements and no duplicate ledger rows.
 * That is enforced HERE rather than by the writer checking first, because a
 * check-then-insert is not atomic and the duplicate it admits is a realtor paid
 * twice.
 */
const UNIQUE = [
  ['commission_ledger_entries', 'ux_commission_ledger_idempotency', ['idempotency_key']],
  ['commission_entitlements', 'ux_commission_entitlement_line',
    ['deal_ref', 'realtor_id', 'rule_id', 'role', 'generation']],
];

const createIndex = async (sequelize, table, name, columns, unique) => {
  // Checked first, so the ordinary re-boot costs a lookup rather than a failed
  // statement — and caught anyway, because between the check and the create a
  // concurrent boot may have won the race.
  if (await indexExists(sequelize, table, name)) return;

  const cols = columns.map((column) => quoteIdent(sequelize, column)).join(', ');
  await sequelize.query(
    `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(sequelize, name)} `
    + `ON ${quoteIdent(sequelize, table)} (${cols})`,
  ).catch((error) => {
    if (!isDuplicateIndexError(error)) throw error;
  });
};

module.exports = async (sequelize) => {
  const pg = isPostgres(sequelize);

  for (const [table, definition] of TABLES(pg)) {
    // eslint-disable-next-line no-await-in-loop
    if (await tableExists(sequelize, table)) continue;
    // eslint-disable-next-line no-await-in-loop
    await sequelize.query(`CREATE TABLE ${quoteIdent(sequelize, table)} ${definition}${suffix(pg)}`);
  }

  for (const [table, name, columns] of INDEXES) {
    // eslint-disable-next-line no-await-in-loop
    await createIndex(sequelize, table, name, columns, false);
  }
  for (const [table, name, columns] of UNIQUE) {
    // eslint-disable-next-line no-await-in-loop
    await createIndex(sequelize, table, name, columns, true);
  }
};

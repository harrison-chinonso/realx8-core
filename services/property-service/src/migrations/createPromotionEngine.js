const {
  isPostgres, tableExists, quoteIdent, indexExists, isDuplicateIndexError, columnsOf,
} = require('../../../../shared/src/dialect');

/**
 * The promotions module's tables: campaigns, their immutable versions, and the
 * record of every redemption.
 *
 * shared/src/promotions/ is the arithmetic and knows nothing about a database.
 * This is where its answers are kept.
 *
 * ── Why a version is immutable, and why that is the whole design ────────────
 *
 * FRD 39 and 40. A buyer who purchased on 28 October under a 20% campaign keeps
 * 20% while they pay through November, even if an administrator edits the
 * campaign to 10% on 1 November and even after it expires. The only way to
 * guarantee that is for the configuration a purchase used to be a thing that
 * still exists, unchanged, years later.
 *
 * So editing a live promotion never rewrites its rules: it writes a NEW version
 * and points the promotion at it. Existing redemptions go on naming the version
 * they were calculated under. "What discount did this buyer get and why" is
 * then answerable from the data rather than from somebody's memory of what the
 * campaign used to say.
 *
 * ── Why the configuration is one JSON document ─────────────────────────────
 *
 * The same reasoning as the commission engine's plan versions, and for the same
 * reason it is defensible here: nothing ever updates a version in place, so the
 * usual argument for normalising — that rows are edited independently — does
 * not arise. The engine takes a promotion as one plain object, and a document
 * stored whole cannot be partially migrated by a later schema change or lose a
 * tier to a cascade.
 *
 * The queryable fields — status, dates, code, priority — are columns, because
 * those are what "which promotions might apply to this basket" filters on and
 * a scan of every JSON document per purchase would not do.
 *
 * ── Why money is a BIGINT of minor units ───────────────────────────────────
 *
 * Same as everywhere else in this codebase: the engine works in integers so a
 * discount allocated across lines still sums to the discount. DECIMAL would
 * hold the figures but every derivation would round-trip through a float.
 */

const money = () => 'BIGINT';
const id = (pg) => (pg ? 'BIGSERIAL PRIMARY KEY' : 'BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY');
const fk = (pg) => (pg ? 'INTEGER' : 'INT UNSIGNED');
const bigFk = (pg) => (pg ? 'BIGINT' : 'BIGINT UNSIGNED');
const ts = (pg) => (pg ? 'TIMESTAMP WITH TIME ZONE' : 'DATETIME');
const bool = (pg) => (pg ? 'BOOLEAN' : 'TINYINT(1)');
const suffix = (pg) => (pg ? '' : ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');

const TABLES = (pg) => [
  /**
   * The campaign as people talk about it — "the Independence promo". Its
   * versions are what actually calculate.
   */
  ['promotions', `(
    id ${id(pg)},
    company_id ${fk(pg)} NULL,
    name VARCHAR(160) NOT NULL,
    description TEXT NULL,
    /*
     * The reference an administrator quotes internally, and — for a code
     * promotion — what a buyer types. Unique per company, so two companies can
     * both run BLACKFRIDAY20 without seeing each other's.
     */
    code VARCHAR(60) NULL,
    /* AUTOMATIC or CODE. See shared/src/promotions/types.js. */
    trigger_type VARCHAR(20) NOT NULL DEFAULT 'AUTOMATIC',
    /* DRAFT | SCHEDULED | ACTIVE | PAUSED | EXPIRED | DEACTIVATED | ARCHIVED */
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    starts_at ${ts(pg)} NULL,
    ends_at ${ts(pg)} NULL,
    /*
     * Ascending — 1 is considered first. Administrators write priority lists
     * that way, and a screen that says "priority 1" meaning "last" is a support
     * ticket waiting to happen.
     */
    priority INTEGER NOT NULL DEFAULT 100,
    stackable ${bool(pg)} NOT NULL DEFAULT ${pg ? 'FALSE' : '0'},
    /* Which version a NEW purchase should be calculated under. */
    current_version_id ${bigFk(pg)} NULL,
    customer_message TEXT NULL,
    terms TEXT NULL,
    banner_url VARCHAR(1000) NULL,
    internal_notes TEXT NULL,
    created_by ${fk(pg)} NULL,
    created_at ${ts(pg)} NOT NULL,
    updated_at ${ts(pg)} NULL
  )`],

  /**
   * One immutable snapshot of a promotion's rules.
   *
   * `config` is the object shared/src/promotions/evaluate.js consumes, stored
   * whole. Nothing in this table is ever updated — that is what makes a
   * historical calculation reproducible.
   */
  ['promotion_versions', `(
    id ${id(pg)},
    promotion_id ${bigFk(pg)} NOT NULL,
    company_id ${fk(pg)} NULL,
    version INTEGER NOT NULL DEFAULT 1,
    /* The whole rule document — benefit, scope, tiers, eligibility, limits. */
    config TEXT NOT NULL,
    /*
     * What the engine looked like when this was written. A future change to the
     * arithmetic can then tell "calculated under the old engine" from
     * "calculated under this one" instead of silently re-deciding old money.
     */
    engine_version VARCHAR(20) NULL,
    /* Why this version exists, for the audit trail. */
    change_note TEXT NULL,
    created_by ${fk(pg)} NULL,
    created_at ${ts(pg)} NOT NULL
  )`],

  /**
   * Every time a promotion was actually given to somebody, with the calculation
   * frozen onto it.
   *
   * ── Why the numbers are copied here rather than recomputed ────────────────
   *
   * FRD 39. Recomputing would mean a historical purchase's discount depends on
   * today's configuration, today's prices and today's engine — so an admin
   * correcting a typo in a campaign would silently restate what a buyer owes on
   * an instalment plan they are halfway through. The figures are written once,
   * at purchase, and never derived again.
   */
  ['promotion_redemptions', `(
    id ${id(pg)},
    promotion_id ${bigFk(pg)} NOT NULL,
    promotion_version_id ${bigFk(pg)} NULL,
    company_id ${fk(pg)} NULL,
    /* Who received it, and what they were buying. */
    customer_id ${fk(pg)} NULL,
    realtor_id ${fk(pg)} NULL,
    property_id ${fk(pg)} NULL,
    invoice_id ${fk(pg)} NULL,
    purchase_request_id ${fk(pg)} NULL,
    /* The frozen calculation. */
    original_minor ${money()} NOT NULL DEFAULT 0,
    discount_minor ${money()} NOT NULL DEFAULT 0,
    payable_minor ${money()} NOT NULL DEFAULT 0,
    units_count INTEGER NOT NULL DEFAULT 0,
    /* The per-line allocation and the promotion's own name/terms at the time. */
    breakdown TEXT NULL,
    /*
     * A redemption is provisional until the purchase is real.
     *
     * An invoice raised and abandoned should not consume a campaign's 100
     * available redemptions — so a redemption is recorded against the invoice
     * and only counts toward limits once the purchase stands.
     */
    status VARCHAR(20) NOT NULL DEFAULT 'RESERVED',
    redeemed_at ${ts(pg)} NOT NULL,
    released_at ${ts(pg)} NULL,
    created_at ${ts(pg)} NOT NULL
  )`],
];

const INDEXES = [
  /* The lookup every purchase makes: this company's live campaigns. */
  ['promotions', 'ix_promotions_company_status', ['company_id', 'status']],
  ['promotions', 'ix_promotions_dates', ['starts_at', 'ends_at']],
  ['promotion_versions', 'ix_promotion_versions_promotion', ['promotion_id', 'version']],
  ['promotion_redemptions', 'ix_promotion_redemptions_promotion', ['promotion_id', 'status']],
  ['promotion_redemptions', 'ix_promotion_redemptions_customer', ['promotion_id', 'customer_id']],
  ['promotion_redemptions', 'ix_promotion_redemptions_invoice', ['invoice_id']],
];

const UNIQUE = [
  /*
   * A code is unique WITHIN a company, not globally. Two companies running
   * BLACKFRIDAY20 is normal; one company running two is a mistake that would
   * make which one applies an accident of row order.
   */
  ['promotions', 'ux_promotions_company_code', ['company_id', 'code']],
  ['promotion_versions', 'ux_promotion_versions_number', ['promotion_id', 'version']],
];

const createIndex = async (sequelize, table, name, columns, unique) => {
  // Checked first so an ordinary re-boot costs a lookup rather than a failed
  // statement — and caught anyway, because a concurrent boot may win the race.
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

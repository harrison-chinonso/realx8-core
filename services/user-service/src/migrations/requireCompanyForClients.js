const { QueryTypes } = require('sequelize');
const {
  isPostgres, constraintExists, addCheckConstraint, checksAreEnforced, quoteIdent,
} = require('../../../../shared/src/dialect');

/**
 * A client or realtor must belong to a company.
 *
 * ── The failure this prevents ───────────────────────────────────────────────
 *
 * Everything those two roles can see is company-scoped, and the scoping fails
 * CLOSED: an account attached to no company is shown nothing rather than
 * everything, which is the right way round. The consequence is that such an
 * account is not partially broken, it is entirely inert — the property
 * catalogue is empty, every property 404s, and because the purchase button
 * lives inside the property page it disappears with it.
 *
 * None of that reports itself as a configuration problem. It looks like a
 * company that has listed nothing, or like a broken purchase flow, and it cost
 * a real debugging session to trace one such account back to a null column.
 *
 * Registration already refuses to create one — a company referral code is
 * required and resolved to an id. This is the database saying the same thing,
 * so that the invariant survives a direct INSERT, a data import, a restored
 * backup, or a future code path that forgets.
 *
 * ── Why not simply NOT NULL ─────────────────────────────────────────────────
 *
 * Because a platform administrator legitimately has no company — they operate
 * across all of them — so the column has to stay nullable. The rule is
 * conditional on the user's type, which is what a CHECK constraint is for.
 *
 * ── Why only client and realtor ─────────────────────────────────────────────
 *
 * They are the roles the company-scoped catalogue serves, and the ones where a
 * null silently disables the account. The admin types are deliberately left
 * out: `superior_admin` MUST be able to have none, and existing admin rows
 * carry nulls whose correctness is a business question rather than something
 * to decide inside a migration that runs at boot.
 */
const CONSTRAINT = 'ck_users_company_required';
const SCOPED_TYPES = ['client', 'realtor'];

module.exports = async (sequelize) => {
  try {
    if (await constraintExists(sequelize, 'users', CONSTRAINT)) return;

    /**
     * Rows that would violate it, found BEFORE trying to add it.
     *
     * Adding a constraint that existing data fails is an error that aborts the
     * statement, and on a boot path that means the service does not start. So
     * the offenders are reported and the constraint is skipped — the same
     * direction taken by enforceReferenceUniqueness, and for the same reason:
     * which company an orphaned account belongs to is a question only a person
     * can answer, and guessing would attach someone to the wrong tenant.
     */
    const offenders = await sequelize.query(
      `SELECT id, email, type FROM users
        WHERE company_id IS NULL AND deleted_at IS NULL
          AND type IN (:types)
        LIMIT 10`,
      { replacements: { types: SCOPED_TYPES }, type: QueryTypes.SELECT },
    );

    if (offenders.length) {
      console.warn(
        `[users] NOT adding ${CONSTRAINT}: ${offenders.length} account(s) have no company.\n`
        + offenders.map((row) => `    #${row.id} ${row.email} (${row.type})`).join('\n')
        + '\n    Attach each to a company, then restart — the constraint will be added then.',
      );
      return;
    }

    /**
     * The expression, spelled for the engine.
     *
     * COALESCE rather than a bare comparison because a CHECK that evaluates to
     * UNKNOWN passes: a row with a NULL type would slip through `type NOT IN
     * (...)` untested. Postgres needs the ::text cast when `type` is an enum,
     * which it is there and is not in MySQL.
     */
    const typeExpr = isPostgres(sequelize)
      ? `COALESCE(${quoteIdent(sequelize, 'type')}::text, '')`
      : `COALESCE(${quoteIdent(sequelize, 'type')}, '')`;
    const list = SCOPED_TYPES.map((type) => `'${type}'`).join(', ');

    await addCheckConstraint(
      sequelize,
      'users',
      CONSTRAINT,
      `${quoteIdent(sequelize, 'company_id')} IS NOT NULL OR ${typeExpr} NOT IN (${list})`,
    );

    const enforced = await checksAreEnforced(sequelize);
    console.log(
      `[users] ${CONSTRAINT} added — a client or realtor must belong to a company.`
      + (enforced ? '' : '\n    WARNING: this MySQL parses CHECK constraints without enforcing them '
        + '(fixed in 8.0.16), so the rule is documentation here, not a guarantee.'),
    );
  } catch (error) {
    // A constraint is a safety net. Failing to add one must never be the reason
    // the application will not start.
    console.warn(`[users] could not add ${CONSTRAINT}: ${error.message}`);
  }
};

const { QueryTypes } = require('sequelize');
const { indexExists, addUniqueIndex, dropIndex, isPostgres, q } = require('../../../../shared/src/dialect');

/**
 * An email address identifies a person, not an account on this platform.
 *
 * ── What was wrong with global uniqueness ───────────────────────────────────
 *
 * `users.email` was UNIQUE across the whole table, so one address could exist
 * once on the entire platform. For staff that is right. For the two roles the
 * platform is actually for it is not: a realtor sells for more than one agency
 * and a buyer buys from more than one developer, and each of those
 * relationships is a real account with its own commissions, its own KYC, its
 * own invoices and its own realtor level. Under one global row they had to
 * share all of it, which is why a realtor wanting to work with a second company
 * was told their email was taken.
 *
 * So the constraint becomes per company: the same address may appear once in
 * each company, and never twice in the same one.
 *
 * ── The NULL that the index cannot see ──────────────────────────────────────
 *
 * Both engines treat NULLs as distinct in a unique index, so (email, NULL)
 * never collides with (email, NULL) — and company_id is NULL for exactly one
 * kind of account, the platform administrator. A composite index alone would
 * therefore let two platform admins share an address, which is the one place
 * global uniqueness genuinely mattered.
 *
 * A functional index over COALESCE(company_id, 0) would close it in the
 * database, and is deliberately not used: MySQL has only supported those since
 * 8.0.13 and this migration has to run on installations older than that. The
 * rule is enforced in the application instead — see shared/src/emailIdentity.js,
 * which also carries the wider rule this index cannot express at all: that only
 * realtors and clients may hold accounts in more than one company.
 *
 * The index is the floor, not the whole rule. It guarantees the thing that
 * actually corrupts data if it slips — two accounts with one address inside one
 * company — and it guarantees it against a direct INSERT, an import or a
 * restored backup, which is what a database constraint is for.
 *
 * ── google_id moves for the same reason ─────────────────────────────────────
 *
 * One Google account signing into two companies produces the same google_id on
 * both rows, so a globally unique google_id refuses the second one at the point
 * of sign-in. It becomes per company too. The NULL question does not arise the
 * same way there: most rows have no google_id at all, and NULLs staying
 * distinct is exactly what lets them coexist.
 */
const EMAIL_UNIQUE = 'users_email_company_unique';
const GOOGLE_UNIQUE = 'users_google_company_unique';
const GOOGLE_LOOKUP = 'idx_users_google_id';

/**
 * The global indexes to retire, by every name they have been created under.
 *
 * Sequelize names an inline `unique: true` after the column, a hand-written
 * migration names it whatever it likes, and this table has collected both. They
 * are listed rather than discovered because dropping an index by guessing at
 * its shape is how the wrong one goes.
 */
const SUPERSEDED = {
  email: ['email', 'users_email_unique', 'users_email_key'],
  /*
   * GOOGLE_LOOKUP is deliberately NOT named here, even though it has been a
   * unique index in the past and has to go when it is one.
   *
   * It is also the name this migration gives the plain lookup index it creates
   * at the end. Listing it meant every restart dropped that index and built it
   * again — churn on a table with every account in it, and a window with no
   * index on a column sign-in searches by.
   *
   * Discovery below finds it when it is UNIQUE, which is the only time it
   * needs dropping, and leaves it alone when it is the lookup index. The rule
   * is "drop single-column unique indexes on this column", and expressing it
   * that way is what makes the second run a no-op.
   */
  google_id: ['google_id', 'users_google_id_unique', 'users_google_id_key'],
};

/** Every unique index on this table that covers exactly one named column. */
const globalUniquesOn = async (sequelize, column) => {
  const rows = isPostgres(sequelize)
    ? await sequelize.query(
      `SELECT i.relname AS name
         FROM pg_index x
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_class t ON t.oid = x.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = CURRENT_SCHEMA() AND t.relname = 'users'
          AND x.indisunique AND x.indnatts = 1
          AND pg_get_indexdef(x.indexrelid) LIKE :pattern`,
      { replacements: { pattern: `%(${column})%` }, type: QueryTypes.SELECT },
    )
    : await sequelize.query(
      `SELECT index_name AS name FROM information_schema.statistics s
        WHERE s.table_schema = DATABASE() AND s.table_name = 'users'
          AND s.non_unique = 0 AND s.column_name = :column
          AND (SELECT COUNT(*) FROM information_schema.statistics c
                WHERE c.table_schema = s.table_schema AND c.table_name = s.table_name
                  AND c.index_name = s.index_name) = 1`,
      { replacements: { column }, type: QueryTypes.SELECT },
    );
  return rows.map((row) => row.name).filter((name) => name !== 'PRIMARY');
};

module.exports = async (sequelize) => {
  try {
    /**
     * The composite index goes on FIRST.
     *
     * Dropping the global one first would leave a window — however short, and
     * on a boot path it is the width of one CREATE INDEX — in which nothing at
     * all prevents two accounts sharing an address inside one company. Adding
     * first means the table is never less constrained than it was.
     */
    if (!(await indexExists(sequelize, 'users', EMAIL_UNIQUE))) {
      /*
       * Rows that would refuse it, found before trying. Under the global index
       * there cannot be any — but this also runs on databases restored from
       * elsewhere, and a failed CREATE on a boot path stops the service.
       */
      const clashes = await sequelize.query(
        `SELECT ${q(sequelize, 'email')}, company_id, COUNT(*) AS n FROM users
          GROUP BY ${q(sequelize, 'email')}, company_id HAVING COUNT(*) > 1 LIMIT 5`,
        { type: QueryTypes.SELECT },
      );
      if (clashes.length) {
        console.warn(
          `[users] NOT adding ${EMAIL_UNIQUE}: ${clashes.length} address(es) already appear `
          + 'twice inside one company.\n'
          + clashes.map((row) => `    ${row.email} in company ${row.company_id ?? 'platform'}`).join('\n')
          + '\n    Resolve the duplicates, then restart.',
        );
        return;
      }
      await addUniqueIndex(sequelize, 'users', ['email', 'company_id'], EMAIL_UNIQUE);
      console.log(`[users] ${EMAIL_UNIQUE} added — an address is now unique within a company.`);
    }

    if (!(await indexExists(sequelize, 'users', GOOGLE_UNIQUE))) {
      await addUniqueIndex(sequelize, 'users', ['google_id', 'company_id'], GOOGLE_UNIQUE);
      console.log(`[users] ${GOOGLE_UNIQUE} added.`);
    }

    /*
     * Now the global ones. Discovered as well as named: this table has carried
     * an inline `unique: true` and two hand-written migrations over its life,
     * and an index left behind here keeps the whole change inert — the second
     * account is still refused, by an index nobody remembered was there.
     */
    for (const [column, known] of Object.entries(SUPERSEDED)) {
      // eslint-disable-next-line no-await-in-loop
      const found = await globalUniquesOn(sequelize, column);
      const names = [...new Set([...known, ...found])]
        .filter((name) => name !== EMAIL_UNIQUE && name !== GOOGLE_UNIQUE);

      for (const name of names) {
        // eslint-disable-next-line no-await-in-loop
        if (!(await indexExists(sequelize, 'users', name))) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await dropIndex(sequelize, 'users', name);
          console.log(`[users] dropped global unique index ${name} on ${column}.`);
        } catch (error) {
          // A foreign key sometimes needs an index it did not create. Reported
          // rather than fatal — the composite one above is already in place.
          console.warn(`[users] could not drop ${name}: ${error.message}`);
        }
      }
    }

    /*
     * google_id still needs a plain lookup index — sign-in searches by it, and
     * the unique one it had was doing that job as a side effect.
     */
    if (!(await indexExists(sequelize, 'users', GOOGLE_LOOKUP))) {
      await sequelize.query(
        `CREATE INDEX ${q(sequelize, GOOGLE_LOOKUP)} ON ${q(sequelize, 'users')} (${q(sequelize, 'google_id')})`,
      );
    }
  } catch (error) {
    console.warn(`[users] could not rework the email uniqueness: ${error.message}`);
  }
};

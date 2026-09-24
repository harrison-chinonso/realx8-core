const { QueryTypes } = require('sequelize');
const { q } = require('./dialect');

/**
 * One email address, one person, several company accounts.
 *
 * ── The model, in a sentence ────────────────────────────────────────────────
 *
 * A person is identified by their email address. Each company they deal with
 * gives them a ROW in `users` — their own commissions there, their own KYC,
 * their own realtor level, their own invoices — and those rows together are
 * one identity because they share an address. Nothing about the per-company
 * account changed; what changed is that there may now be more than one.
 *
 * ── Only realtors and clients ───────────────────────────────────────────────
 *
 * They are the two roles that genuinely deal with more than one company: a
 * realtor sells for several agencies, a buyer buys from several developers.
 * Staff are not, and deliberately stay pinned to one company — an administrator
 * who could also administer a second tenant widens the blast radius of any
 * scoping bug from one buyer's data to a company's entire administration.
 *
 * The address is the boundary in both directions: if an address already belongs
 * to a staff account anywhere, no second account may be opened on it at all.
 * Otherwise a company could claim an administrator's address, and the shared
 * credential below would make that an entry into their account.
 *
 * ── A password per account, not per person ──────────────────────────────────
 *
 * Each company account carries its own password and they are free to differ.
 * Reusing one across all of them is expected and costs nothing; remembering a
 * separate one per company is allowed and costs a prompt. Neither is enforced,
 * which is the point — somebody opening an account with a second company two
 * years after the first should not be refused because they cannot recall what
 * they chose the first time.
 *
 * What keeps that from becoming "the weakest password opens everything" is not
 * here. It is the session: it records which accounts the password presented
 * actually opened, and moving to one outside that set asks for that company's
 * own password. See switchCompany in auth-service.
 *
 * So an account grants access to itself and to nothing else, and the rules
 * below are about IDENTITY — who may hold an account where — rather than about
 * credentials.
 */

/** The only two types that may hold accounts at more than one company. */
const MULTI_COMPANY_TYPES = ['realtor', 'client'];

const isMultiCompanyType = (type) => MULTI_COMPANY_TYPES.includes(String(type || '').toLowerCase());

/**
 * The form an address is compared in.
 *
 * Addresses are stored as typed, because that is how people write their own
 * name, but they are COMPARED case-insensitively and trimmed — otherwise
 * "Ada@Example.com" and "ada@example.com" are two identities, the second of
 * which cannot see the first's companies and cannot be told why.
 */
const normaliseEmail = (value) => String(value ?? '').trim().toLowerCase();

/**
 * Matches an address in whatever case it was stored.
 *
 * The column may be qualified — `u.email` — and each part is quoted
 * separately, because `companies` has an `email` column too and an unqualified
 * one in a joined query is not wrong-but-working, it is an outright
 * "Column 'email' in where clause is ambiguous".
 */
const emailMatch = (sequelize, column = 'email', param = ':email') => {
  const quoted = String(column).split('.').map((part) => q(sequelize, part)).join('.');
  return `LOWER(TRIM(${quoted})) = ${param}`;
};

const ACCOUNT_COLUMNS = 'id, name, email, password, phone, type, company_id, is_active, '
  + 'two_factor_enabled, google_id, realtor_id, realtor_level_id';

/**
 * Every live account on an address, oldest first.
 *
 * Oldest first because that is the order a person acquired them, which is the
 * order they expect to see them in — and because the first row is the one whose
 * password the identity was established with.
 */
const accountsForEmail = async (sequelize, email, { transaction = null } = {}) => {
  const value = normaliseEmail(email);
  if (!value) return [];
  return sequelize.query(
    `SELECT ${ACCOUNT_COLUMNS} FROM users
      WHERE deleted_at IS NULL AND ${emailMatch(sequelize)}
      ORDER BY id ASC`,
    { replacements: { email: value }, type: QueryTypes.SELECT, transaction },
  );
};

/**
 * Whether this address may be used for an account in this company.
 *
 * Returns `{ ok }` rather than throwing, and carries the message to show when
 * it is not — the callers are request handlers that each answer with their own
 * status code, and an exception would make every one of them write a catch
 * whose only job is to turn it back into a message.
 *
 * `joins` says the address already belongs to somebody: the new row is another
 * account for an existing person, so it must inherit their password rather than
 * being given one. See setIdentityPassword.
 */
const emailAvailability = async (sequelize, {
  email, companyId = null, type, excludeUserId = null, transaction = null,
} = {}) => {
  const value = normaliseEmail(email);
  if (!value) return { ok: false, message: 'An email address is required.' };

  const cid = companyId === null || companyId === undefined ? null : Number(companyId);

  /**
   * Is this address already spoken for in THIS company — by any row at all?
   *
   * Asked separately, and deliberately without the deleted_at filter the rest
   * of this module uses. The unique index has no such filter either: it is
   * (email, company_id) over every row in the table, soft-deleted included. So
   * a check that skipped removed accounts would answer "free", the INSERT
   * would then hit the index, and the caller would get a 500 where it had
   * asked a question with a perfectly good answer.
   *
   * The message says which case it is, because the two need different actions:
   * one is "you already have this", the other is "an administrator has to
   * restore it".
   */
  const sameSlot = await sequelize.query(
    `SELECT id, deleted_at FROM users
      WHERE ${emailMatch(sequelize)}
        AND company_id ${cid === null ? 'IS NULL' : '= :companyId'}
        ${excludeUserId ? 'AND id <> :excludeUserId' : ''}
      LIMIT 1`,
    {
      replacements: { email: value, companyId: cid, excludeUserId: excludeUserId ?? null },
      type: QueryTypes.SELECT,
      transaction,
    },
  );

  if (sameSlot.length) {
    return {
      ok: false,
      taken: true,
      message: sameSlot[0].deleted_at
        ? 'An account with this email existed in this company and was removed. '
          + 'Ask their administrator to restore it rather than creating a second one.'
        : 'An account with this email already exists in this company.',
    };
  }

  const existing = (await accountsForEmail(sequelize, value, { transaction }))
    .filter((row) => (excludeUserId ? Number(row.id) !== Number(excludeUserId) : true));

  if (!existing.length) return { ok: true, joins: false, accounts: [] };

  /*
   * The address is in use elsewhere, so this is a second account for the same
   * person — allowed only when BOTH sides are one of the two roles that deal
   * with more than one company. A staff account at either end stops it.
   */
  if (!isMultiCompanyType(type)) {
    return {
      ok: false,
      message: 'This email is already registered on the platform. Staff accounts belong '
        + 'to a single company, so a different address is needed for this one.',
    };
  }
  const blocker = existing.find((row) => !isMultiCompanyType(row.type));
  if (blocker) {
    return {
      ok: false,
      message: 'This email is already registered on the platform and cannot be reused.',
    };
  }

  return { ok: true, joins: true, accounts: existing };
};

/**
 * Set the password on specific accounts.
 *
 * Takes the ids it is to touch rather than an address, because a password now
 * belongs to one company account and the caller is the only thing that knows
 * which. A reset may name several; a change from inside an account names one.
 *
 * Callers pass a hash they have already produced — the cost factor is a policy
 * decision that belongs with the password rules rather than here.
 *
 * Returns how many rows it touched.
 */
const setAccountPassword = async (sequelize, accountIds, passwordHash, { transaction = null } = {}) => {
  const ids = (Array.isArray(accountIds) ? accountIds : [accountIds])
    .map(Number).filter(Number.isFinite);
  if (!ids.length || !passwordHash) return 0;
  const [, result] = await sequelize.query(
    `UPDATE users SET ${q(sequelize, 'password')} = :hash
      WHERE deleted_at IS NULL AND id IN (:ids)`,
    { replacements: { hash: passwordHash, ids }, type: QueryTypes.UPDATE, transaction },
  );
  // MySQL reports affected rows as a number, Postgres as a row count on the
  // result object. Neither is worth a caller's attention beyond "how many".
  return typeof result === 'number' ? result : (result?.rowCount ?? 0);
};

/**
 * The companies an account's owner can reach, as the UI wants to show them.
 *
 * Inactive accounts are included but flagged rather than hidden: "your account
 * at Acme is disabled" is an answer, and silently omitting the company leaves
 * somebody looking for a switcher entry that is not there.
 */
const companiesForEmail = async (sequelize, email, { transaction = null } = {}) => {
  const value = normaliseEmail(email);
  if (!value) return [];
  return sequelize.query(
    `SELECT u.id AS account_id, u.type, u.is_active, u.company_id,
            c.name AS company_name, c.status AS company_status
       FROM users u
       LEFT JOIN companies c ON c.id = u.company_id
      WHERE u.deleted_at IS NULL AND ${emailMatch(sequelize, 'u.email')}
      ORDER BY u.id ASC`,
    { replacements: { email: value }, type: QueryTypes.SELECT, transaction },
  );
};

module.exports = {
  MULTI_COMPANY_TYPES,
  isMultiCompanyType,
  normaliseEmail,
  emailMatch,
  accountsForEmail,
  emailAvailability,
  setAccountPassword,
  companiesForEmail,
};

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
 * ── One password, and why that is safe here ─────────────────────────────────
 *
 * The accounts share a credential: signing in proves you are the person, and
 * the person is the same at every company. The alternative — a password per
 * company — means the list of companies you are shown depends on which of your
 * passwords you happened to type, which is not a list anyone can reason about.
 *
 * That only holds while nobody but the person can set it. A company
 * administrator who could set a password for a user in their own company could
 * otherwise set the password that opens that person's account at a DIFFERENT
 * company, which is a cross-tenant account takeover with no attacker required —
 * just an ordinary admin feature pointed at a shared address. So administrators
 * no longer set passwords at all; they invite, and the person sets their own.
 *
 * Every write of `users.password` goes through setIdentityPassword below, so
 * the rows cannot drift apart into the per-company-password model by accident.
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

  const existing = (await accountsForEmail(sequelize, value, { transaction }))
    .filter((row) => (excludeUserId ? Number(row.id) !== Number(excludeUserId) : true));

  if (!existing.length) return { ok: true, joins: false, accounts: [] };

  const cid = companyId === null || companyId === undefined ? null : Number(companyId);
  const sameCompany = existing.some((row) => (
    cid === null ? row.company_id === null : Number(row.company_id) === cid
  ));
  if (sameCompany) {
    return { ok: false, message: 'An account with this email already exists in this company.' };
  }

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
 * Set the password for every account on this address.
 *
 * The single place `users.password` is written after an account exists. Callers
 * pass a hash they have already produced, because the cost factor is a policy
 * decision that belongs with the password rules rather than here.
 *
 * Returns how many rows it touched, which is how a caller can tell a person
 * with one company from a person with four without asking a second question.
 */
const setIdentityPassword = async (sequelize, email, passwordHash, { transaction = null } = {}) => {
  const value = normaliseEmail(email);
  if (!value || !passwordHash) return 0;
  const [, result] = await sequelize.query(
    `UPDATE users SET ${q(sequelize, 'password')} = :hash
      WHERE deleted_at IS NULL AND ${emailMatch(sequelize)}`,
    { replacements: { hash: passwordHash, email: value }, type: QueryTypes.UPDATE, transaction },
  );
  // MySQL reports affected rows as a number, Postgres as a row count on the
  // result object. Neither is worth a caller's attention beyond "how many".
  return typeof result === 'number' ? result : (result?.rowCount ?? 0);
};

/**
 * The password hash this identity already has, if any.
 *
 * A second account opened on an existing address does not get to choose a
 * password — the person already has one, and the whole point is that it opens
 * every company they belong to.
 */
const identityPasswordHash = async (sequelize, email, { transaction = null } = {}) => {
  const [row] = await accountsForEmail(sequelize, email, { transaction });
  return row?.password ?? null;
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
  setIdentityPassword,
  identityPasswordHash,
  companiesForEmail,
};

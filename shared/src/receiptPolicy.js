const { QueryTypes } = require('sequelize');
const { q } = require('./dialect');

/**
 * Whether a company requires its own receipt to be attached when a payment is
 * approved.
 *
 * ── Why it is a setting and not simply always on ────────────────────────────
 *
 * Making it compulsory for everybody would block every admin on every company
 * from approving anything the moment it shipped, including the ones who have no
 * receipt to attach because they do not issue one. So it is off by default and
 * a company that wants it switches it on — which also means the behaviour of a
 * company that has not been asked does not change at all.
 *
 * ── Why the check lives on the SERVER ───────────────────────────────────────
 *
 * The approval screen disables its own submit button when a receipt is missing,
 * which is the useful half — it stops the mistake before it is made. It is not
 * the enforcement. `POST /receipts/:id/verify` is an ordinary authenticated
 * endpoint, so a compulsory rule that only exists in the browser is a rule that
 * anybody who can reach the API can skip, and "compulsory" would be a
 * description of the UI rather than of the policy.
 *
 * ── Not retroactive, deliberately ───────────────────────────────────────────
 *
 * The rule is read at the moment of approval. Receipts already verified before
 * a company switched it on stay verified and are not reopened — the setting
 * governs what admins must do from now on, and treating it as a statement about
 * the past would mark a year of settled payments as deficient overnight.
 */

const SETTINGS_GROUP = 'payment';
const SETTING_KEY = 'require_company_receipt';

/** Off unless a company has explicitly turned it on. */
const DEFAULT_REQUIRED = false;

/**
 * Only an explicit affirmative counts.
 *
 * Blank means "inherit" by the convention the settings screen documents, and a
 * value nobody recognises must not be read as "on" — switching enforcement on
 * because somebody typed something unexpected into a text box would block
 * approvals for a reason no one could find.
 */
const parseToggle = (value) => {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === '') return null;
  if (['on', 'true', 'yes', '1', 'required'].includes(text)) return true;
  if (['off', 'false', 'no', '0', 'optional'].includes(text)) return false;
  return null;
};

/**
 * Does this company require a receipt on approval?
 *
 * Never throws. A settings lookup that fails falls back to NOT required — the
 * conservative direction here is to let the approval through, because the
 * alternative is that a database hiccup silently stops a company being able to
 * approve any payment at all.
 */
const requiresCompanyReceipt = async (sequelize, companyId) => {
  try {
    const rows = await sequelize.query(
      `SELECT ${q(sequelize, 'value')}, company_id FROM settings
        WHERE ${q(sequelize, 'group')} = :group AND ${q(sequelize, 'key')} = :key
          AND (company_id IS NULL ${companyId ? 'OR company_id = :companyId' : ''})`,
      {
        replacements: { group: SETTINGS_GROUP, key: SETTING_KEY, companyId: companyId ?? null },
        type: QueryTypes.SELECT,
      },
    );

    // A company's own row wins over the platform-wide one.
    const own = rows.find((row) => row.company_id != null);
    const global = rows.find((row) => row.company_id == null);
    const resolved = parseToggle(own?.value) ?? parseToggle(global?.value);
    return resolved ?? DEFAULT_REQUIRED;
  } catch (error) {
    console.error('[receipt-policy] lookup failed, treating as not required:', error.message);
    return DEFAULT_REQUIRED;
  }
};

module.exports = {
  requiresCompanyReceipt, parseToggle,
  SETTINGS_GROUP, SETTING_KEY, DEFAULT_REQUIRED,
};

const { companyByCode } = require('./companyLookup');

/**
 * Holding a sign-in to one company: the white-label app's company.
 *
 * Sign-in is otherwise across companies — an address finds every account a
 * person holds, and they choose. A company's own branded app must not do
 * that: somebody signing in to "Acme Homes" should land in Acme Homes or be
 * told they have no account there, never in a different agency's data under
 * Acme's logo.
 *
 * The app's web page sends its company code as `company_code` (Realx8-Ui reads
 * it from window.Realx8Native when the app is locked to one company). It is
 * not a security boundary — the person still proves who they are, and each of
 * their accounts is theirs — so a client simply omitting it gets the ordinary
 * cross-company sign-in. What it guarantees is that a locked app never OFFERS
 * another company.
 */

/**
 * @returns {Promise<{ company: { id, name, code } | null, invalid: boolean }>}
 *   company null and invalid false: nothing pinned.
 *   invalid true: a code was sent but names no live company.
 */
const resolvePin = async (sequelize, raw) => {
  const code = String(raw ?? '').trim();
  if (!code) return { company: null, invalid: false };
  const company = await companyByCode(sequelize, code);
  return company ? { company, invalid: false } : { company: null, invalid: true };
};

/** Whether an account belongs to the pinned company (always true when nothing is pinned). */
const withinPin = (pin, account) => !pin?.company || Number(account?.company_id) === Number(pin.company.id);

/** The refusal when the person has no account at the pinned company. */
const pinRefusal = (pin) => ({
  message: pin?.company
    ? `This app is for ${pin.company.name}, and you don't have an account there.`
    : "This app's company is no longer available. Please update the app or contact support.",
  reason: pin?.company ? 'company_pinned' : 'company_unavailable',
});

module.exports = { resolvePin, withinPin, pinRefusal };

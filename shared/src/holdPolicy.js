const { QueryTypes } = require('sequelize');
const { toMinor, asMinor, percentageOf } = require('./money');

/**
 * When an approved payment takes inventory off the market (FRD 10.2), and how
 * long an unpaid invoice lives (FRD 15.6).
 *
 * Resolved company value -> platform value -> built-in default, from the
 * `inventory` settings group, in the manner invoiceDueDays.js already
 * establishes. An unconfigured company gets ANY_PAYMENT and no expiry, which
 * are the FRD's stated defaults.
 */

const SETTINGS_GROUP = 'inventory';

const POLICIES = ['any_payment', 'threshold_amount', 'threshold_percentage'];

const KEYS = {
  policy: 'inventory_hold_policy',
  thresholdAmount: 'inventory_hold_threshold_amount',
  thresholdPercentage: 'inventory_hold_threshold_percentage',
  expiryDays: 'invoice_expiry_days',
};

/** FRD 10.2 default, and FRD 15.6 "off by default". */
const DEFAULTS = {
  policy: 'any_payment',
  thresholdAmount: 0,
  thresholdPercentage: 0,
  expiryDays: 0,
};

const readSettings = async (sequelize, companyId) => {
  const rows = await sequelize.query(
    `SELECT \`key\`, \`value\`, company_id FROM settings
      WHERE \`group\` = :group
        AND (company_id IS NULL ${companyId ? 'OR company_id = :companyId' : ''})`,
    {
      replacements: { group: SETTINGS_GROUP, companyId: companyId ?? null },
      type: QueryTypes.SELECT,
    },
  );
  // A company's own row wins over the platform-wide one.
  const global = {}; const company = {};
  rows.forEach((row) => { (row.company_id == null ? global : company)[row.key] = row.value; });
  return { ...global, ...company };
};

const positiveNumber = (value) => {
  const number = Number(String(value ?? '').trim());
  return Number.isFinite(number) && number > 0 ? number : null;
};

/**
 * The resolved hold policy for one company.
 *
 * Never throws: a settings lookup failure falls back to ANY_PAYMENT, which
 * holds stock EARLIER than any threshold would. Failing safe here means
 * over-securing inventory rather than overselling it.
 */
const holdPolicyFor = async (sequelize, companyId) => {
  let cfg = {};
  try {
    cfg = await readSettings(sequelize, companyId);
  } catch (error) {
    console.error('[hold-policy] lookup failed, using defaults:', error.message);
  }

  const raw = String(cfg[KEYS.policy] ?? '').trim().toLowerCase();
  const policy = POLICIES.includes(raw) ? raw : DEFAULTS.policy;

  const thresholdAmount = positiveNumber(cfg[KEYS.thresholdAmount]) ?? DEFAULTS.thresholdAmount;
  const rawPercentage = positiveNumber(cfg[KEYS.thresholdPercentage]) ?? DEFAULTS.thresholdPercentage;
  // A percentage over 100 could never be reached and would silently disable
  // holding altogether, so it is clamped rather than honoured.
  const thresholdPercentage = Math.min(rawPercentage, 100);

  return {
    policy,
    thresholdAmountMinor: toMinor(thresholdAmount),
    thresholdPercentage,
    /**
     * Has enough been paid to hold the invoiced quantity?
     *
     * `cumulativePaidMinor` is every APPROVED payment on the invoice, not just
     * the one being approved — a threshold is cumulative (FRD 10.2), so three
     * small payments that together clear it must trigger the hold.
     *
     * A threshold policy configured with no threshold value would hold on the
     * first kobo, which is ANY_PAYMENT by accident. Treated as unconfigured and
     * falls back to ANY_PAYMENT explicitly.
     */
    isMet: (cumulativePaidMinor, invoiceTotalMinor) => {
      const paid = asMinor(cumulativePaidMinor);
      if (paid <= 0) return false;
      if (policy === 'threshold_amount') {
        return thresholdAmount > 0 ? paid >= toMinor(thresholdAmount) : true;
      }
      if (policy === 'threshold_percentage') {
        if (thresholdPercentage <= 0) return true;
        return paid >= percentageOf(invoiceTotalMinor, thresholdPercentage);
      }
      return true; // any_payment
    },
  };
};

/**
 * Days before an unpaid invoice auto-expires, or null for never.
 *
 * Off unless a company sets it (FRD 15.6): long-lived unpaid invoices otherwise
 * accumulate and generate contention noise, but expiring them by default would
 * cancel invoices on companies that never asked for it.
 */
const invoiceExpiryDays = async (sequelize, companyId) => {
  try {
    const cfg = await readSettings(sequelize, companyId);
    const days = positiveNumber(cfg[KEYS.expiryDays]);
    return days && days <= 3650 ? Math.trunc(days) : null;
  } catch (error) {
    console.error('[hold-policy] expiry lookup failed, treating as off:', error.message);
    return null;
  }
};

module.exports = {
  SETTINGS_GROUP, POLICIES, KEYS, DEFAULTS,
  holdPolicyFor,
  invoiceExpiryDays,
};

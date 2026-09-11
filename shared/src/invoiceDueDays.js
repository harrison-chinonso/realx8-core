const { QueryTypes } = require('sequelize');
const { q } = require('../../shared/src/dialect');

/**
 * How long a purchase invoice has before it falls due, per payment mode.
 *
 * Was hardcoded at the checkout call site (30 days for installment, 14 for
 * outright). Companies settle on different terms, so the numbers now come from
 * the `invoicing` settings group, resolved company value → platform value →
 * the original built-in, so an unconfigured company behaves exactly as before.
 */

const SETTINGS_GROUP = 'invoicing';

/** The built-ins, kept identical to the values that were hardcoded. */
const DEFAULT_DUE_DAYS = { installment: 30, outright: 14 };

const KEY_FOR = {
  installment: 'invoice_due_days_installment',
  outright: 'invoice_due_days_outright',
};

/** 1–3650 days. Anything else (blank, zero, text, absurd) falls through. */
const parseDays = (value) => {
  const days = Number(String(value ?? '').trim());
  if (!Number.isFinite(days) || !Number.isInteger(days)) return null;
  if (days < 1 || days > 3650) return null;
  return days;
};

/**
 * Resolves the due-day count for one company and payment mode.
 * Never throws: a settings lookup failure falls back to the built-in.
 */
const invoiceDueDays = async (sequelize, companyId, paymentMode) => {
  const mode = String(paymentMode || '').toLowerCase() === 'installment' ? 'installment' : 'outright';
  const fallback = DEFAULT_DUE_DAYS[mode];

  try {
    const rows = await sequelize.query(
      `SELECT ${q(sequelize, 'value')}, company_id FROM settings
        WHERE ${q(sequelize, 'group')} = :group AND ${q(sequelize, 'key')} = :key
          AND (company_id IS NULL ${companyId ? 'OR company_id = :companyId' : ''})`,
      {
        replacements: { group: SETTINGS_GROUP, key: KEY_FOR[mode], companyId: companyId ?? null },
        type: QueryTypes.SELECT,
      },
    );

    // A company's own row wins over the platform-wide one.
    const own = rows.find((r) => r.company_id != null);
    const global = rows.find((r) => r.company_id == null);
    return parseDays(own?.value) ?? parseDays(global?.value) ?? fallback;
  } catch (error) {
    console.error('[invoice-due-days] lookup failed, using default:', error.message);
    return fallback;
  }
};

module.exports = { invoiceDueDays, DEFAULT_DUE_DAYS, SETTINGS_GROUP, KEY_FOR };

const { QueryTypes } = require('sequelize');
const { q } = require('./dialect');
const { asMinor } = require('./money');

/**
 * The least a realtor may ask to be paid at once.
 *
 * ── What it applies to, and what it deliberately does not ───────────────────
 *
 * AVAILABLE balance only — money that has vested and has not been paid. Not
 * accrued commission on a sale still being paid off, not money held pending a
 * reinstatement, and not lifetime earnings. The wallet already reports those
 * apart (see commissionStore.walletFor), and conflating them would refuse a
 * realtor who genuinely has the money while admitting one who does not.
 *
 * ── Why zero is the default, and why zero means off ─────────────────────────
 *
 * Every existing company has no row here, and a threshold that appeared from
 * nowhere would lock realtors out of money they can draw today. Zero is both
 * the default and the disabled state: there is no separate on/off flag to get
 * out of step with the number.
 *
 * ── Where it is NOT enforced ────────────────────────────────────────────────
 *
 * The administrator's payout run. `buildPayoutsFor` pays everybody what they
 * are owed whether or not they asked — a realtor should not have to chase to
 * be paid — and a threshold is a rule about ASKING, not about what is owed.
 * Applying it there would quietly withhold settled money from somebody who
 * never asked for anything, which is a different and worse policy than the one
 * being configured. Both doors are listed in the commission spec review; this
 * one is the realtor's.
 */

const SETTINGS_GROUP = 'commission';
const SETTINGS_KEY = 'min_payout_minor';

/** Off. Any company without a row behaves exactly as it did before this existed. */
const DEFAULT_THRESHOLD_MINOR = 0;

/**
 * Minor units, non-negative, integer. Anything else — blank, text, a negative,
 * a float — is treated as unset rather than guessed at.
 */
const parseThreshold = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 0) return null;
  return amount;
};

/**
 * Resolves the threshold for one company: its own row, else the platform's,
 * else off. Never throws — a settings failure must not stop a realtor being
 * paid, so it falls open.
 */
const payoutThresholdMinor = async (sequelize, companyId) => {
  try {
    const rows = await sequelize.query(
      `SELECT ${q(sequelize, 'value')}, company_id FROM settings
        WHERE ${q(sequelize, 'group')} = :group AND ${q(sequelize, 'key')} = :key
          AND (company_id IS NULL ${companyId ? 'OR company_id = :companyId' : ''})`,
      {
        replacements: { group: SETTINGS_GROUP, key: SETTINGS_KEY, companyId: companyId ?? null },
        type: QueryTypes.SELECT,
      },
    );
    const own = rows.find((row) => row.company_id != null);
    const platform = rows.find((row) => row.company_id == null);
    return parseThreshold(own?.value) ?? parseThreshold(platform?.value) ?? DEFAULT_THRESHOLD_MINOR;
  } catch (error) {
    console.error('[payout-threshold] lookup failed, treating as unset:', error.message);
    return DEFAULT_THRESHOLD_MINOR;
  }
};

/**
 * Whether this balance clears the threshold, and by how much it falls short.
 *
 * Returns the shortfall as well as the verdict because every caller needs
 * both: the API refuses with it, the screen prints it, and the notification
 * that fires when it reaches zero is the one telling the realtor they can now
 * be paid. Deriving it separately in three places is how they come to disagree.
 */
const thresholdStatus = (availableMinor, thresholdMinor) => {
  const available = asMinor(availableMinor);
  const threshold = asMinor(thresholdMinor);
  const shortfall = Math.max(threshold - available, 0);
  return {
    threshold_minor: threshold,
    available_minor: available,
    shortfall_minor: shortfall,
    // An unset threshold is always met, including for a realtor at zero — they
    // have nothing to request, and the request path refuses that on its own.
    met: threshold <= 0 || shortfall === 0,
    enforced: threshold > 0,
  };
};

module.exports = {
  payoutThresholdMinor,
  thresholdStatus,
  SETTINGS_GROUP,
  SETTINGS_KEY,
  DEFAULT_THRESHOLD_MINOR,
};

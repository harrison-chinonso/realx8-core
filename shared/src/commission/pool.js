const { asMinor, percentageOf } = require('../money');
const { POOL_MODE } = require('./vocabulary');
const { bandFor } = require('./base');

/**
 * The deal's commission pool: the most the company will pay out across every
 * earner on this deal (pipeline step 4).
 *
 * The pool is what makes §5.2's two-phase design work. Rates say what each
 * participant CLAIMS; the pool says what the deal can AFFORD. Keeping them
 * apart is what lets a company move from "8% maximum" to "flat ₦1,500,000
 * shared" without touching a single rate rule — the claims are unchanged, the
 * ceiling they are tested against is not.
 *
 * `UNCAPPED` returns null rather than Infinity. Infinity is a float, it
 * poisons any arithmetic it touches, and NFR-003 keeps floats out of this path;
 * null says "there is no ceiling" unambiguously and the constraint phase reads
 * it as "pay the claims as computed".
 */

/**
 * @param {object} config { mode, percentage, flat_amount_minor, bands[],
 *                          floor_minor, ceiling_minor }
 * @param {number} baseMinor  the commissionable base
 * @param {number} unitCount  units on the deal, for FLAT_PER_UNIT
 * @returns {{ amount_minor: number|null, trace: object }}
 */
const derivePool = (config = {}, baseMinor = 0, unitCount = 1) => {
  const base = asMinor(baseMinor);
  const units = Math.max(Math.trunc(Number(unitCount) || 1), 1);
  const mode = config.mode || POOL_MODE.UNCAPPED;

  switch (mode) {
    case POOL_MODE.PERCENTAGE: {
      const amount = percentageOf(base, config.percentage);
      return { amount_minor: amount, trace: { mode, percentage: config.percentage, base_minor: base } };
    }

    case POOL_MODE.FLAT: {
      /**
       * A fixed amount per DEAL, not per unit — the distinction FLAT_PER_UNIT
       * exists to make explicit. Conflating them is a four-fold error on a
       * four-plot sale, in whichever direction the company did not intend.
       */
      const amount = asMinor(config.flat_amount_minor);
      return { amount_minor: amount, trace: { mode, flat_amount_minor: amount } };
    }

    case POOL_MODE.FLAT_PER_UNIT: {
      const per = asMinor(config.flat_amount_minor);
      return { amount_minor: per * units, trace: { mode, per_unit_minor: per, unit_count: units } };
    }

    case POOL_MODE.TIERED: {
      /**
       * The pool percentage varies by price band — typically richer on cheaper
       * inventory, which is harder to sell, and thinner at the top where a
       * percentage of a large number is already a large number.
       */
      const band = bandFor(base, config.bands || []);
      if (!band) {
        // No band covers this base. Refusing to guess: falling back to the
        // nearest band would pay a rate nobody configured for this price, and
        // silently. The validator should have caught it; here it is an error.
        return {
          amount_minor: 0,
          trace: { mode, base_minor: base, band: null, error: 'no_band_matches_base' },
        };
      }
      const amount = percentageOf(base, band.value);
      return { amount_minor: amount, trace: { mode, base_minor: base, band, percentage: band.value } };
    }

    case POOL_MODE.HYBRID: {
      /**
       * A percentage, clamped. The floor stops a percentage of a very cheap
       * unit from being too small to be worth anyone's time; the ceiling stops
       * a percentage of a very expensive one from being more than the company
       * is willing to pay on any single deal.
       */
      const raw = percentageOf(base, config.percentage);
      const floor = config.floor_minor === null || config.floor_minor === undefined
        ? null : asMinor(config.floor_minor);
      const ceiling = config.ceiling_minor === null || config.ceiling_minor === undefined
        ? null : asMinor(config.ceiling_minor);

      let amount = raw;
      if (floor !== null) amount = Math.max(amount, floor);
      if (ceiling !== null) amount = Math.min(amount, ceiling);

      return {
        amount_minor: amount,
        trace: {
          mode,
          percentage: config.percentage,
          raw_minor: raw,
          floor_minor: floor,
          ceiling_minor: ceiling,
          clamped: amount !== raw,
        },
      };
    }

    case POOL_MODE.UNCAPPED:
    default:
      return { amount_minor: null, trace: { mode: POOL_MODE.UNCAPPED } };
  }
};

module.exports = { derivePool };

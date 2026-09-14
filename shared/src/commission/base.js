const { asMinor, percentageOf } = require('../money');
const { CB_MODE } = require('./vocabulary');

/**
 * The commissionable base: the number every percentage in the plan is applied
 * to (pipeline step 3).
 *
 * ── Why there is no cost or margin option here ──────────────────────────────
 *
 * §5.11 makes this a platform guardrail rather than a plan setting, and it is
 * enforced by this file having no branch for it. There is no `COMPANY_COST`
 * mode to configure, so no admin screen can offer one and no API payload can
 * ask for one — FR-PRP-004 is satisfied by the absence rather than by a check
 * somebody could remove.
 *
 * Three reasons it is worth enforcing structurally: a realtor can verify a
 * figure derived from the listing price and cannot verify one derived from
 * internal cost; the calculation trace surfaces its inputs to hundreds of
 * realtors, so a cost-derived base would leak cost data by construction; and a
 * profit-based rate would let an administrator shrink payouts by reclassifying
 * costs, without anything the realtor did having changed.
 *
 * Everything here is in MINOR units (kobo) and integer throughout — NFR-003.
 */

/**
 * @param {object} deal      { gross_price_minor, discount_minor, unit_count }
 * @param {object} config    { mode, excluded_components[], declared_amount_minor }
 * @param {object[]} components  the property's price components,
 *                               [{ code, amount_minor }] — legal fees, survey,
 *                               infrastructure levy, documentation.
 * @returns {{ amount_minor: number, trace: object }}
 */
const commissionableBase = (deal, config = {}, components = []) => {
  const gross = asMinor(deal?.gross_price_minor);
  const discount = asMinor(deal?.discount_minor);
  const mode = config.mode || CB_MODE.GROSS_PRICE;

  if (mode === CB_MODE.DECLARED_AMOUNT) {
    /**
     * A fixed amount the company has declared as commissionable for this
     * property — still price-derived in the sense that matters (§5.11): it is
     * a figure about the unit's sale, set openly on the property, not a
     * function of what the unit cost to build.
     *
     * Multiplied by unit count for the same reason the flat pool is: a declared
     * base is per unit, and a four-plot deal is four units' worth of sale.
     */
    const per = asMinor(config.declared_amount_minor);
    const units = Math.max(Math.trunc(Number(deal?.unit_count) || 1), 1);
    return {
      amount_minor: per * units,
      trace: { mode, declared_per_unit_minor: per, unit_count: units },
    };
  }

  if (mode === CB_MODE.NET_OF_DISCOUNT) {
    // Never below zero: a discount larger than the price is a data error, and
    // a negative base would invert every rate on the deal.
    const amount = Math.max(gross - discount, 0);
    return {
      amount_minor: amount,
      trace: { mode, gross_minor: gross, discount_minor: discount },
    };
  }

  if (mode === CB_MODE.NET_OF_COMPONENTS) {
    /**
     * Pass-through components come off the top: legal fees, survey,
     * infrastructure levy, documentation. The company collects them but they
     * are not the company's revenue on the sale, so paying commission on them
     * would pay a percentage of somebody else's invoice.
     *
     * Only the components the plan NAMES are removed. An unrecognised code in
     * the config removes nothing and is reported in the trace, because silently
     * ignoring it would overstate the base and nobody would see why.
     */
    const excluded = new Set((config.excluded_components || []).map(String));
    const present = new Map((components || []).map((c) => [String(c.code), asMinor(c.amount_minor)]));
    const removed = [];
    let deductions = 0;
    excluded.forEach((code) => {
      const amount = present.get(code);
      if (amount === undefined) { removed.push({ code, amount_minor: 0, missing: true }); return; }
      deductions += amount;
      removed.push({ code, amount_minor: amount });
    });
    const netOfDiscount = config.also_net_of_discount ? Math.max(gross - discount, 0) : gross;
    return {
      amount_minor: Math.max(netOfDiscount - deductions, 0),
      trace: {
        mode,
        gross_minor: gross,
        discount_minor: config.also_net_of_discount ? discount : 0,
        components_removed: removed,
        components_total_minor: deductions,
      },
    };
  }

  return { amount_minor: gross, trace: { mode: CB_MODE.GROSS_PRICE, gross_minor: gross } };
};

/**
 * A cancellation penalty, added to the base only where the plan says so.
 *
 * §5.11 says commission is payable on consideration for a SALE, and a penalty
 * is a charge for a sale that did not happen — so by default it is outside the
 * base. §10.3 then works an example in which commission IS computed on one.
 *
 * Both are defensible. A company whose realtors are expected to chase the
 * defaulting buyer and recover the penalty may reasonably pay them for it; a
 * company that treats the penalty as cost recovery may not. So it is a setting,
 * and whichever way it is set the trace says which — because a base that
 * silently included a penalty is a base nobody can reconcile to an invoice.
 */
const withPenalty = (base, deal = {}, penaltiesCommissionable = false) => {
  const penalty = asMinor(deal.penalty_minor);
  if (!penaltiesCommissionable || penalty <= 0) {
    return penalty > 0
      ? {
        ...base,
        trace: { ...base.trace, penalty_minor: penalty, penalty_commissionable: false },
      }
      : base;
  }
  return {
    amount_minor: base.amount_minor + penalty,
    trace: {
      ...base.trace,
      penalty_minor: penalty,
      penalty_commissionable: true,
      base_before_penalty_minor: base.amount_minor,
    },
  };
};

/**
 * The band a base falls into, for price-band tiering (FR-PRP-006, FR-CAP-001
 * `TIERED`).
 *
 * Bands are `{ up_to_minor, value }`, ordered ascending, with the final band
 * carrying a null ceiling. Lower bound is exclusive of the previous ceiling and
 * the ceiling is INCLUSIVE — a base of exactly 50,000,000 against a band
 * "up to 50,000,000" falls inside it, which is how a person reads "below 50M
 * pays 8%" when the price is 50M on the nose. Getting this backwards puts every
 * round-number deal — and they cluster hard on round numbers — in the wrong band.
 */
const bandFor = (amountMinor, bands = []) => {
  const amount = asMinor(amountMinor);
  const ordered = [...bands].sort((a, b) => {
    if (a.up_to_minor === null || a.up_to_minor === undefined) return 1;
    if (b.up_to_minor === null || b.up_to_minor === undefined) return -1;
    return asMinor(a.up_to_minor) - asMinor(b.up_to_minor);
  });
  return ordered.find((band) => band.up_to_minor === null
    || band.up_to_minor === undefined
    || amount <= asMinor(band.up_to_minor)) || null;
};

module.exports = { commissionableBase, withPenalty, bandFor, percentageOf };

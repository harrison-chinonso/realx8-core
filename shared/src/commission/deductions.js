const { asMinor, allocateByWeight } = require('../money');

/**
 * What comes off a commission before it reaches somebody (§7.11).
 *
 * ── Order is configurable because it changes the answer ─────────────────────
 *
 * Withholding tax on the gross and an admin fee on the gross give a different
 * net from tax on the gross and a fee on what is left. Both arrangements exist,
 * jurisdictions differ, and a system that fixed one would be wrong for half its
 * tenants — so each deduction states its `order` and whether it applies to the
 * GROSS or to the RUNNING balance.
 *
 * ── Why the advice is built here and not at the point of payment ────────────
 *
 * FR-PAY-003 requires the payout advice to show gross → deductions → net. That
 * is not a formatting concern: a realtor who cannot see why they received less
 * than they earned assumes an error, and support cannot answer without
 * recomputing. The breakdown is produced by the same function that produces the
 * net, so the two cannot disagree.
 */

const BASIS = {
  /** A percentage of the full commission, however much has been taken already. */
  GROSS: 'GROSS',
  /** A percentage of what is left at this point in the order. */
  RUNNING: 'RUNNING',
};

const TYPE = {
  PERCENTAGE: 'PERCENTAGE',
  FLAT: 'FLAT',
};

/**
 * Apply a deduction profile to one gross amount.
 *
 * @param {number} grossMinor
 * @param {object[]} deductions  [{ code, label, type, value, basis, order }]
 * @returns {{ gross_minor, net_minor, total_deducted_minor, lines[] }}
 */
const applyDeductions = (grossMinor, deductions = []) => {
  const gross = asMinor(grossMinor);
  const lines = [];

  const ordered = [...deductions]
    .filter((deduction) => deduction && deduction.is_active !== false)
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));

  let running = gross;

  ordered.forEach((deduction) => {
    const basis = deduction.basis === BASIS.RUNNING ? running : gross;
    const amount = deduction.type === TYPE.FLAT
      ? asMinor(deduction.value_minor ?? deduction.value)
      // Rounded UP: a statutory withholding that rounds down leaves the company
      // remitting less than it withheld, which is the side of the error that
      // gets noticed by a tax authority.
      : Math.ceil((basis * (Number(deduction.value) || 0)) / 100);

    /**
     * Never more than is left. A profile whose deductions exceed the commission
     * would otherwise produce a negative payout — a bill, not a payment — and
     * the realtor would be asked to fund their own earnings.
     */
    const taken = Math.max(Math.min(amount, running), 0);
    running -= taken;

    lines.push({
      code: deduction.code,
      label: deduction.label || deduction.code,
      type: deduction.type,
      value: deduction.value,
      basis: deduction.basis || BASIS.GROSS,
      applied_to_minor: basis,
      amount_minor: taken,
      capped: taken < amount,
    });
  });

  return {
    gross_minor: gross,
    net_minor: Math.max(running, 0),
    total_deducted_minor: gross - Math.max(running, 0),
    lines,
  };
};

/**
 * Where forfeited value goes (FR-ELG-007).
 *
 * Phase 1 retained everything as breakage. These are the other two dispositions,
 * and the choice is allowed to vary by WHY somebody stopped being active
 * (FR-ELG-008) — a compliance suspension that is later cleared should not cost
 * the same as a termination for cause.
 */
const DISPOSITION = {
  BREAKAGE: 'BREAKAGE',
  REDISTRIBUTE: 'REDISTRIBUTE',
  HOLD_PENDING_REINSTATEMENT: 'HOLD_PENDING_REINSTATEMENT',
};

/** The disposition for a given reason, falling back to the plan's default. */
const dispositionFor = (plan = {}, reason) => {
  const byReason = plan.forfeiture_by_reason || {};
  return byReason[reason] || plan.forfeiture_disposition || DISPOSITION.BREAKAGE;
};

/**
 * Share forfeited value among whoever is still standing.
 *
 * Weighted by what each of them was already allocated, so redistribution
 * preserves the plan's own proportions rather than inventing new ones — the
 * realtors left on the deal get more of it in the same ratio they were already
 * being paid.
 *
 * Returns an empty allocation when there is nobody left, and the caller retains
 * it as breakage. Redistributing to nobody is not a thing that can be done, and
 * silently dropping it would leave the pool unreconciled.
 */
const redistribute = (forfeitedMinor, recipients = []) => {
  const amount = asMinor(forfeitedMinor);
  const eligible = recipients.filter((r) => asMinor(r.constrained_minor) > 0);
  if (amount <= 0 || !eligible.length) {
    return { allocations: [], breakage_minor: amount };
  }

  const shares = allocateByWeight(amount, eligible.map((r) => asMinor(r.constrained_minor)));
  return {
    allocations: eligible.map((recipient, index) => ({
      entitlement_id: recipient.id ?? null,
      realtor_id: recipient.realtor_id,
      amount_minor: shares[index],
    })),
    breakage_minor: 0,
  };
};

/**
 * Whether a held entitlement is still inside its grace window (FR-ELG-009).
 *
 * `HOLD_PENDING_REINSTATEMENT` suspends rather than forfeits, and reactivation
 * inside the window resumes the ordinary schedule as if uninterrupted. Once the
 * window lapses the hold converts to the plan's default disposition — so the
 * answer to "is this still recoverable" has to be computable at any later
 * moment, from the date it was held.
 */
const withinGraceWindow = (plan = {}, heldAt, now = new Date()) => {
  const days = Number(plan.reinstatement_grace_days) || 0;
  if (days <= 0) return false;
  const from = new Date(heldAt);
  if (Number.isNaN(from.getTime())) return false;
  return now.getTime() - from.getTime() <= days * 24 * 60 * 60 * 1000;
};

module.exports = {
  BASIS, TYPE, DISPOSITION,
  applyDeductions, dispositionFor, redistribute, withinGraceWindow,
};

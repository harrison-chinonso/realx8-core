const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const { toMinor } = require('../../../../shared/src/money');
const {
  accrueForDeal, releaseForDeal, resolvePlanVersion, vestingConfigFor,
} = require('../../../../shared/src/commissionStore');

/**
 * Which commission system pays for a completed sale.
 *
 * ── The one rule that matters ───────────────────────────────────────────────
 *
 * Two systems can now compute commission on the same sale: the older
 * commissionService, which reads a flat rate out of `commission_rules` and
 * raises a single payable, and the engine, which resolves a plan version and
 * pays a whole participant set. If both run, everybody is paid twice, and the
 * error is discovered at payout — after the money.
 *
 * So exactly one runs, and the switch is whether the company has an ACTIVE PLAN
 * in force at the deal's attribution date. A company that has configured one is
 * saying it wants the engine; a company that has not keeps behaving exactly as
 * it did yesterday. Nothing has to be migrated, no flag has to be set, and a
 * company can be moved by configuring a plan and moved back by archiving it.
 *
 * The check is `resolvePlanVersion` — the same resolution the engine itself
 * uses. Asking a different question here ("does this company have any plan
 * row?") would let the two disagree about a plan whose effective period has
 * lapsed, and the disagreement pays somebody twice.
 */

/**
 * Everything the engine needs about a completed sale, from the invoice.
 *
 * The selling realtor is the one the BUYER is attributed to — the same
 * relationship the legacy generator uses, so switching a company between the
 * two never changes who earns, only how much and through what structure.
 */
const dealFromInvoice = async (invoice, totalMinor) => {
  const [buyer] = await sequelize.query(
    `SELECT u.id, u.realtor_id, u.company_id
       FROM users u WHERE u.id = :clientId AND u.deleted_at IS NULL LIMIT 1`,
    { replacements: { clientId: invoice.client_id }, type: QueryTypes.SELECT },
  );
  if (!buyer?.realtor_id) return null;

  return {
    /**
     * Stable, unique, and derived from the invoice rather than generated.
     *
     * It is the idempotency anchor: a replayed "paid in full" event has to
     * produce the same deal_ref or the unique index cannot recognise it as the
     * same deal, and the sale accrues twice.
     */
    deal_ref: `INV-${invoice.id}`,
    company_id: invoice.company_id ?? buyer.company_id ?? null,
    property_id: invoice.property_id ?? null,
    invoice_id: invoice.id,
    selling_realtor_id: buyer.realtor_id,
    referrer_id: null,
    gross_price_minor: totalMinor,
    discount_minor: toMinor(invoice.discount || 0),
    unit_count: 1,
    /**
     * The deal is attributed when the INVOICE was raised, not when it finished
     * being paid.
     *
     * §5.6: a deal resolves the plan in force at its attribution date. Using
     * the payment date instead would mean a plan change midway through a
     * twenty-four-month instalment silently repriced a sale agreed under the
     * old one — which is the exact restatement versioning exists to prevent.
     */
    attribution_date: invoice.created_at || invoice.createdAt || new Date(),
  };
};

/**
 * Accrue once, and release whatever has vested, for an approved payment.
 *
 * ── Why this runs on EVERY payment and not only the last one ────────────────
 *
 * Phase 1 had one release trigger, ON_FULL_PAYMENT, so there was nothing to do
 * until an invoice was settled and this was called only then. With PRO_RATA,
 * ON_THRESHOLD and ON_INITIAL_DEPOSIT a release can fall due on any instalment
 * — and on a twenty-four-month plan, "any instalment" is where nearly all of
 * them fall. Called only at the end, a pro-rata plan would accrue nothing for
 * two years and then release everything at once, which is the exact behaviour
 * pro-rata exists to avoid.
 *
 * So: accrue on the FIRST approved payment (idempotent, so later ones are
 * no-ops), and evaluate release on every one. The accrual is held back until
 * money has actually arrived because a commission recognised at purchase is a
 * payable for a sale that may never complete.
 *
 * Returns `{ handled: false }` when no plan is in force, which tells the caller
 * to fall back. Never throws: a commission failure must not undo a payment that
 * has already been approved and committed.
 */
const handlePayment = async ({
  invoice, totalMinor, receivedMinor = null, paidInFull = false,
}) => {
  try {
    const deal = await dealFromInvoice(invoice, totalMinor);
    if (!deal) return { handled: false, reason: 'no_attributed_realtor' };

    const planVersion = await resolvePlanVersion(sequelize, {
      companyId: deal.company_id,
      propertyId: deal.property_id,
      at: deal.attribution_date,
    });
    // No plan: this company is still on the flat-rate path.
    if (!planVersion || planVersion.unreadable) return { handled: false, reason: 'no_plan_in_force' };

    const accrual = await accrueForDeal(sequelize, deal);
    if (accrual.rejected) {
      /**
       * The plan's resolution strategy is REJECT and the claims breached the
       * pool. FR-CLC-007: quarantine and surface it rather than pay something
       * nobody configured. Reported as handled, so the legacy path does not
       * then pay instead.
       */
      console.warn(`[commission] ${deal.deal_ref} not accrued: ${accrual.rejected.reason}`);
      return { handled: true, rejected: accrual.rejected };
    }

    const release = await releaseForDeal(sequelize, {
      dealRef: deal.deal_ref,
      at: new Date(),
      reason: paidInFull ? 'invoice_paid_in_full' : 'payment_approved',
      /**
       * Cumulative receipts, not this instalment.
       *
       * The vesting functions return what SHOULD have vested in total and the
       * store releases the difference. Passing an increment here would make
       * every payment vest from zero again, and a pro-rata plan would release
       * the same first tranche on every instalment.
       */
      receivedMinor: receivedMinor ?? (paidInFull ? totalMinor : null),
      confirmed: true,
    });

    return {
      handled: true,
      deal_ref: deal.deal_ref,
      accrued: accrual.accrued,
      released: release.released,
      forfeited: release.forfeited,
      vested_minor: release.vested_minor,
      plan_version_id: planVersion.id,
    };
  } catch (error) {
    /**
     * Swallowed, loudly. The payment is already committed; failing here would
     * leave the caller unable to do anything useful about it, and re-running
     * the accrual later is safe because it is idempotent.
     */
    console.error(`[commission] engine failed for invoice ${invoice?.id}: ${error.message}`);
    return { handled: false, reason: 'engine_error', error: error.message };
  }
};

/**
 * Whether this company's plan waits for the invoice to be settled.
 *
 * The legacy flat-rate path raises its commission only when a sale completes,
 * and it must keep doing so — so the caller needs to know, on a partial
 * payment, whether "the engine did not handle this" means "fall back now" or
 * "there is nothing to raise yet".
 */
const releasesBeforeSettlement = async (invoice) => {
  const planVersion = await resolvePlanVersion(sequelize, {
    companyId: invoice?.company_id ?? null,
    propertyId: invoice?.property_id ?? null,
    at: invoice?.created_at || invoice?.createdAt || new Date(),
  });
  if (!planVersion || planVersion.unreadable) return false;
  const vesting = await vestingConfigFor(sequelize, planVersion.id);
  return vesting.release_trigger !== 'ON_FULL_PAYMENT';
};

/** Kept for callers that only ever ran at settlement. */
const handlePaidInFull = ({ invoice, totalMinor }) => handlePayment({
  invoice, totalMinor, receivedMinor: totalMinor, paidInFull: true,
});

module.exports = {
  handlePayment, handlePaidInFull, releasesBeforeSettlement, dealFromInvoice,
};

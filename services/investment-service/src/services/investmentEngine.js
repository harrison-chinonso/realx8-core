const { QueryTypes } = require('sequelize');
const { toMinor, toMajor, asMinor } = require('../../../../shared/src/money');
const { termsFrom, principalOf } = require('../../../../shared/src/investments/terms');
const {
  accruedAt, duePayoutMinor, releasableMinor, lastReleaseDate,
  maturityDate, hasMatured, nextPayoutDate,
} = require('../../../../shared/src/investments/accrual');
const { quoteExit } = require('../../../../shared/src/investments/exit');

/**
 * Where the pure engine meets the database.
 *
 * ── The division ────────────────────────────────────────────────────────────
 *
 * shared/src/investments does the arithmetic and knows nothing about rows. This
 * file does the rows and none of the arithmetic. Anything that computes an
 * amount belongs on the other side of that line, so that a figure an investor
 * disputes can be re-derived from stored terms without a database at all.
 *
 * ── Money crosses into finance, it does not live here twice ─────────────────
 *
 * An investor pays through an invoice, and is paid through a debit note. Both
 * belong to finance-service, and this writes to them directly for the same
 * reason property-service does: one database, and the subscription and its
 * invoice must commit together or not at all. Building a second money rail
 * inside this service would mean two ledgers that agree until somebody reverses
 * a payment on one of them.
 */

/** How much has actually been paid against an invoice, in minor units. */
const fundedAgainstInvoice = async (sequelize, invoiceId, transaction) => {
  if (!invoiceId) return { minor: 0, firstPaidAt: null };

  /*
   * Approved payments only. A submitted receipt is a claim until somebody has
   * looked at the proof — starting a tenor on an unverified claim would have a
   * return accruing against money that never arrived.
   */
  const [row] = await sequelize.query(
    `SELECT COALESCE(SUM(amount), 0) AS paid, MIN(created_at) AS first_paid_at
       FROM invoice_payments
      WHERE invoice_id = :invoiceId AND status = 'verified'`,
    { replacements: { invoiceId }, type: QueryTypes.SELECT, transaction },
  );

  return {
    minor: toMinor(Number(row?.paid) || 0),
    firstPaidAt: row?.first_paid_at || null,
  };
};

/** What an opportunity has already taken, so a cap can be enforced. */
const raisedSoFarMinor = async (sequelize, planId, transaction) => {
  const [row] = await sequelize.query(
    `SELECT COALESCE(SUM(principal_minor), 0) AS committed
       FROM investments
      WHERE plan_id = :planId AND status NOT IN ('cancelled')`,
    { replacements: { planId }, type: QueryTypes.SELECT, transaction },
  );
  return asMinor(Number(row?.committed) || 0);
};

/**
 * Whether an opportunity is open to new money right now.
 *
 * Three separate questions that a single `status` cannot answer: is it switched
 * on, is it inside its offer window, and is there headroom under the cap. A
 * would-be investor is told which one failed, because "unavailable" sends them
 * to support to find out something the screen already knows.
 */
const subscriptionWindow = async (sequelize, plan, { amountMinor = 0, asAt = new Date() } = {}, transaction) => {
  if (plan.status !== 'active') {
    return { open: false, reason: 'closed', message: 'This opportunity is not open for investment.' };
  }
  if (plan.opens_at && new Date(plan.opens_at) > asAt) {
    return {
      open: false,
      reason: 'not_yet_open',
      message: `This opportunity opens on ${new Date(plan.opens_at).toLocaleDateString()}.`,
    };
  }
  if (plan.closes_at && new Date(plan.closes_at) < asAt) {
    return { open: false, reason: 'closed', message: 'This opportunity has closed to new investment.' };
  }

  const cap = asMinor(plan.cap_minor);
  if (cap > 0) {
    const raised = await raisedSoFarMinor(sequelize, plan.id, transaction);
    const headroom = Math.max(cap - raised, 0);
    if (headroom <= 0) {
      return { open: false, reason: 'fully_subscribed', message: 'This opportunity is fully subscribed.' };
    }
    if (amountMinor > headroom) {
      return {
        open: false,
        reason: 'exceeds_cap',
        // The number, not just a refusal — they can subscribe for the headroom.
        message: `Only ${toMajor(headroom).toLocaleString()} is still available on this opportunity.`,
        headroom_minor: headroom,
      };
    }
    return { open: true, headroom_minor: headroom };
  }

  return { open: true, headroom_minor: null };
};

/**
 * Bring a subscription up to date with the money that has arrived.
 *
 * Called after a payment is approved, and again by the accrual run, because a
 * payment approved by somebody who never opens this service still has to start
 * the tenor. Reading the invoice rather than being told about it means the two
 * cannot disagree.
 */
const recordFunding = async (sequelize, investment, transaction) => {
  const { minor, firstPaidAt } = await fundedAgainstInvoice(sequelize, investment.invoice_id, transaction);
  if (minor <= 0) return { changed: false, funded_minor: 0 };

  const alreadyFunded = asMinor(investment.funded_minor);
  if (minor === alreadyFunded && investment.funded_at) return { changed: false, funded_minor: minor };

  const terms = investment.terms || {};
  // The tenor starts when the FIRST money landed, not when the last instalment
  // completed it — otherwise a buyer paying in three parts restarts the clock
  // twice and earns less than one who paid the same total on the same days.
  const fundedAt = investment.funded_at || firstPaidAt || new Date();

  await investment.update({
    funded_minor: minor,
    funded_at: fundedAt,
    amount: toMajor(minor),
    status: investment.status === 'pending' ? 'active' : investment.status,
    start_date: investment.start_date || fundedAt,
    end_date: investment.end_date || maturityDate(terms, fundedAt),
  }, { transaction });

  return { changed: true, funded_minor: minor, funded_at: fundedAt };
};

/**
 * What one investment is owed right now, and what it has been paid.
 *
 * The shape every screen and the scheduler both read, so a statement and a
 * payout can never quote different figures.
 */
const positionOf = (investment, asAt = new Date()) => {
  const terms = investment.terms || {};
  const principal = principalOf({ funded_minor: investment.funded_minor });
  const context = { principalMinor: principal, fundedAt: investment.funded_at, asAt };

  const accrued = accruedAt(terms, context);
  const paid = asMinor(investment.return_paid_minor);

  return {
    terms,
    principal_minor: principal,
    earned_minor: accrued.earned_minor,
    paid_minor: paid,
    /*
     * Two different questions, and conflating them pays a part-period early.
     *
     * `earned_minor` is what a STATEMENT shows — everything accrued to today,
     * because an investor should see what they have earned even before it is
     * payable. `releasable_minor` is what a PAYOUT may use: accrued only to the
     * last period that actually closed, because they were told monthly.
     */
    due_minor: duePayoutMinor(terms, context, paid),
    releasable_minor: releasableMinor(terms, { ...context }, paid),
    last_release_date: lastReleaseDate(terms, { fundedAt: investment.funded_at, asAt }),
    capital_paid_minor: asMinor(investment.capital_paid_minor),
    capital_outstanding_minor: Math.max(principal - asMinor(investment.capital_paid_minor), 0),
    matured: hasMatured(terms, investment.funded_at, asAt),
    maturity_date: maturityDate(terms, investment.funded_at),
    next_payout_date: nextPayoutDate(terms, { fundedAt: investment.funded_at, asAt }),
    days: accrued.days,
    basis: accrued.basis,
  };
};

/** A quotation for leaving early, or the reason it is refused. */
const exitQuoteFor = (investment, asAt = new Date()) => quoteExit(investment.terms || {}, {
  principalMinor: principalOf({ funded_minor: investment.funded_minor }),
  fundedAt: investment.funded_at,
  paidMinor: asMinor(investment.return_paid_minor),
  status: investment.status,
  asAt,
});

module.exports = {
  fundedAgainstInvoice,
  raisedSoFarMinor,
  subscriptionWindow,
  recordFunding,
  positionOf,
  exitQuoteFor,
  termsFrom,
};

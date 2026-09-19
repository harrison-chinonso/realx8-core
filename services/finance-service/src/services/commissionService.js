const { QueryTypes } = require('sequelize');
const { lastInsertId } = require('../../../../shared/src/dialect');
const { earningsFor } = require('../../../../shared/src/commissionEarnings');
const { sequelize, Commission, CommissionRule } = require('../models');
const { createNotifier } = require('../../../../shared/src/notifier');
const { levelRateOptIn } = require('../../../../shared/src/levelRate');
const { commissionLabel } = require('../../../../shared/src/commissionLabel');

const { findRealtorForClient } = createNotifier(sequelize);

/**
 * Commission generation and payout.
 *
 * Two halves that must not be confused:
 *
 *   GENERATION happens automatically when a sale completes. Nobody decides to
 *   create a commission; it is a consequence of the sale, so it is derived from
 *   the commission rules rather than typed in.
 *
 *   PAYOUT is a sequence of deliberate acts — the earner requests, an admin
 *   approves, an admin pays — and only the last one moves money, writing a
 *   DEBIT to the ledger against the CREDIT the sale itself wrote.
 *
 * No step here pays part of a commission. It is a single obligation for a
 * stated amount: paid in full or not at all.
 */

/** Money out. The counterpart to a purchase, which is money in. */
const DEBIT = 'debit';

/**
 * The rule that applies to a sale, most specific first.
 *
 * `any` is the catch-all on both axes, so a company that has configured one
 * blanket rule gets it, and one that has configured per-product rules gets the
 * closest match.
 */
const findRule = async ({
  companyId, productType, realtorCategory, realtorLevelId,
}, transaction = null) => {
  const rows = await sequelize.query(
    `SELECT * FROM commission_rules
      WHERE company_id ${companyId ? '= :companyId' : 'IS NULL'}
        AND product_type IN (:productType, 'any')
        AND (
          realtor_level_id = :realtorLevelId
          OR LOWER(realtor_category) = LOWER(:realtorCategory)
          OR LOWER(realtor_category) = 'any'
        )
      ORDER BY
        CASE WHEN product_type = :productType THEN 0 ELSE 1 END,
        /**
         * Most specific first: the level by id, then by name, then the
         * catch-all. Matching the id ahead of the name is what lets a rule
         * survive a level being renamed — the name comparison is kept only so
         * rules written before ids existed still apply.
         */
        CASE
          WHEN realtor_level_id = :realtorLevelId THEN 0
          WHEN LOWER(realtor_category) = LOWER(:realtorCategory) THEN 1
          ELSE 2
        END,
        id ASC
      LIMIT 1`,
    {
      replacements: {
        companyId: companyId ?? null,
        productType: productType || 'any',
        realtorCategory: realtorCategory || 'any',
        // -1 rather than NULL: a realtor with no level must not match a rule
        // whose level_id is also NULL, and NULL = NULL is never true anyway.
        realtorLevelId: realtorLevelId ?? -1,
      },
      type: QueryTypes.SELECT,
      transaction,
    },
  );
  return rows[0] || null;
};

/**
 * The realtor's level rate, as a rule — when the company has opted in.
 *
 * Synthesised rather than stored: writing a row into commission_rules for
 * every level would make the Commission Rules screen show rules nobody
 * created, and an administrator deleting one would silently turn the setting
 * off for that level alone. This keeps one switch and one source.
 *
 * Carries no id, so the commission it produces records `rule_id` as null and
 * says in its notes where the rate came from — which is the difference between
 * a figure that can be explained later and one that cannot.
 */
const levelRuleFor = async (companyId, realtor) => {
  const value = Number(realtor?.commission_percentage);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (!await levelRateOptIn(sequelize, companyId ?? null)) return null;
  return {
    id: null,
    type: 'percentage',
    value,
    description: `${realtor.level_name || 'Level'} rate (${value}%)`,
    from_level: true,
  };
};

/** What a rule is worth on a given sale amount. */
const amountFor = (rule, basisAmount) => {
  const basis = Number(basisAmount) || 0;
  const value = Number(rule.value) || 0;
  const amount = rule.type === 'percentage' ? (basis * value) / 100 : value;
  // Two places, matching the DECIMAL(12,2) it lands in. A commission is a
  // payable amount, not an intermediate figure, so it is rounded once here.
  return Math.round(amount * 100) / 100;
};

/**
 * Generates the commission for a completed sale, if one is owed.
 *
 * Called when an invoice becomes fully paid — the point at which the company
 * actually has the money, which is the defensible moment to owe commission on
 * it. Generating at purchase would create a payable for a sale that might never
 * complete.
 *
 * Returns the commission, or null with a reason. Never throws: a commission
 * that cannot be generated must not roll back the payment that triggered it.
 * The unique index on (invoice_id, employee_id) makes a replayed event a no-op
 * rather than a duplicate.
 */
const generateForSale = async ({ invoice, basisAmount }) => {
  try {
    if (!invoice?.id) return { created: null, reason: 'no_invoice' };

    // Who earned it: the realtor assigned to the buyer, resolved through the
    // same company-scoped rule the notifications use.
    const [client] = await sequelize.query(
      'SELECT id, name, email, company_id FROM users WHERE id = :id LIMIT 1',
      { replacements: { id: invoice.client_id }, type: QueryTypes.SELECT },
    );
    if (!client) return { created: null, reason: 'no_client' };

    const realtorId = await findRealtorForClient({
      email: client.email, companyId: invoice.company_id, userId: client.id,
    });
    if (!realtorId) return { created: null, reason: 'no_realtor' };

    // The realtor's level is what the rules key off; missing is 'any'.
    const [realtor] = await sequelize.query(
      `SELECT u.id, u.name, u.realtor_level_id, l.name AS level_name, l.commission_percentage
         FROM users u
         LEFT JOIN realtor_levels l ON l.id = u.realtor_level_id
        WHERE u.id = :id LIMIT 1`,
      { replacements: { id: realtorId }, type: QueryTypes.SELECT },
    );

    const [property] = invoice.property_id
      ? await sequelize.query(
        'SELECT id, name, type, city FROM properties WHERE id = :id LIMIT 1',
        { replacements: { id: invoice.property_id }, type: QueryTypes.SELECT },
      )
      : [null];

    const rule = await findRule({
      companyId: invoice.company_id,
      productType: property?.type,
      realtorCategory: (realtor?.level_name || '').toLowerCase(),
      realtorLevelId: realtor?.realtor_level_id ?? realtor?.level_id ?? null,
    })
      /**
       * Then, and only if the company has ASKED for it, the realtor's own
       * level rate.
       *
       * This is the rate shown on the Realtor Levels screen and on the
       * realtor's dashboard, and until now it decided nothing here — the two
       * tables could disagree in silence. Reconciling them by falling back
       * unconditionally would have been worse than the disagreement: every
       * company with no commission rules pays nothing today, and would have
       * begun paying a percentage of every completed sale without anyone
       * deciding to. So the fallback is an explicit per-company setting, off
       * for everybody until it is turned on, and a company that has neither
       * rules nor the setting still pays exactly nothing.
       */
      || await levelRuleFor(invoice.company_id, realtor);

    // No rule is a legitimate configuration, not a failure: a company that has
    // set none, and has not opted into its level rates, pays no commission.
    if (!rule) return { created: null, reason: 'no_rule' };

    const amount = amountFor(rule, basisAmount ?? invoice.amount);
    if (amount <= 0) return { created: null, reason: 'zero_amount' };

    const [commission, created] = await Commission.findOrCreate({
      where: { invoice_id: invoice.id, employee_id: realtorId },
      defaults: {
        employee_id: realtorId,
        /*
         * Who bought, and what — not the invoice number.
         *
         * It read "Commission — Favour City Epe", which named the estate and
         * not the sale: a realtor with four commissions on the same estate saw
         * four identical rows. The buyer is what tells them apart, and it is
         * how they would describe the sale themselves.
         */
        title: commissionLabel({
          clientName: client?.name,
          propertyName: property?.name,
          city: property?.city,
          fallback: `Invoice ${invoice.invoice_id}`,
          // The column is VARCHAR(255); this is a stored value rather than a
          // table cell, so it keeps more than a screen would show.
          max: 120,
        }),
        type: rule.type,
        amount,
        status: 'created',
        invoice_id: invoice.id,
        property_id: invoice.property_id ?? null,
        basis_amount: basisAmount ?? invoice.amount,
        rule_id: rule.id,
        // Where the rate came from, for a figure somebody has to explain a
        // year later. A rule has an id to point at; a level rate does not.
        notes: rule.from_level
          ? `Rate from the ${rule.description} — no commission rule matched, `
            + 'and this company has opted into paying its level rates.'
          : null,
        company_id: invoice.company_id ?? null,
      },
    });

    return { created: created ? commission : null, commission, reason: created ? null : 'already_exists' };
  } catch (error) {
    console.error('[commission] generation failed:', error.message);
    return { created: null, reason: error.message };
  }
};

/**
 * Records the payout of a commission, in full.
 *
 * ── It deliberately writes NO transaction ───────────────────────────────────
 *
 * It used to write a DEBIT to `transactions` here, in the same breath as the
 * status change. That put the ledger entry at the wrong moment: marking a
 * commission paid is an administrator recording that money went out, which is
 * not the same event as the money going out — and nothing had approved it.
 *
 * The money now leaves through a DEBIT NOTE: the admin raises one to credit the
 * realtor, somebody with `finance.notes.approve` signs it off, and SETTLING
 * that note writes the DEBIT (see noteApprovalController.settle). So the ledger
 * entry exists only where an approval stands behind it.
 *
 * Marking the commission paid stays as the bookkeeping step it always was —
 * closing the commission's own record once the note has been paid.
 */
const payOut = async ({ commission, paidBy }) => {
  await commission.update({
    status: 'paid',
    paid_at: new Date(),
    paid_by: paidBy ?? null,
  });
  return { amount: Number(commission.amount) || 0, transactionId: null };
};

/**
 * What one earner is owed, by status. Drives the realtor's own page.
 *
 * The per-status breakdown is the legacy table's, because those statuses are
 * the legacy table's vocabulary and the engine has its own. What is added is
 * the three TOTALS, which come from both systems — those are the figures a
 * person reads, and reading them from one table alone is what made a realtor
 * on the engine see zero.
 */
const summaryFor = async ({ employeeId, companyId }) => {
  const rows = await sequelize.query(
    `SELECT status, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
       FROM commissions
      WHERE employee_id = :employeeId
        ${companyId ? 'AND company_id = :companyId' : ''}
      GROUP BY status`,
    { replacements: { employeeId, companyId: companyId ?? null }, type: QueryTypes.SELECT },
  );
  const byStatus = rows.reduce((map, row) => ({
    ...map,
    [row.status]: { count: Number(row.count), total: Number(row.total) },
  }), {});
  const of = (status) => byStatus[status]?.total ?? 0;

  const earned = await earningsFor(sequelize, { realtorId: employeeId, companyId });

  return {
    by_status: byStatus,
    /*
     * What they could ask for right now, and what is already in flight.
     *
     * `requestable` is APPROVED, not `created`. Approval now precedes the
     * request — a commission sits in `created` until an administrator signs it
     * off — so counting `created` here would have told a realtor they could
     * ask for money the request handler was about to refuse, and would have
     * measured the payout threshold against a figure that is not yet askable.
     */
    requestable: of('approved'),
    awaiting_approval: of('created'),
    in_progress: of('payment_requested'),
    // Across BOTH systems, because this is the headline figure.
    paid: earned.paid,
    total: earned.total,
    unpaid: earned.unpaid,
    sources: earned.sources,
  };
};

module.exports = {
  generateForSale, payOut, summaryFor, findRule, amountFor, DEBIT,
};

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const { insertReturningId, q } = require('../../../../shared/src/dialect');
const { nextNumber } = require('../../../../shared/src/documentSequence');
const { toMajor, asMinor } = require('../../../../shared/src/money');

/**
 * Billing a realtor for verification or a level-up.
 *
 * ── An invoice, not a credit note (ACC-0.1) ────────────────────────────────
 *
 * This raised a `credit_note` and then asked the realtor to pay it. A credit
 * note is the instrument that REDUCES what somebody owes; a fee the realtor
 * must pay increases it, and the document for that is an invoice. The row
 * carried `payment_proof_url` and `payment_submitted_at`, which is a bill
 * wearing the wrong name — and the codebase had started to argue with itself
 * about which meaning was the real one.
 *
 * It is now a SERVICE-FEE invoice: the same charge, the same moment, the same
 * commit-or-nothing guarantee, on the document an accountant expects and in
 * the one receivables subledger the AR control reconciles against.
 *
 * Three things follow, and all three are improvements rather than costs:
 * the fee gains the ordinary proof-of-payment receipt flow with its approval
 * trail (ACC-0.3); it appears in the realtor's invoices beside everything
 * else they owe; and it posts Dr AR / Cr fee income like any other sale.
 *
 * ── Why this writes finance's table directly ───────────────────────────────
 *
 * For the reason invoiceGateway gives: one database, and the charge has to
 * commit with the request that caused it or not at all. A realtor whose
 * verification was submitted but whose fee was never raised is a realtor
 * nobody will ever chase, and the reverse — a fee for a request that failed to
 * save — is worse.
 *
 * ── Why the invoice is raised already issued ───────────────────────────────
 *
 * It opens at `sent` rather than `draft`. There is nothing to decide: the
 * company configured the price, the realtor asked for the thing, the charge
 * follows. What still needs a decision is the PAYMENT, and that decision is
 * the ordinary receipt approval every other invoice uses.
 *
 * ── Charging nothing is not charging ───────────────────────────────────────
 *
 * A fee of zero raises no invoice at all, rather than an invoice for nothing.
 * A company that has not set a price has not opted into charging, and a stack
 * of zero-value invoices would be work for somebody to clear.
 */

/** The company-wide verification price, in kobo. Zero when unset. */
const verificationFeeMinor = async (companyId) => {
  const [row] = await sequelize.query(
    // `group` and `key` are reserved words on both engines and quoted
    // differently by each — backticks here would have failed on Postgres.
    `SELECT ${q(sequelize, 'value')} FROM settings
      WHERE ${q(sequelize, 'group')} = 'realtor'
        AND ${q(sequelize, 'key')} = 'verification_fee_minor'
        AND (company_id = :companyId OR company_id IS NULL)
      ORDER BY (company_id IS NULL) ASC
      LIMIT 1`,
    { replacements: { companyId: companyId ?? null }, type: QueryTypes.SELECT },
  ).catch(() => [null]);
  return asMinor(Number(row?.value) || 0);
};

/** What this level costs to reach, in kobo. Zero when free or unknown. */
const levelUpFeeMinor = async (levelId) => {
  const [row] = await sequelize.query(
    'SELECT levelup_fee_minor FROM realtor_levels WHERE id = :levelId',
    { replacements: { levelId }, type: QueryTypes.SELECT },
  ).catch(() => [null]);
  return asMinor(Number(row?.levelup_fee_minor) || 0);
};

/**
 * Raise the charge. Returns the note, or null when there is nothing to charge.
 *
 * @param {object} args
 *   realtorId   who owes it
 *   companyId   whose money it is
 *   amountMinor how much, in kobo
 *   sourceType  'realtor_verification' | 'realtor_levelup'
 *   sourceId    the request this pays for
 *   reason      what the realtor will read on the note
 *   transaction the caller's transaction — the charge commits with the request
 */
const raiseRealtorCharge = async ({
  realtorId, companyId, amountMinor, sourceType, sourceId, reason, transaction = null,
}) => {
  const minor = asMinor(amountMinor);
  if (minor <= 0) return null;

  /*
   * One invoice per request. A realtor who resubmits a rejected verification
   * should not accumulate a second bill for the same thing, and the settle
   * path would then have two documents to close for one decision.
   */
  const [existing] = await sequelize.query(
    `SELECT id, invoice_id, amount, status FROM invoices
      WHERE source_type = :sourceType AND source_id = :sourceId
        AND ${q(sequelize, 'type')} = 'service_fee'
        AND status NOT IN ('cancelled', 'expired')
      ORDER BY id ASC LIMIT 1`,
    { replacements: { sourceType, sourceId }, type: QueryTypes.SELECT, transaction },
  ).catch(() => [null]);
  if (existing) return existing;

  /*
   * Its own series (ACC-0.2).
   *
   * A fee is not a property sale and should not consume a number from the
   * sales sequence — a developer reading INV-0412 expects a unit behind it.
   * Two series, both per company and both gap-aware, neither renumbered later:
   * the prefix is settled now precisely because it is permanent once issued.
   */
  const reference = await nextNumber(sequelize, {
    docType: 'service_fee_invoices', table: 'invoices', field: 'invoice_id',
    prefix: 'FEE-', companyId, transaction,
  });

  const id = await insertReturningId(
    sequelize,
    // No updated_at: the model declares `updatedAt: false` and the table has no
    // such column. The credit-note version of this carried the same note, having
    // been caught by it once — naming the column failed the insert and, because
    // the charge is best-effort, did so silently: the submission succeeded with
    // no bill behind it.
    `INSERT INTO invoices
       (invoice_id, ${q(sequelize, 'type')}, client_id, amount, status,
        source_type, source_id, company_id, created_at)
     VALUES (:reference, 'service_fee', :realtorId, :amount, 'sent',
        :sourceType, :sourceId, :companyId, NOW())`,
    {
      replacements: {
        reference,
        realtorId,
        amount: toMajor(minor),
        sourceType,
        sourceId,
        companyId: companyId ?? null,
      },
      transaction,
    },
  );

  return {
    id, invoice_id: reference, amount: toMajor(minor), status: 'sent', reason,
  };
};

module.exports = { raiseRealtorCharge, verificationFeeMinor, levelUpFeeMinor };

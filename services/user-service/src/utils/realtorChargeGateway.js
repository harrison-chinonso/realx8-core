const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const { insertReturningId, q } = require('../../../../shared/src/dialect');
const { nextNumber } = require('../../../../shared/src/documentSequence');
const { toMajor, asMinor } = require('../../../../shared/src/money');

/**
 * Billing a realtor for verification or a level-up.
 *
 * ── Why this writes finance's table directly ───────────────────────────────
 *
 * For the reason invoiceGateway gives: one database, and the charge has to
 * commit with the request that caused it or not at all. A realtor whose
 * verification was submitted but whose fee was never raised is a realtor
 * nobody will ever chase, and the reverse — a fee for a request that failed to
 * save — is worse.
 *
 * ── Why the note is raised approved ────────────────────────────────────────
 *
 * The other notes here start at pending_approval because a person has to
 * decide whether they are owed at all — an overpayment refund is a judgement.
 * This one is not: the company configured the price, the realtor asked for the
 * thing, the charge follows. What still needs a decision is the PAYMENT, and
 * that decision is the existing settle path.
 *
 * ── Charging nothing is not charging ───────────────────────────────────────
 *
 * A fee of zero raises no note at all, rather than a note for nothing. A
 * company that has not set a price has not opted into charging, and a stack of
 * zero-value notes would be work for somebody to clear.
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
   * One note per request. A realtor who resubmits a rejected verification
   * should not accumulate a second bill for the same thing, and the approval
   * path would then have two notes to settle for one decision.
   */
  const [existing] = await sequelize.query(
    `SELECT id, credit_note_id, amount, status FROM credit_notes
      WHERE source_type = :sourceType AND source_id = :sourceId
        AND status NOT IN ('cancelled', 'rejected')
      ORDER BY id ASC LIMIT 1`,
    { replacements: { sourceType, sourceId }, type: QueryTypes.SELECT, transaction },
  ).catch(() => [null]);
  if (existing) return existing;

  const reference = await nextNumber(sequelize, {
    docType: 'credit_notes', table: 'credit_notes', field: 'credit_note_id',
    prefix: 'CN', companyId, transaction,
  });

  const id = await insertReturningId(
    sequelize,
    // No updated_at: the model declares `updatedAt: false` and the table has
    // no such column. Writing one failed the insert and, because the charge is
    // best-effort, did so silently — the submission succeeded with no bill.
    `INSERT INTO credit_notes
       (credit_note_id, client_id, party_type, amount, status, reason,
        source_type, source_id, company_id, created_at)
     VALUES (:reference, :realtorId, 'realtor', :amount, 'approved', :reason,
        :sourceType, :sourceId, :companyId, NOW())`,
    {
      replacements: {
        reference,
        realtorId,
        amount: toMajor(minor),
        reason,
        sourceType,
        sourceId,
        companyId: companyId ?? null,
      },
      transaction,
    },
  );

  return { id, credit_note_id: reference, amount: toMajor(minor), status: 'approved' };
};

module.exports = { raiseRealtorCharge, verificationFeeMinor, levelUpFeeMinor };

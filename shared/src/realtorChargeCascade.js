const { QueryTypes } = require('sequelize');

/**
 * Approving the request that a paid fee was for.
 *
 * ── What problem this solves ────────────────────────────────────────────────
 *
 * A realtor asks to be verified, is billed for it, pays, and an administrator
 * approves the payment. At that point the fee has been collected for a thing
 * that has not happened: the verification is still sitting in the queue, and
 * somebody has to remember to go and approve it separately. Every time they
 * forget, the company has taken money for nothing — the worst failure this
 * feature can have, because the realtor has no way to tell it from being
 * ignored.
 *
 * So settling the note does both. The payment decision IS the request
 * decision, because the request was only ever waiting on the money.
 *
 * ── Why it lives in shared and writes with raw SQL ──────────────────────────
 *
 * `realtor_kyc` and `realtor_level_requests` belong to user-service, and the
 * caller is finance-service. This is the same line realtorVerification.js and
 * realtorLevel.js already cross, for the reasons stated there: one database,
 * and defining a model for another service's table would let a sync reshape
 * it. The write has to join the caller's transaction, so an HTTP hop between
 * two services in one process is not available even in principle — the fee
 * would be settled and the approval could still fail on its own.
 *
 * ── Pending only ────────────────────────────────────────────────────────────
 *
 * Every update is conditional on the request still being pending. An
 * administrator is allowed to approve a request before the fee is paid, which
 * is deliberate — a company that wants to verify somebody and chase the money
 * afterwards should not be blocked by its own billing. When the payment then
 * lands, this finds nothing to do and says so, rather than overwriting a
 * decision somebody already made or, worse, resurrecting one they refused.
 */

/** What each kind of charge unlocks. */
const SOURCES = {
  realtor_verification: 'verification',
  realtor_levelup: 'levelup',
};

/** Whether a note is a fee for something that can be approved by paying it. */
const isChargeNote = (note) => Boolean(note && SOURCES[note.source_type] && note.source_id);

/**
 * Approve the pending request this note paid for.
 *
 * Returns a descriptor the caller can notify from, or null when there was
 * nothing pending — a note for something else, or a request already decided.
 *
 *   { kind, requestId, userId, companyId, levelId, levelName }
 */
const approvePaidRequest = async (sequelize, {
  sourceType, sourceId, approverId = null, transaction = null,
} = {}) => {
  const kind = SOURCES[sourceType];
  if (!kind || !sourceId) return null;

  const stamp = {
    status: 'approved',
    reviewedBy: approverId ?? null,
    id: sourceId,
  };

  if (kind === 'verification') {
    const [row] = await sequelize.query(
      `SELECT id, user_id, company_id FROM realtor_kyc
        WHERE id = :id AND status = 'pending' LIMIT 1`,
      { replacements: { id: sourceId }, type: QueryTypes.SELECT, transaction },
    );
    if (!row) return null;

    await sequelize.query(
      `UPDATE realtor_kyc
          SET status = 'approved', reviewed_by = :reviewedBy, reviewed_at = NOW(),
              review_notes = 'Approved automatically when the verification fee was paid.'
        WHERE id = :id AND status = 'pending'`,
      { replacements: stamp, type: QueryTypes.UPDATE, transaction },
    );

    return {
      kind, requestId: row.id, userId: row.user_id, companyId: row.company_id ?? null,
    };
  }

  const [row] = await sequelize.query(
    `SELECT id, user_id, company_id, requested_level_id, requested_level_name
       FROM realtor_level_requests
      WHERE id = :id AND status = 'pending' LIMIT 1`,
    { replacements: { id: sourceId }, type: QueryTypes.SELECT, transaction },
  );
  if (!row) return null;

  await sequelize.query(
    `UPDATE realtor_level_requests
        SET status = 'approved', reviewed_by = :reviewedBy, reviewed_at = NOW(),
            review_notes = 'Approved automatically when the upgrade fee was paid.'
      WHERE id = :id AND status = 'pending'`,
    { replacements: stamp, type: QueryTypes.UPDATE, transaction },
  );

  /*
   * The level itself, not just the request row. reviewRequest does both in one
   * transaction for the same reason: a request that reads approved while the
   * realtor is still on their old level is a support ticket, and the realtor
   * is right to raise it.
   */
  await sequelize.query(
    'UPDATE users SET realtor_level_id = :levelId WHERE id = :userId',
    {
      replacements: { levelId: row.requested_level_id, userId: row.user_id },
      type: QueryTypes.UPDATE,
      transaction,
    },
  );

  return {
    kind,
    requestId: row.id,
    userId: row.user_id,
    companyId: row.company_id ?? null,
    levelId: row.requested_level_id,
    levelName: row.requested_level_name || null,
  };
};

module.exports = { approvePaidRequest, isChargeNote, SOURCES };

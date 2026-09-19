const { QueryTypes } = require('sequelize');
const { q, tableExists } = require('./dialect');

/**
 * The life of one introduction, written from three services.
 *
 * ── The ladder, and why it only climbs ──────────────────────────────────────
 *
 * A referral moves forward and never back. That is not a simplification — it
 * is what makes the record answer the question it exists for. A client who
 * reserves a unit and then lets the reservation lapse has still reached
 * `reserved`, and a funnel that quietly demoted them would report a realtor as
 * having introduced fewer serious buyers than they did. An ending is recorded
 * as an ENDING (`cancelled`, `disqualified`, `expired`) with a reason, which
 * leaves both facts on the row: how far it got, and how it stopped.
 *
 * The positions below are ranks, not ids. They are compared, never stored, so
 * inserting a rung between two of them costs nothing.
 *
 * ── Never throws, never blocks ──────────────────────────────────────────────
 *
 * Every call site here is in the middle of something that matters more than
 * this: a registration, a purchase, a commission. A referral row failing to
 * write must not fail any of them, so every function swallows its errors and
 * says so in the log. The journey is a report; the money is elsewhere.
 */

const STATUS = {
  INVITED: 'invited',
  REGISTERED: 'registered',
  INTERESTED: 'interested',
  RESERVED: 'reserved',
  TRANSACTION_CONFIRMED: 'transaction_confirmed',
  COMMISSION_GENERATED: 'commission_generated',
};

/** The endings. None of them has a rank — reaching one does not un-reach a rung. */
const ENDED = {
  CANCELLED: 'cancelled',
  DISQUALIFIED: 'disqualified',
  EXPIRED: 'expired',
};

const RANK = {
  [STATUS.INVITED]: 10,
  [STATUS.REGISTERED]: 20,
  [STATUS.INTERESTED]: 30,
  [STATUS.RESERVED]: 40,
  [STATUS.TRANSACTION_CONFIRMED]: 50,
  [STATUS.COMMISSION_GENERATED]: 60,
};

const rankOf = (status) => RANK[String(status || '').toLowerCase()] ?? 0;

/** The column that gets a timestamp when a given rung is reached, if any. */
const STAMP_FOR = {
  [STATUS.INVITED]: 'first_seen_at',
  [STATUS.REGISTERED]: 'registered_at',
  [STATUS.COMMISSION_GENERATED]: 'converted_at',
};

/**
 * Present for this deployment?
 *
 * Cached per process. The table arrives with this feature, and a service booted
 * against an older database must carry on working rather than log a failure on
 * every registration — the same accommodation realtorVerification makes.
 */
let tablePresent = null;
const present = async (sequelize) => {
  if (tablePresent === null) tablePresent = await tableExists(sequelize, 'referrals');
  return tablePresent;
};

/**
 * Record — or move along — the referral of one person by one realtor.
 *
 * Idempotent on (referrer, referred person): called twice with the same pair it
 * updates rather than duplicates, which is what makes it safe to call from a
 * sign-up that may be retried.
 */
const recordReferral = async (sequelize, {
  referrerId, referredUserId = null, companyId = null, propertyId = null,
  linkCode = null, source = null, status = STATUS.REGISTERED, at = new Date(),
}) => {
  if (!referrerId) return null;
  try {
    if (!await present(sequelize)) return null;

    const stamp = STAMP_FOR[status];
    const existing = referredUserId ? await sequelize.query(
      'SELECT id, status FROM referrals WHERE referrer_id = :referrerId AND referred_user_id = :referredUserId LIMIT 1',
      { replacements: { referrerId, referredUserId }, type: QueryTypes.SELECT },
    ) : [];

    if (existing.length) {
      const row = existing[0];
      // Forward only. A later call carrying an earlier rung leaves it alone.
      if (rankOf(status) <= rankOf(row.status)) return row.id;
      await sequelize.query(
        `UPDATE referrals
            SET ${q(sequelize, 'status')} = :status
                ${stamp ? `, ${stamp} = COALESCE(${stamp}, :at)` : ''}
                , updated_at = :at
          WHERE id = :id`,
        { replacements: { id: row.id, status, at }, type: QueryTypes.UPDATE },
      );
      return row.id;
    }

    await sequelize.query(
      `INSERT INTO referrals
         (referrer_id, referred_user_id, company_id, property_id, link_code, source,
          ${q(sequelize, 'status')}, first_seen_at, registered_at, created_at, updated_at)
       VALUES (:referrerId, :referredUserId, :companyId, :propertyId, :linkCode, :source,
               :status, :firstSeen, :registeredAt, :at, :at)`,
      {
        replacements: {
          referrerId,
          referredUserId,
          companyId,
          propertyId,
          linkCode,
          source,
          status,
          firstSeen: at,
          registeredAt: rankOf(status) >= rankOf(STATUS.REGISTERED) ? at : null,
          at,
        },
        type: QueryTypes.INSERT,
      },
    );
    return true;
  } catch (error) {
    console.error('[referral] could not record referral:', error.message);
    return null;
  }
};

/**
 * Move whatever referral introduced this person to a later rung.
 *
 * Takes the referred person rather than the pair, because every caller after
 * sign-up knows the buyer and should not have to work out who introduced them —
 * that is precisely the question this table answers.
 */
const advanceReferral = async (sequelize, { referredUserId, status, at = new Date(), reason = null }) => {
  if (!referredUserId || !status) return null;
  try {
    if (!await present(sequelize)) return null;
    const stamp = STAMP_FOR[status];
    const [result] = await sequelize.query(
      `UPDATE referrals
          SET ${q(sequelize, 'status')} = :status
              ${stamp ? `, ${stamp} = COALESCE(${stamp}, :at)` : ''}
              ${reason ? ', reason = :reason' : ''}
              , updated_at = :at
        WHERE referred_user_id = :referredUserId
          AND ${q(sequelize, 'status')} NOT IN (:ended)
          AND CASE ${Object.entries(RANK).map(([name, rank]) => `WHEN ${q(sequelize, 'status')} = '${name}' THEN ${rank}`).join(' ')}
                ELSE 0 END < :rank`,
      {
        replacements: {
          referredUserId, status, at, rank: rankOf(status),
          ended: Object.values(ENDED),
          ...(reason ? { reason } : {}),
        },
        type: QueryTypes.UPDATE,
      },
    );
    return result;
  } catch (error) {
    console.error('[referral] could not advance referral:', error.message);
    return null;
  }
};

/**
 * One realtor's funnel: how many introductions reached each rung.
 *
 * Counted by CURRENT status rather than cumulatively, so the numbers sum to the
 * total and a reader can see where people stop — which is the only thing a
 * funnel is for. A cumulative version ("40 reached registered") is derivable
 * from these and is not what a realtor asks.
 */
const funnelFor = async (sequelize, realtorId) => {
  try {
    if (!await present(sequelize)) return { total: 0, by_status: {} };
    const rows = await sequelize.query(
      `SELECT ${q(sequelize, 'status')} AS status, COUNT(*) AS count
         FROM referrals WHERE referrer_id = :realtorId
        GROUP BY ${q(sequelize, 'status')}`,
      { replacements: { realtorId }, type: QueryTypes.SELECT },
    );
    const by_status = Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
    return {
      total: rows.reduce((sum, row) => sum + Number(row.count), 0),
      by_status,
    };
  } catch (error) {
    console.error('[referral] could not read funnel:', error.message);
    return { total: 0, by_status: {} };
  }
};

module.exports = {
  STATUS, ENDED, RANK, rankOf, recordReferral, advanceReferral, funnelFor,
};

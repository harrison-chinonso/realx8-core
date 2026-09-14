const { QueryTypes } = require('sequelize');

/**
 * A realtor's standing over time, which is what the commission engine's
 * eligibility gate reads.
 *
 * ── Why a history and not just a column ─────────────────────────────────────
 *
 * The gate asks "was this realtor active at the instant this entitlement
 * accrued / this instalment released" — see shared/src/commission/eligibility.js
 * and FR-ELG-013. A current-status column answers a different question, about
 * today. Ask it at report time and a realtor who was suspended for a fortnight
 * and reinstated looks as though they were never suspended, so a forfeiture
 * recorded at the time becomes inexplicable; ask it after somebody is
 * terminated and every payment they ever legitimately received looks wrong.
 *
 * So every transition is appended, timestamped, and never updated. The column
 * on `users` is a cache of the latest row — convenient for a list screen,
 * never consulted for a historical question.
 *
 * ── Why this sits beside is_active rather than replacing it ─────────────────
 *
 * `users.is_active` is read in dozens of places that have nothing to do with
 * commission: sign-in, notification recipients, company counts. Collapsing the
 * two would mean auditing all of them for a feature that only needs to know
 * about realtors. Instead `realtor_status` is derived FROM the existing signals
 * on the way in — see `statusFromAccount` — so there is one place that decides
 * what a given account state means, and it cannot drift into a second opinion.
 */

const STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  SUSPENDED: 'suspended',
  TERMINATED: 'terminated',
};
const STATUSES = Object.values(STATUS);

/**
 * Why a realtor stopped being active (FR-ELG-008).
 *
 * Recorded because the forfeiture disposition is allowed to vary by it — a
 * compliance suspension and a termination for cause should not necessarily
 * cost somebody the same money. Phase 1 disposes of everything as breakage, so
 * nothing branches on this yet; it is captured now because a reason cannot be
 * reconstructed later, and an entitlement forfeited without one is a dispute
 * nobody can settle.
 */
const REASONS = [
  'resignation', 'termination_for_cause', 'suspension',
  'compliance_lapse', 'deceased', 'administrative', 'reinstatement',
];

/**
 * What an account's existing flags mean in these terms.
 *
 * The single place that interprets `is_active` and `deleted_at`, so the
 * migration that backfills history and the hooks that append to it cannot
 * disagree about what a row means.
 *
 * A deleted account is `terminated` rather than `inactive`: soft-deletion in
 * this application is how somebody is removed for good, and the two differ in
 * whether unreleased value is ever coming back.
 */
const statusFromAccount = ({ is_active: isActive, deleted_at: deletedAt } = {}) => {
  if (deletedAt) return STATUS.TERMINATED;
  return isActive ? STATUS.ACTIVE : STATUS.INACTIVE;
};

/**
 * The realtor's status as of an instant, read from the history.
 *
 * Returns null when the history begins after `at` — the account did not exist,
 * in any status, at that moment. The caller treats that as not eligible, which
 * is the safe direction.
 */
const statusAt = async (sequelize, userId, at, { transaction = null } = {}) => {
  const when = new Date(at);
  /**
   * An unparseable instant is "cannot place them", not "now".
   *
   * Defaulting to the current time would silently answer a different question
   * than the caller asked, and the caller is an eligibility gate — the wrong
   * answer either pays somebody who should have been refused or forfeits
   * somebody who should not.
   */
  if (Number.isNaN(when.getTime())) return { status: null, effective_from: null };

  const [row] = await sequelize.query(
    `SELECT status, effective_from FROM realtor_status_history
      WHERE user_id = :userId AND effective_from <= :at
      ORDER BY effective_from DESC, id DESC
      LIMIT 1`,
    { replacements: { userId, at: when }, type: QueryTypes.SELECT, transaction },
  );
  return row ? { status: row.status, effective_from: row.effective_from } : { status: null, effective_from: null };
};

/**
 * The whole history for a set of realtors, as the engine wants it.
 *
 * One query for the entire participant set rather than one per participant: a
 * deal with a seller, a referrer and eight generations of upline is ten
 * eligibility checks, and ten round trips would be most of NFR-001's budget
 * spent on a question with a tiny answer.
 */
const historyFor = async (sequelize, userIds) => {
  const ids = [...new Set((userIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return new Map();

  const rows = await sequelize.query(
    `SELECT user_id, status, effective_from FROM realtor_status_history
      WHERE user_id IN (:ids)
      ORDER BY effective_from ASC, id ASC`,
    { replacements: { ids }, type: QueryTypes.SELECT },
  );

  const byUser = new Map(ids.map((id) => [id, []]));
  rows.forEach((row) => {
    byUser.get(Number(row.user_id))?.push({
      status: row.status,
      effective_from: row.effective_from,
    });
  });
  return byUser;
};

/**
 * Append a transition, and refresh the cached column.
 *
 * Idempotent on purpose: re-recording the status somebody already holds appends
 * nothing. Without that, every save of a user form would add a row saying
 * "still active", and within a month the history a forfeiture has to be
 * explained from would be almost entirely noise.
 *
 * Best effort, and deliberately so — a status change must not fail because its
 * bookkeeping did. The cost of a missing row is a gate that reads an older
 * status, which fails CLOSED for a suspension (the realtor keeps earning until
 * the next write) and is corrected by the next transition.
 */
const recordStatus = async (sequelize, {
  userId, status, reason = null, actorId = null, at = new Date(), note = null,
  transaction = null,
}) => {
  if (!userId || !STATUSES.includes(status)) return false;

  try {
    /**
     * Joined to the caller's transaction when there is one.
     *
     * Two reasons, and the second is the one that bites. A separate connection
     * cannot SEE the uncommitted row it is being asked about, so the
     * "has this changed?" check below would compare against a stale answer and
     * append a duplicate. And on MySQL a second connection writing to a row the
     * open transaction holds a lock on simply waits — which, called from a
     * model hook inside that transaction, is a deadlock against itself.
     */
    const current = await statusAt(sequelize, userId, at, { transaction });
    if (current.status === status) return false;

    await sequelize.query(
      `INSERT INTO realtor_status_history
         (user_id, status, reason, note, changed_by, effective_from, created_at)
       VALUES (:userId, :status, :reason, :note, :actorId, :at, NOW())`,
      {
        replacements: {
          userId, status, reason, note, actorId, at: new Date(at),
        },
        type: QueryTypes.INSERT,
        transaction,
      },
    );

    // The cache on `users`. Never read for a historical question.
    await sequelize.query(
      'UPDATE users SET realtor_status = :status WHERE id = :userId',
      { replacements: { status, userId }, type: QueryTypes.UPDATE, transaction },
    );
    return true;
  } catch (error) {
    console.error(`[realtor-status] could not record ${status} for user ${userId}: ${error.message}`);
    return false;
  }
};

/** Convenience: interpret an account row and record whatever it now means. */
const syncStatusFromAccount = (sequelize, account, options = {}) => recordStatus(sequelize, {
  userId: account?.id,
  status: statusFromAccount(account),
  ...options,
});

/**
 * Keeps the history in step with the account, from the model itself.
 *
 * ── Why hooks rather than calls at the places that change a user ────────────
 *
 * There are five places that create a user and several that deactivate one,
 * across three services. A history maintained by remembering to call something
 * at each of them is complete on the day it is written: the next endpoint that
 * suspends somebody simply does not append, and the symptom is not an error —
 * it is a realtor who goes on earning after being suspended, discovered at
 * payout. The model is the one thing every path goes through.
 *
 * ── Why this is installed rather than written into one model ────────────────
 *
 * `users` is described by TWO Sequelize models: user-service owns the table,
 * and auth-service defines its own over the same rows for sign-in and
 * registration. Hooks on one do not fire for the other, so a realtor who
 * self-registers would get no history while one created by an admin would.
 * Installing from here means both call the same function and cannot drift.
 *
 * ── What it deliberately does not do ────────────────────────────────────────
 *
 * It never fails an operation. Creating a user must not be refused because its
 * bookkeeping could not be written — recordStatus swallows, and the cost of a
 * missing row is a gate that reads an older status, which errs toward paying
 * rather than toward forfeiting.
 */
const FIELDS_THAT_MATTER = ['is_active', 'deleted_at', 'type'];

const installStatusHooks = (User) => {
  const { sequelize } = User;

  /**
   * A new realtor starts with a row, dated to their creation.
   *
   * Without this the gate — which refuses anybody it cannot place — would
   * silently forfeit every entitlement belonging to any realtor created after
   * the backfill migration ran. The backfill seeds the realtors who existed
   * then; this is what covers everybody since.
   */
  User.addHook('afterCreate', 'realtorStatusOnCreate', async (user, options) => {
    if (user?.type !== 'realtor') return;
    await recordStatus(sequelize, {
      userId: user.id,
      status: statusFromAccount(user),
      reason: options?.statusReason || 'administrative',
      at: user.created_at || user.createdAt || new Date(),
      note: options?.statusNote || 'Account created.',
      transaction: options?.transaction ?? null,
    });
  });

  User.addHook('afterUpdate', 'realtorStatusOnUpdate', async (user, options) => {
    /**
     * Only when something that BEARS on standing moved.
     *
     * `changed()` is Sequelize's own record of which attributes this save
     * touched. Recording on every update would mean a name change appended a
     * transition — and recordStatus would discard it as unchanged, but only
     * after two queries per save of any user form.
     */
    const changed = user.changed() || [];
    if (!FIELDS_THAT_MATTER.some((field) => changed.includes(field))) return;

    /**
     * Someone who is a realtor now, or was one a moment ago.
     *
     * A client promoted to realtor needs their first row; a realtor whose type
     * is changed away needs the transition recorded rather than dropped,
     * because entitlements already accrued still refer to them.
     */
    const wasRealtor = user.previous('type') === 'realtor';
    if (user.type !== 'realtor' && !wasRealtor) return;

    /**
     * The reason travels with the save.
     *
     * A hook can see WHAT changed and never WHY. An endpoint that knows —
     * "suspended for a compliance lapse" rather than "is_active became false" —
     * passes it through the update's own options, and it lands on the same row
     * the hook is already writing:
     *
     *     user.update({ is_active: false }, { statusReason: 'suspension' })
     *
     * Recording it afterwards instead would not work: the hook has already
     * appended the transition, and recordStatus discards a second call for a
     * status that has not changed — so the reason would be silently dropped,
     * which is exactly the kind of quiet loss FR-ELG-008 exists to prevent.
     */
    await recordStatus(sequelize, {
      userId: user.id,
      status: statusFromAccount(user),
      reason: options?.statusReason || null,
      note: options?.statusNote || null,
      actorId: options?.statusActorId ?? null,
      at: new Date(),
      transaction: options?.transaction ?? null,
    });
  });
};

module.exports = {
  STATUS, STATUSES, REASONS, FIELDS_THAT_MATTER,
  statusFromAccount, statusAt, historyFor, recordStatus, syncStatusFromAccount,
  installStatusHooks,
};
